import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { Runtime } from "./application/runtime.js";
import { AppError, errorCode } from "./domain/types.js";
import { canonicalPhone, statusText } from "./domain/policies.js";
import { parseWebhook, verifyHmac } from "./infrastructure/webhook.js";
import { QUEUES } from "./infrastructure/queue.js";
const uuid = z.uuid();
const reason = z.string().trim().min(3).max(500);
const number = z.coerce.number().int().positive();
const paramsNumber = z.object({ number });
function authorized(req: FastifyRequest, c: Config): boolean {
  const input = req.headers["x-admin-token"];
  if (typeof input !== "string") return false;
  const a = Buffer.from(input),
    b = Buffer.from(c.HAIM_ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function makeHttp(
  c: Config,
  runtime: Runtime,
  simulation: Runtime | null,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 262144,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    genReqId: () => randomUUID(),
    trustProxy: false,
  });
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });
  app.setErrorHandler((e, req, reply) => {
    const status =
      e instanceof AppError
        ? e.status
        : e instanceof ZodError
          ? 400
          : typeof e === "object" &&
              e !== null &&
              "statusCode" in e &&
              typeof e.statusCode === "number"
            ? e.statusCode
            : 500;
    if (status >= 500)
      runtime.log.error({
        trace_id: req.id,
        code: errorCode(e),
        stage: "http",
      });
    void reply
      .code(status)
      .send({
        ok: false,
        error: {
          code:
            e instanceof AppError
              ? e.code
              : status === 400
                ? "invalid_input"
                : status === 413
                  ? "payload_too_large"
                  : "internal_error",
          message: e instanceof AppError ? e.publicMessage : "הבקשה לא הושלמה.",
          trace_id: req.id,
        },
      });
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
  });
  app.get("/health", async () => ({
    ok: true,
    version: "0.5.0",
    mode: c.BOT_MODE,
  }));
  app.get("/ready", async () => {
    await runtime.check();
    return {
      ok: true,
      version: "0.5.0",
      mode: c.BOT_MODE,
      schema: c.DB_SCHEMA,
      simulation_ready: simulation?.ready ?? false,
    };
  });
  app.post(
    "/webhooks/waha",
    { config: { rawBody: true } },
    async (req, reply) => {
      if (
        !Buffer.isBuffer(req.rawBody) ||
        !verifyHmac(
          req.rawBody,
          c.WAHA_WEBHOOK_HMAC_KEY,
          req.headers["x-webhook-hmac"],
        )
      )
        throw new AppError("invalid_webhook_signature", 401);
      const parsed = parseWebhook(req.body, c.WAHA_SESSION);
      if (!parsed) return reply.send({ ok: true, ignored: true });
      const result = await runtime.requireStore().ingest(parsed);
      return reply.code(202).send({ ok: true, ...result });
    },
  );
  await app.register(
    async (admin) => {
      admin.addHook("onRequest", async (req) => {
        if (!authorized(req, c)) throw new AppError("admin_unauthorized", 401);
      });
      admin.get("/metrics", async () => {
        const s = runtime.requireStore();
        const inbox = await s.pool.query(
          `SELECT count(*)::int AS pending,coalesce(extract(epoch FROM clock_timestamp()-min(received_at)),0)::int AS oldest_age_seconds FROM messages WHERE processed_at IS NULL`,
        );
        const outbox = await s.pool.query(
          "SELECT state,count(*)::int count FROM outbox GROUP BY state",
        );
        const queues = [];
        for (const q of QUEUES) {
          const stats = await s.queue.boss.getQueueStats(q);
          queues.push({ name: q, stats });
        }
        const blocked: Record<string, number> = {};
        for (const q of ["ingest", "conversation", "send"])
          blocked[q] = (await s.queue.boss.getBlockedKeys(q)).length;
        const ai = await s.pool.query(
          `SELECT count(*)::int AS calls,percentile_cont(0.95) WITHIN GROUP(ORDER BY (ai_metadata->>'elapsed_ms')::numeric) AS p95_ms FROM messages WHERE ai_metadata IS NOT NULL`,
        );
        return {
          ok: true,
          inbox: inbox.rows[0],
          outbox: outbox.rows,
          queues,
          blocked,
          ai: ai.rows[0],
        };
      });
      admin.get("/requests", async (req) => {
        const q = z
          .object({ phone: z.string().optional(), after: number.optional() })
          .parse(req.query);
        const s = runtime.requireStore();
        if (q.phone)
          return {
            ok: true,
            requests: await s.active(canonicalPhone(q.phone)),
          };
        const ids = await s.pool.query<{ id: string }>(
          "SELECT id FROM requests WHERE number>$1 ORDER BY number LIMIT 100",
          [q.after ?? 0],
        );
        const requests = [];
        for (const id of ids.rows) requests.push(await s.request(id.id));
        return { ok: true, requests };
      });
      admin.get("/messages/:id", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params),
          s = runtime.requireStore();
        const m = await s.message(p.id);
        const out = await s.pool.query(
          "SELECT id,phone,text,state,provider_id,error_code FROM outbox WHERE message_id=$1 ORDER BY seq",
          [p.id],
        );
        return { ok: true, message: m, outbox: out.rows };
      });
      admin.get("/outbox", async (req) => {
        const q = z
          .object({
            state: z
              .enum([
                "pending",
                "sending",
                "uncertain",
                "failed",
                "sent",
                "shadow",
                "simulation",
              ])
              .default("uncertain"),
          })
          .parse(req.query);
        const rows = await runtime
          .requireStore()
          .pool.query(
            "SELECT id,phone,chat_id,state,error_code,created_at,job_id FROM outbox WHERE state=$1 ORDER BY seq LIMIT 100",
            [q.state],
          );
        return { ok: true, rows: rows.rows };
      });
      admin.get("/media/:id", async (req, reply) => {
        const p = z.object({ id: uuid }).parse(req.params),
          s = runtime.requireStore();
        const rows = await s.pool.query<{
          storage_key: string;
          mime_type: string;
        }>("SELECT storage_key,mime_type FROM media WHERE id=$1", [p.id]);
        const m = rows.rows[0];
        if (!m || !runtime.engine) throw new AppError("media_not_found", 404);
        return reply
          .type(m.mime_type)
          .send(await runtime.engine.storage.get(m.storage_key));
      });
      admin.post(
        "/simulate",
        { bodyLimit: 36 * 1024 * 1024 },
        async (req, reply) => {
          if (!c.ENABLE_SIMULATE || !simulation?.ready || !simulation.engine)
            throw new AppError("simulation_not_ready", 503);
          const b = z
            .strictObject({
              phone: z.string(),
              text: z.string().max(16000).default(""),
              event_id: z
                .string()
                .regex(/^[a-zA-Z0-9_-]{1,100}$/)
                .optional(),
              image_base64: z
                .string()
                .max(36 * 1024 * 1024)
                .optional(),
            })
            .parse(req.body);
          const phone = canonicalPhone(b.phone);
          let captured;
          if (b.image_base64) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.image_base64))
              throw new AppError("invalid_base64");
            captured = await simulation.engine.storage.put(
              Buffer.from(b.image_base64, "base64"),
              "image",
            );
          }
          const result = await simulation
            .requireStore()
            .ingest(
              {
                external_id: `sim:${b.event_id ?? randomUUID()}`,
                chat_id: `972${phone}@c.us`,
                text: b.text,
                kind: captured ? "image" : "text",
                media_url: null,
                contacts: [],
                location: null,
              },
              "simulation",
              captured,
            );
          return reply
            .code(202)
            .send({
              ok: true,
              ...result,
              result_url: `/admin/simulations/${result.id}`,
              mode: "simulation",
            });
        },
      );
      admin.get("/simulations/:id", async (req) => {
        if (!simulation?.ready) throw new AppError("simulation_not_ready", 503);
        const p = z.object({ id: uuid }).parse(req.params),
          s = simulation.requireStore();
        const m = await s.message(p.id),
          out = await s.pool.query(
            "SELECT text,state,media_id FROM outbox WHERE message_id=$1 ORDER BY seq",
            [p.id],
          );
        return {
          ok: true,
          message: m,
          outbox: out.rows,
          requests: m.phone ? await s.active(m.phone) : [],
        };
      });
      admin.post("/requests/:number/resume", async (req) => {
        const p = paramsNumber.parse(req.params),
          b = z
            .strictObject({ expected_version: number, reason })
            .parse(req.body),
          s = runtime.requireStore();
        return s.transaction(async (client) => {
          const row = await client.query<{ id: string }>(
            "SELECT id FROM requests WHERE number=$1",
            [p.number],
          );
          if (!row.rows[0]) throw new AppError("request_not_found", 404);
          const r = await s.request(row.rows[0].id, client, true);
          if (r.version !== b.expected_version || r.status !== "human")
            throw new AppError("version_or_state_conflict", 409);
          r.status = "collecting";
          r.human_reason = null;
          await s.save(client, r);
          await client.query(
            "UPDATE conversations SET mode='bot',version=version+1 WHERE contact_id IN (SELECT contact_id FROM request_parties WHERE request_id=$1)",
            [r.id],
          );
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "request_resumed",
            { reason: b.reason },
            r.id,
          );
          return { ok: true, request: r };
        });
      });
      admin.post("/conversations/:phone/resume", async (req) => {
        const p = z.object({ phone: z.string() }).parse(req.params),
          b = z.strictObject({ reason }).parse(req.body),
          phone = canonicalPhone(p.phone),
          s = runtime.requireStore();
        await s.transaction(async (client) => {
          await client.query(
            "UPDATE conversations SET mode='bot',version=version+1 WHERE contact_id=(SELECT id FROM contacts WHERE phone=$1)",
            [phone],
          );
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "conversation_resumed",
            { phone, reason: b.reason },
          );
        });
        return { ok: true };
      });
      admin.post("/requests/:number/coordinate", async (req) => {
        const p = paramsNumber.parse(req.params),
          b = z
            .strictObject({
              expected_version: number,
              same_day_approved: z.boolean(),
              reason,
            })
            .parse(req.body),
          s = runtime.requireStore();
        return s.transaction(async (client) => {
          const row = await client.query<{ id: string }>(
            "SELECT id FROM requests WHERE number=$1",
            [p.number],
          );
          if (!row.rows[0]) throw new AppError("request_not_found", 404);
          const r = await s.request(row.rows[0].id, client, true);
          if (r.version !== b.expected_version)
            throw new AppError("version_conflict", 409);
          const result = await s.coordinate(
            client,
            r,
            new Date(),
            b.same_day_approved,
          );
          if (result !== "coordinated")
            throw new AppError(`coordination_${result}`, 409);
          await s.save(client, r);
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "coordinated",
            { date: r.run_date, reason: b.reason },
            r.id,
          );
          for (const party of r.parties)
            await s.outbound(
              client,
              { trace_id: req.id, mode: c.BOT_MODE },
              { phone: party.phone, text: statusText([r]) },
              `coordination:${r.id}:${r.run_date}:${party.phone}`,
              r.id,
            );
          return { ok: true, request: r };
        });
      });
      admin.post("/requests/:number/complete", async (req) => {
        const p = paramsNumber.parse(req.params),
          b = z
            .strictObject({ expected_version: number, reason })
            .parse(req.body),
          s = runtime.requireStore();
        return s.transaction(async (client) => {
          const row = await client.query<{ id: string }>(
            "SELECT id FROM requests WHERE number=$1",
            [p.number],
          );
          if (!row.rows[0]) throw new AppError("request_not_found", 404);
          const r = await s.request(row.rows[0].id, client, true);
          if (r.version !== b.expected_version || r.status !== "coordinated")
            throw new AppError("version_or_state_conflict", 409);
          r.status = "closed";
          await s.save(client, r);
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "completed",
            { reason: b.reason },
            r.id,
          );
          return { ok: true, request: r };
        });
      });
      admin.post("/transport-runs/:date/capacity", async (req) => {
        const p = z.object({ date: z.iso.date() }).parse(req.params),
          b = z
            .strictObject({
              capacity: z.number().int().min(1).max(100),
              reason,
            })
            .parse(req.body),
          s = runtime.requireStore();
        if (new Date(p.date + "T12:00:00Z").getUTCDay() !== 2)
          throw new AppError("tuesday_only");
        await s.transaction(async (client) => {
          await client.query(
            "INSERT INTO transport_runs(date,capacity) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [p.date, b.capacity],
          );
          await client.query(
            "SELECT date FROM transport_runs WHERE date=$1 FOR UPDATE",
            [p.date],
          );
          const used = await client.query<{ n: number }>(
            "SELECT count(*)::int n FROM requests WHERE run_date=$1 AND status IN ('coordinated','closed')",
            [p.date],
          );
          if (used.rows[0]!.n > b.capacity)
            throw new AppError("capacity_below_bookings", 409);
          await client.query(
            "UPDATE transport_runs SET capacity=$2 WHERE date=$1",
            [p.date, b.capacity],
          );
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "capacity_changed",
            { date: p.date, ...b },
          );
        });
        return { ok: true };
      });
      admin.post("/locations", async (req) => {
        const b = z
            .strictObject({
              name: z.string().min(1).max(100),
              aliases: z.array(z.string().min(1).max(100)).min(1).max(20),
              decision: z.enum(["allowed", "outside", "review"]),
              is_city: z.boolean(),
              reason,
            })
            .parse(req.body),
          s = runtime.requireStore();
        await s.transaction(async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext('locations'))",
          );
          const dup = await client.query(
            "SELECT 1 FROM service_locations WHERE name<>$1 AND aliases && $2::text[] LIMIT 1",
            [b.name, b.aliases],
          );
          if (dup.rowCount) throw new AppError("location_alias_conflict", 409);
          await client.query(
            "INSERT INTO service_locations(name,aliases,decision,is_city) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO UPDATE SET aliases=EXCLUDED.aliases,decision=EXCLUDED.decision,is_city=EXCLUDED.is_city,updated_at=clock_timestamp()",
            [b.name, b.aliases, b.decision, b.is_city],
          );
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "location_policy_changed",
            b,
          );
        });
        return { ok: true };
      });
      admin.post("/outbox/:id/resolve", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params),
          b = z
            .strictObject({
              outcome: z.enum(["delivered", "not_delivered", "cancel"]),
              provider_id: z.string().max(300).nullable(),
              reason,
            })
            .parse(req.body),
          s = runtime.requireStore();
        await s.transaction(async (client) => {
          const result = await client.query<{
            state: string;
            job_id: string;
            match_id: string | null;
          }>(
            "SELECT state,job_id,match_id FROM outbox WHERE id=$1 FOR UPDATE",
            [p.id],
          );
          const out = result.rows[0];
          if (!out) throw new AppError("outbox_not_found", 404);
          const job = await s.queue.boss.getJobById("send", out.job_id, {
            db: { executeSql: (text, values) => client.query(text, values) },
          });
          if (
            job?.state !== "failed" ||
            !["uncertain", "pending", "failed"].includes(out.state)
          )
            throw new AppError("wait_for_terminal_send_job", 409);
          if (b.outcome === "not_delivered") {
            await client.query(
              "UPDATE outbox SET state='pending',error_code=NULL WHERE id=$1",
              [p.id],
            );
            await s.queue.boss.retry("send", out.job_id, {
              db: { executeSql: (text, values) => client.query(text, values) },
            });
          } else {
            await client.query(
              "UPDATE outbox SET state=$2,provider_id=$3,sent_at=clock_timestamp() WHERE id=$1",
              [
                p.id,
                b.outcome === "delivered" ? "sent" : "cancelled",
                b.provider_id,
              ],
            );
            await s.queue.boss.deleteJob("send", out.job_id, {
              db: { executeSql: (text, values) => client.query(text, values) },
            });
            if (b.outcome === "delivered" && out.match_id)
              await client.query(
                "UPDATE matches SET state='presented',presented_at=clock_timestamp() WHERE id=$1 AND state='queued_photo'",
                [out.match_id],
              );
          }
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "outbox_resolved",
            { outbox_id: p.id, ...b },
          );
        });
        return { ok: true };
      });
      admin.post("/jobs/:queue/:id/retry", async (req) => {
        const p = z
            .object({ queue: z.enum(QUEUES), id: uuid })
            .parse(req.params),
          b = z.strictObject({ reason }).parse(req.body),
          s = runtime.requireStore();
        if (p.queue === "send")
          throw new AppError("use_outbox_resolution", 409);
        await s.transaction(async (client) => {
          const job = await s.queue.boss.getJobById(p.queue, p.id, {
            db: { executeSql: (text, values) => client.query(text, values) },
          });
          if (job?.state !== "failed")
            throw new AppError("job_not_failed", 409);
          await s.queue.boss.retry(p.queue, p.id, {
            db: { executeSql: (text, values) => client.query(text, values) },
          });
          await s.event(client, { trace_id: req.id }, "admin", "job_retried", {
            queue: p.queue,
            job_id: p.id,
            reason: b.reason,
          });
        });
        return { ok: true };
      });
      admin.get("/jobs/failed", async () => {
        const s = runtime.requireStore(),
          jobs = [];
        for (const queue of QUEUES) {
          const failed = await s.queue.boss.findJobs(queue);
          jobs.push(
            ...failed
              .filter((j) => j.state === "failed")
              .slice(0, 100)
              .map((j) => ({
                queue,
                id: j.id,
                data: j.data,
                created_on: j.createdOn,
                retry_count: j.retryCount,
                key_hash: createHash("sha256")
                  .update(j.singletonKey ?? "")
                  .digest("hex")
                  .slice(0, 12),
              })),
          );
        }
        return { ok: true, jobs };
      });
    },
    { prefix: "/admin" },
  );
  return app;
}
