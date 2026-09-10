import Fastify from "fastify";
import { readConfig } from "./config.js";
import { Runtime } from "./application/runtime.js";
import { makeHttp } from "./http.js";
const c = readConfig();
const logging = Fastify({
  logger: {
    level: c.LOG_LEVEL,
    redact: [
      "req.headers.authorization",
      "req.headers.x-admin-token",
      "req.headers.x-api-key",
      "password",
      "token",
      "apiKey",
      "body",
      "text",
      "contacts",
    ],
  },
});
const runtime = new Runtime(c, logging.log);
const sim = c.ENABLE_SIMULATE
  ? new Runtime(
      { ...c, BOT_MODE: "simulation", DB_SCHEMA: "haim_core_sim" },
      logging.log,
    )
  : null;
const app = await makeHttp(c, runtime, sim);
let stopping = false;
async function connect(): Promise<void> {
  for (const r of [runtime, sim])
    if (r && !r.ready) await r.start().catch((e) => r.safeError(e));
}
await app.listen({ host: "0.0.0.0", port: c.PORT });
void connect();
const retry = setInterval(() => {
  if (!stopping) void connect();
}, 5000);
retry.unref();
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(retry);
  runtime.ready = false;
  if (sim) sim.ready = false;
  const timer = setTimeout(() => process.exit(1), 60000);
  timer.unref();
  try {
    await app.close();
    await Promise.all([runtime.stop(), sim?.stop()]);
    await logging.close();
    clearTimeout(timer);
  } catch {
    logging.log.error({ code: "shutdown_failed" });
    process.exitCode = 1;
  }
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("unhandledRejection", () => {
  logging.log.error({ code: "unhandled_rejection" });
  process.exitCode = 1;
  void stop();
});
