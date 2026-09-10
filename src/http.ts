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
const databaseTable = z.enum([
  "requests",
  "contacts",
  "conversations",
  "messages",
  "outbox",
]);
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
  app.get("/haim-admin", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(String.raw`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>חיים יחד | ניהול</title>
<style>
:root{color-scheme:dark;--bg:#09121b;--panel:#101f2c;--line:#254056;--ink:#edf5fa;--muted:#9bb1c2;--accent:#43d5a1;--bad:#ff7474}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#08131d,#102b36);color:var(--ink);font:15px Arial,sans-serif}header{padding:26px max(20px,calc((100% - 1160px)/2));border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:center;justify-content:space-between}h1{margin:0;font-size:24px}.sub{color:var(--muted);margin-top:5px}.badge{padding:7px 11px;border-radius:99px;background:#12372d;color:var(--accent);font-weight:bold}main{max-width:1160px;margin:24px auto;padding:0 20px}.login,.card{background:rgba(16,31,44,.94);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 8px 28px #0003}.login{display:flex;gap:10px;align-items:end;margin-bottom:20px}.login label{flex:1}input,textarea{width:100%;margin-top:6px;padding:10px;border:1px solid #38546a;border-radius:8px;background:#09151f;color:var(--ink)}button{padding:10px 14px;border:0;border-radius:8px;background:#2cae83;color:#041510;font-weight:bold;cursor:pointer}.secondary{background:#28465b;color:var(--ink)}.danger{background:#b93636;color:white}button:disabled{opacity:.5;cursor:not-allowed}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.metric b{display:block;font-size:28px;margin-top:8px}.metric span{color:var(--muted)}.two{display:grid;grid-template-columns:1.1fr .9fr;gap:14px;margin-top:14px}.card h2{font-size:17px;margin:0 0 12px}.table{max-height:330px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:9px;text-align:right;border-bottom:1px solid #203a4e;vertical-align:top}th{color:var(--muted);font-size:12px}.form{display:grid;gap:10px}.notice{margin:14px 0;padding:11px;border-radius:8px;background:#112a3a;color:#cbe5f5}.error{color:var(--bad)}.ok{color:var(--accent)}.chat{min-height:220px;max-height:390px;overflow:auto;background:#09151f;border:1px solid #38546a;border-radius:10px;padding:10px}.bubble{max-width:86%;padding:10px;margin:7px 0;border-radius:12px;white-space:pre-wrap;line-height:1.45}.me{margin-right:auto;background:#1d5b70}.bot{margin-left:auto;background:#1d493a}.hint{color:var(--muted);font-size:13px}.radios{display:flex;gap:12px;margin:10px 0}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:10px}@media(max-width:800px){.grid,.two{grid-template-columns:1fr}.login{display:grid}}
</style></head><body><header><div><h1>חיים יחד · מרכז ניהול</h1><div class="sub">V5 · תפעול, הובלות וסימולציות</div></div><div class="badge">SHADOW · ללא שליחה חיה</div></header><main>
<section class="login"><label>טוקן ניהול<input id="token" type="password" autocomplete="off" placeholder="הדבק את HAIM_ADMIN_TOKEN"></label><button id="connect">התחבר</button><button class="secondary" id="refresh">רענן נתונים</button></section><div id="message" class="notice">הדף שומר את הטוקן בדפדפן שלך בלבד, עד לסגירת הלשונית.</div>
<section class="grid" id="metrics"><div class="card metric"><span>תיבת כניסה ממתינה</span><b>—</b></div><div class="card metric"><span>הודעות יוצאות</span><b>—</b></div><div class="card metric"><span>תורי עבודה</span><b>—</b></div><div class="card metric"><span>קריאות AI</span><b>—</b></div></section>
<section class="two"><div class="card"><h2>רשומות הובלות</h2><div class="hint">כל הובלה נשמרת במסד הנתונים ומופיעה כאן.</div><div class="table"><table><thead><tr><th>#</th><th>סטטוס</th><th>פריטים</th><th>מוסר ← מקבל</th><th>תאריך</th></tr></thead><tbody id="requests"><tr><td colspan="5">התחבר כדי לטעון נתונים</td></tr></tbody></table></div></div><div class="card"><h2>תור הודעות לא ודאיות</h2><div class="table"><table><thead><tr><th>טלפון</th><th>מצב</th><th>שגיאה</th></tr></thead><tbody id="outbox"><tr><td colspan="3">—</td></tr></tbody></table></div></div></section>
<section class="two"><div class="card"><h2>סימולציית צ׳אט</h2><div class="hint">ההודעות רצות בסביבה נפרדת, ולא נשלחות ל־WhatsApp.</div><div id="chat" class="chat"><div class="hint">כתוב הודעה כדי לדבר עם הבוט.</div></div><form id="simulate" class="form"><input id="phone" inputmode="numeric" placeholder="טלפון לדוגמה, למשל 584152101" required><textarea id="text" rows="3" placeholder="כתוב הודעה לבוט…" required></textarea><button>שלח לבוט</button></form></div><div class="card"><h2>גישת בוט</h2><div class="radios"><label><input type="radio" name="access" value="open" checked> פתוח לכולם</label><label><input type="radio" name="access" value="allowlist"> פתוח רק למספרים שאגדיר</label></div><label>מספרים מורשים<textarea id="allowlist" rows="5" placeholder="מספר אחד בכל שורה או מופרד בפסיקים"></textarea></label><div class="hint">מספר חסום אינו מקבל תגובה מהבוט.</div><div class="actions"><button id="save-access" type="button">שמור הגדרת גישה</button></div><hr><h2>איפוס שיחה</h2><input id="reset-phone" inputmode="numeric" placeholder="מספר טלפון לאיפוס"><div class="actions"><button id="reset-one" class="secondary" type="button">אפס שיחה למספר</button><button id="reset-all" class="danger" type="button">אפס את כל זיכרון הבוט</button></div><div class="hint">הפעולה מתחילה שיחה חדשה; רשומות ההובלות וההיסטוריה נשמרות.</div></div></section>
<section class="two"><div class="card"><h2>תורים שנכשלו</h2><div class="table"><table><thead><tr><th>תור</th><th>ניסיונות</th><th>מזהה</th></tr></thead><tbody id="failed"><tr><td colspan="3">—</td></tr></tbody></table></div></div></section>
<section class="card" style="margin-top:14px"><h2>מסד הנתונים</h2><div class="hint">צפייה, עריכה ומחיקה של רשומות. סיסמאות ומסוף SQL אינם חשופים בדף.</div><div class="actions"><select id="db-table"><option value="requests">פניות והובלות</option><option value="contacts">אנשי קשר</option><option value="conversations">שיחות</option><option value="messages">הודעות נכנסות</option><option value="outbox">הודעות יוצאות</option></select><button id="db-load" type="button">טען רשומות</button></div><div class="table"><table><thead id="db-head"></thead><tbody id="db-rows"><tr><td>בחר טבלה וטען נתונים</td></tr></tbody></table></div></section></main>
<script>
const token=document.querySelector('#token'),msg=document.querySelector('#message'),chat=document.querySelector('#chat');token.value=sessionStorage.getItem('haim-admin-token')||'';
function say(text,kind){msg.textContent=text;msg.className='notice '+(kind||'')}function esc(value){const s=String(value??'');return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}function rows(id,html,span){document.querySelector(id).innerHTML=html||'<tr><td colspan="'+span+'">אין נתונים</td></tr>'}function header(extra){return Object.assign({'x-admin-token':token.value.trim()},extra||{})}async function api(path,options){if(!token.value.trim())throw new Error('יש להזין טוקן ניהול');const o=Object.assign({},options||{});o.headers=header(o.headers);const r=await fetch('/admin/'+path,o);const j=await r.json();if(!r.ok)throw new Error(j.error?.message||j.error?.code||'הפעולה נכשלה');return j}function bubble(text,kind){if(chat.querySelector('.hint'))chat.innerHTML='';const d=document.createElement('div');d.className='bubble '+kind;d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight}function party(x,role){const p=(x.parties||[]).find(v=>v.role===role);return p?(p.name||p.phone||'—'):'—'}
async function refresh(){try{sessionStorage.setItem('haim-admin-token',token.value.trim());say('טוען נתונים…');const a=await Promise.all([api('metrics'),api('requests'),api('outbox?state=uncertain'),api('jobs/failed'),api('access')]);const m=a[0],requests=a[1].requests||[],outbox=a[2].rows||[],failed=a[3].jobs||[],access=a[4];const outTotal=(m.outbox||[]).reduce((n,x)=>n+Number(x.count||0),0),queueTotal=(m.queues||[]).reduce((n,x)=>n+Number(x.stats?.created||0),0);document.querySelector('#metrics').innerHTML='<div class="card metric"><span>תיבת כניסה ממתינה</span><b>'+esc(m.inbox?.pending)+'</b></div><div class="card metric"><span>הודעות יוצאות</span><b>'+outTotal+'</b></div><div class="card metric"><span>תורי עבודה</span><b>'+queueTotal+'</b></div><div class="card metric"><span>קריאות AI</span><b>'+esc(m.ai?.calls)+'</b></div>';rows('#requests',requests.map(x=>'<tr><td>'+esc(x.number)+'</td><td>'+esc(x.status)+'</td><td>'+esc((x.items||[]).map(i=>i.description).join(', '))+'</td><td>'+esc(party(x,'donor'))+' ← '+esc(party(x,'receiver'))+'</td><td>'+esc(x.run_date||'—')+'</td></tr>').join(''),5);rows('#outbox',outbox.map(x=>'<tr><td>'+esc(x.phone)+'</td><td>'+esc(x.state)+'</td><td>'+esc(x.error_code||'—')+'</td></tr>').join(''),3);rows('#failed',failed.map(x=>'<tr><td>'+esc(x.queue)+'</td><td>'+esc(x.retry_count)+'</td><td>'+esc(x.id).slice(0,8)+'</td></tr>').join(''),3);document.querySelector('input[name="access"][value="'+access.mode+'"]').checked=true;document.querySelector('#allowlist').value=(access.phones||[]).join('\n');say('עודכן עכשיו','ok')}catch(e){say(e.message||'הטעינה נכשלה','error')}}
async function waitForReply(url){for(let i=0;i<90;i++){await new Promise(resolve=>setTimeout(resolve,500));const r=await fetch(url,{headers:header()});const j=await r.json();if(!r.ok)throw new Error(j.error?.message||'הסימולציה נכשלה');if(j.message?.processed_at){const reply=j.message.reply||(j.outbox||[]).map(x=>x.text).filter(Boolean).join('\n');return reply||'הבוט עיבד את ההודעה ללא תשובה.'}}throw new Error('הסימולציה עדיין מעבדת. נסה שוב בעוד רגע.')}document.querySelector('#connect').onclick=refresh;document.querySelector('#refresh').onclick=refresh;
document.querySelector('#simulate').onsubmit=async e=>{e.preventDefault();const phone=document.querySelector('#phone').value,text=document.querySelector('#text').value;try{bubble(text,'me');document.querySelector('#text').value='';say('הבוט חושב…');const r=await api('simulate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,text})});const reply=await waitForReply(r.result_url);bubble(reply,'bot');say('הסימולציה הושלמה','ok');refresh()}catch(e){bubble('לא התקבלה תשובה: '+(e.message||'שגיאה'),'bot');say(e.message||'הסימולציה נכשלה','error')}};
document.querySelector('#save-access').onclick=async()=>{try{const mode=document.querySelector('input[name="access"]:checked').value,phones=document.querySelector('#allowlist').value.split(/[\s,]+/).filter(Boolean);await api('access',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode,phones})});say('הגדרת הגישה נשמרה','ok')}catch(e){say(e.message||'השמירה נכשלה','error')}};document.querySelector('#reset-one').onclick=async()=>{const phone=document.querySelector('#reset-phone').value.trim();if(!phone)return say('יש להזין מספר טלפון','error');if(!confirm('לאפס את זיכרון השיחה עבור '+phone+'? רשומות ההובלה לא יימחקו.'))return;try{await api('conversations/'+encodeURIComponent(phone)+'/reset',{method:'POST'});say('השיחה אופסה','ok')}catch(e){say(e.message||'האיפוס נכשל','error')}};document.querySelector('#reset-all').onclick=async()=>{if(!confirm('לאפס את זיכרון הבוט לכל המשתמשים? רשומות ההובלה יישמרו.'))return;try{await api('conversations/reset-all',{method:'POST'});say('זיכרון הבוט אופס לכל המשתמשים','ok')}catch(e){say(e.message||'האיפוס נכשל','error')}};
let dbRows={};async function loadDb(){try{const table=document.querySelector('#db-table').value,r=await api('database?table='+encodeURIComponent(table));dbRows=Object.fromEntries(r.rows.map(x=>[x.id,x]));document.querySelector('#db-head').innerHTML='<tr>'+r.columns.map(x=>'<th>'+esc(x)+'</th>').join('')+'<th>פעולות</th></tr>';document.querySelector('#db-rows').innerHTML=r.rows.map(x=>'<tr>'+r.columns.map(k=>'<td>'+esc(x[k])+'</td>').join('')+'<td><button class="secondary" onclick="dbEdit(\''+x.id+'\')">ערוך</button> <button class="danger" onclick="dbDelete(\''+x.id+'\')">מחק</button></td></tr>').join('')||'<tr><td>אין רשומות</td></tr>';say('רשומות המסד נטענו','ok')}catch(e){say(e.message||'טעינת המסד נכשלה','error')}}window.dbEdit=async id=>{const table=document.querySelector('#db-table').value,row=dbRows[id],raw=prompt('ערוך רק את השדות שברצונך לשנות בפורמט JSON',JSON.stringify(row,null,2));if(raw===null)return;try{const changes=JSON.parse(raw);delete changes.id;for(const k of Object.keys(row))if(k!=='id'&&changes[k]===row[k])delete changes[k];await api('database/'+table+'/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({changes})});await loadDb();say('הרשומה עודכנה','ok')}catch(e){say(e.message||'העדכון נכשל','error')}};window.dbDelete=async id=>{const table=document.querySelector('#db-table').value;if(!confirm('למחוק את הרשומה? פעולה זו אינה ניתנת לביטול.'))return;try{await api('database/'+table+'/'+encodeURIComponent(id),{method:'DELETE'});await loadDb();say('הרשומה נמחקה','ok')}catch(e){say(e.message||'המחיקה נכשלה','error')}};document.querySelector('#db-load').onclick=loadDb;
</script></body></html>`),
  );
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
      admin.get("/database", async (req) => {
        const q = z
          .object({ table: databaseTable, limit: z.coerce.number().int().min(1).max(100).default(50) })
          .parse(req.query);
        const views = {
          requests: {
            columns: ["number", "status", "origin", "run_date", "human_reason", "updated_at"],
            sql: "SELECT id,number,status,origin,run_date,human_reason,updated_at FROM requests ORDER BY number DESC LIMIT $1",
          },
          contacts: {
            columns: ["phone", "created_at"],
            sql: "SELECT id,phone,created_at FROM contacts ORDER BY created_at DESC LIMIT $1",
          },
          conversations: {
            columns: ["phone", "mode", "session", "chat_id", "selected_request_id", "version"],
            sql: "SELECT cv.id,co.phone,cv.mode,cv.session,cv.chat_id,cv.selected_request_id,cv.version FROM conversations cv JOIN contacts co ON co.id=cv.contact_id ORDER BY cv.id DESC LIMIT $1",
          },
          messages: {
            columns: ["seq", "phone", "kind", "text", "reply", "error_code", "received_at"],
            sql: "SELECT m.id,m.seq,co.phone,m.kind,m.text,m.reply,m.error_code,m.received_at FROM messages m LEFT JOIN contacts co ON co.id=m.contact_id ORDER BY m.seq DESC LIMIT $1",
          },
          outbox: {
            columns: ["seq", "phone", "state", "text", "error_code", "created_at"],
            sql: "SELECT id,seq,phone,state,text,error_code,created_at FROM outbox ORDER BY seq DESC LIMIT $1",
          },
        }[q.table];
        const rows = await runtime.requireStore().pool.query(views.sql, [q.limit]);
        return { ok: true, table: q.table, columns: views.columns, rows: rows.rows };
      });
      admin.patch("/database/:table/:id", async (req) => {
        const p = z.object({ table: databaseTable, id: uuid }).parse(req.params);
        const body = z.object({ changes: z.record(z.string(), z.unknown()) }).parse(req.body);
        const schemas = {
          requests: z.strictObject({
            status: z.enum(["collecting","available","awaiting_approval","waiting_capacity","coordinated","human","cancel_pending","cancelled","closed","rejected"]).optional(),
            run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
            human_reason: z.string().max(1000).nullable().optional(),
          }),
          contacts: z.strictObject({ phone: z.string().optional() }),
          conversations: z.strictObject({ mode: z.enum(["bot", "human"]).optional(), selected_request_id: uuid.nullable().optional() }),
          messages: z.strictObject({ text: z.string().max(16000).optional(), reply: z.string().max(16000).nullable().optional(), error_code: z.string().max(160).nullable().optional() }),
          outbox: z.strictObject({ text: z.string().min(1).max(16000).optional(), state: z.enum(["pending","sending","sent","shadow","simulation","uncertain","failed","cancelled"]).optional(), error_code: z.string().max(160).nullable().optional() }),
        };
        const parsed = schemas[p.table].parse(body.changes);
        if (!Object.keys(parsed).length) throw new AppError("database_empty_update", 400, "לא נבחרו שדות לעדכון.");
        const contactChanges = parsed as { phone?: string };
        if (p.table === "contacts" && contactChanges.phone)
          contactChanges.phone = canonicalPhone(contactChanges.phone);
        const fields = Object.keys(parsed);
        const assignment = fields.map((field, i) => `${field}=$${i + 1}`).join(",");
        const values = fields.map((field) => (parsed as Record<string, unknown>)[field]);
        const s = runtime.requireStore();
        await s.transaction(async (client) => {
          const r = await client.query(
            `UPDATE ${p.table} SET ${assignment}${p.table === "requests" ? ",updated_at=clock_timestamp(),version=version+1" : ""} WHERE id=$${values.length + 1}`,
            [...values, p.id],
          );
          if (!r.rowCount) throw new AppError("database_record_not_found", 404, "הרשומה לא נמצאה.");
          await s.event(client, { trace_id: req.id }, "admin", "database_record_updated", { table: p.table, id: p.id, fields });
        });
        return { ok: true };
      });
      admin.delete("/database/:table/:id", async (req) => {
        const p = z.object({ table: databaseTable, id: uuid }).parse(req.params);
        const s = runtime.requireStore();
        await s.transaction(async (client) => {
          if (p.table === "requests") {
            await client.query("UPDATE conversations SET selected_request_id=NULL WHERE selected_request_id=$1", [p.id]);
            await client.query("DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE request_id=$1)", [p.id]);
            await client.query("DELETE FROM request_events WHERE request_id=$1", [p.id]);
            await client.query("DELETE FROM outbox WHERE request_id=$1", [p.id]);
            await client.query("DELETE FROM matches WHERE request_id=$1", [p.id]);
            await client.query("DELETE FROM request_media WHERE request_id=$1", [p.id]);
            await client.query("DELETE FROM request_parties WHERE request_id=$1", [p.id]);
            await client.query("DELETE FROM request_items WHERE request_id=$1", [p.id]);
          }
          if (p.table === "messages") {
            const media = await client.query("SELECT 1 FROM media WHERE message_id=$1", [p.id]);
            if (media.rowCount) throw new AppError("database_message_has_media", 409, "יש למחוק קודם את קובץ המדיה המקושר להודעה.");
            await client.query("DELETE FROM command_results WHERE message_id=$1", [p.id]);
            await client.query("DELETE FROM outbox WHERE message_id=$1", [p.id]);
            await client.query("UPDATE request_events SET message_id=NULL WHERE message_id=$1", [p.id]);
          }
          const result = await client.query(`DELETE FROM ${p.table} WHERE id=$1`, [p.id]);
          if (!result.rowCount) throw new AppError("database_record_not_found", 404, "הרשומה לא נמצאה.");
          await s.event(client, { trace_id: req.id }, "admin", "database_record_deleted", { table: p.table, id: p.id });
        });
        return { ok: true };
      });
      admin.get("/access", async () => {
        return { ok: true, ...(await runtime.requireStore().botAccess()) };
      });
      admin.put("/access", async (req) => {
        const body = z
          .strictObject({
            mode: z.enum(["open", "allowlist"]),
            phones: z.array(z.string()).max(500),
          })
          .parse(req.body);
        const phones = [...new Set(body.phones.map(canonicalPhone))].sort();
        const access = { mode: body.mode, phones };
        const s = runtime.requireStore();
        await s.transaction(async (client) => {
          await client.query(
            "INSERT INTO app_settings(key,value,updated_at) VALUES('bot_access',$1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at",
            [JSON.stringify(access)],
          );
          await s.event(client, { trace_id: req.id }, "admin", "bot_access_changed", access);
        });
        return { ok: true, ...access };
      });
      admin.post("/conversations/:phone/reset", async (req) => {
        const phone = canonicalPhone(
            z.object({ phone: z.string() }).parse(req.params).phone,
          ),
          s = runtime.requireStore();
        await s.transaction(async (client) => {
          const conversations = await client.query<{ id: string }>(
            "SELECT cv.id FROM conversations cv JOIN contacts co ON co.id=cv.contact_id WHERE co.phone=$1 FOR UPDATE",
            [phone],
          );
          for (const conversation of conversations.rows) {
            await client.query(
              "INSERT INTO conversation_resets(conversation_id,reset_at) VALUES($1,clock_timestamp()) ON CONFLICT(conversation_id) DO UPDATE SET reset_at=EXCLUDED.reset_at",
              [conversation.id],
            );
            await client.query(
              "UPDATE conversations SET mode='bot',selected_request_id=NULL,version=version+1 WHERE id=$1",
              [conversation.id],
            );
          }
          await s.event(client, { trace_id: req.id }, "admin", "conversation_reset", {
            phone,
            conversations: conversations.rowCount,
          });
        });
        return { ok: true, phone };
      });
      admin.post("/conversations/reset-all", async (req) => {
        const s = runtime.requireStore();
        await s.transaction(async (client) => {
          const result = await client.query<{ id: string }>(
            "SELECT id FROM conversations FOR UPDATE",
          );
          for (const conversation of result.rows)
            await client.query(
              "INSERT INTO conversation_resets(conversation_id,reset_at) VALUES($1,clock_timestamp()) ON CONFLICT(conversation_id) DO UPDATE SET reset_at=EXCLUDED.reset_at",
              [conversation.id],
            );
          await client.query(
            "UPDATE conversations SET mode='bot',selected_request_id=NULL,version=version+1",
          );
          await s.event(client, { trace_id: req.id }, "admin", "all_conversations_reset", {
            conversations: result.rowCount,
          });
        });
        return { ok: true };
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
