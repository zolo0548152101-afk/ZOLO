import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { Runtime } from "./application/runtime.js";
import {
  AdminRateLimiter,
  adminAuditRecord,
  assertAdminSameOrigin,
  assertDestructiveAllowed,
  bindAdminCapability,
  type AdminCapability,
  requireAdminCapability,
} from "./application/admin-service.js";
import { AppError, errorCode } from "./domain/types.js";
import {
  canonicalPhone,
  MAX_TRANSPORT_CAPACITY,
  statusText,
} from "./domain/policies.js";
import { parseWebhook, verifyHmac } from "./infrastructure/webhook.js";
import { QUEUES } from "./infrastructure/queue.js";
import { buildOperationalSignals, type OperationalSnapshot } from "./application/observability.js";
import { redactDiagnosticText } from "./application/security.js";
const uuid = z.uuid();
const reason = z.string().trim().min(3).max(500);
const isTuesdayDate = (value: string) => {
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 2;
};
const number = z.coerce.number().int().positive();
const paramsNumber = z.object({ number });
const databaseTable = z.enum([
  "requests",
  "contacts",
  "conversations",
  "messages",
  "outbox",
]);
const adminStatusLabel: Record<string, string> = {
  collecting: "בהשלמת פרטים",
  available: "ממתינה למקבל",
  awaiting_approval: "ממתינה לאישור",
  waiting_capacity: "ממתינה למקום בהובלה",
  coordinated: "תואמה",
  human: "בטיפול אנושי",
  cancel_pending: "ממתינה להחלטה לאחר ביטול",
  cancelled: "בוטלה",
  closed: "הושלמה",
  rejected: "לא מתאימה",
};
function authenticatedCapability(req: FastifyRequest, c: Config): AdminCapability | null {
  const input = req.headers["x-admin-token"];
  if (typeof input !== "string") return null;
  const matches = (expected: string) => {
    if (!expected) return false;
    const a = Buffer.from(input), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (matches(c.HAIM_ADMIN_DESTRUCTIVE_TOKEN)) return "destructive";
  if (matches(c.HAIM_ADMIN_READONLY_TOKEN)) return "read-only";
  if (matches(c.HAIM_ADMIN_TOKEN)) return "normal";
  return null;
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
    version: "0.5.5",
    mode: c.BOT_MODE,
  }));
  app.get("/ready", async () => {
    await runtime.check();
    return {
      ok: true,
      version: "0.5.5",
      mode: c.BOT_MODE,
      schema: c.DB_SCHEMA,
      simulation_ready: simulation?.ready ?? false,
    };
  });
  app.get("/haim-admin", async (_req, reply) =>
    reply.header("cache-control", "no-store, no-cache, must-revalidate").type("text/html; charset=utf-8").send(String.raw`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>חיים יחד | ניהול</title>
<style>
:root{color-scheme:dark;--bg:#09121b;--panel:#101f2c;--line:#254056;--ink:#edf5fa;--muted:#9bb1c2;--accent:#43d5a1;--bad:#ff7474}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#08131d,#102b36);color:var(--ink);font:15px Arial,sans-serif}header{padding:26px max(20px,calc((100% - 1160px)/2));border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:center;justify-content:space-between}h1{margin:0;font-size:24px}.sub{color:var(--muted);margin-top:5px}.badge{padding:7px 11px;border-radius:99px;background:#12372d;color:var(--accent);font-weight:bold}main{max-width:1160px;margin:24px auto;padding:0 20px}.login,.card{background:rgba(16,31,44,.94);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 8px 28px #0003}.login{display:flex;gap:10px;align-items:end;margin-bottom:20px}.login label{flex:1}input,textarea,select{width:100%;margin-top:6px;padding:10px;border:1px solid #38546a;border-radius:8px;background:#09151f;color:var(--ink)}button{padding:10px 14px;border:0;border-radius:8px;background:#2cae83;color:#041510;font-weight:bold;cursor:pointer}.secondary{background:#28465b;color:var(--ink)}.danger{background:#b93636;color:white}button:disabled{opacity:.5;cursor:not-allowed}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.metric b{display:block;font-size:28px;margin-top:8px}.metric span{color:var(--muted)}.two{display:grid;grid-template-columns:1.1fr .9fr;gap:14px;margin-top:14px}.card h2{font-size:17px;margin:0 0 12px}.table{max-height:330px;overflow:auto}.db-table-wrap{max-height:560px;overflow:auto}.db-table-wrap thead th{position:sticky;top:0;background:#101f2c;z-index:2}table{width:100%;border-collapse:collapse}th,td{padding:9px;text-align:right;border-bottom:1px solid #203a4e;vertical-align:top}th{color:var(--muted);font-size:12px}.form{display:grid;gap:10px}.notice{margin:14px 0;padding:11px;border-radius:8px;background:#112a3a;color:#cbe5f5}.error{color:var(--bad)}.ok{color:var(--accent)}.chat{min-height:220px;max-height:390px;overflow:auto;background:#09151f;border:1px solid #38546a;border-radius:10px;padding:10px}.bubble{max-width:86%;padding:10px;margin:7px 0;border-radius:12px;white-space:pre-wrap;line-height:1.45}.me{margin-right:auto;background:#1d5b70}.bot{margin-left:auto;background:#1d493a}.hint{color:var(--muted);font-size:13px}.radios{display:flex;gap:12px;margin:10px 0}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:10px}@media(max-width:800px){.grid,.two{grid-template-columns:1fr}.login{display:grid}}
</style></head><body><header><div><h1>חיים יחד · מרכז ניהול</h1><div class="sub">V5 · תפעול, הובלות וסימולציות</div></div><div class="badge">מצב: ${c.BOT_MODE}</div></header><main>
<section class="login"><label>סיסמת ניהול<input id="token" type="password" autocomplete="current-password" placeholder="הזן את סיסמת הניהול"></label><button id="connect">התחבר</button><button class="secondary" id="refresh">רענן נתונים</button></section><div id="message" class="notice">הדף שומר את הסיסמה בדפדפן שלך בלבד, עד לסגירת הלשונית.</div>
<section class="grid" id="metrics"><div class="card metric"><span>תיבת כניסה ממתינה</span><b>—</b></div><div class="card metric"><span>הודעות יוצאות</span><b>—</b></div><div class="card metric"><span>תורי עבודה</span><b>—</b></div><div class="card metric"><span>קריאות AI</span><b>—</b></div></section>
<section class="card" style="margin-top:14px"><h2>חיבור WhatsApp</h2><label>סשן לחיבור<select id="waha-session"><option value="HAIM_YAHAD">HAIM_YAHAD</option><option value="default">default</option><option value="TAL_ZOLO">TAL_ZOLO</option></select></label><div id="waha-status" class="notice">התחבר כדי לבדוק את מצב החיבור.</div><div class="actions"><button id="waha-refresh" class="secondary" type="button">בדוק חיבור</button><button id="waha-reconnect" type="button">חבר מחדש</button><button id="waha-qr" class="secondary" type="button">הצג QR</button></div><div id="waha-qr-box" style="display:none;margin-top:12px;text-align:center"><img id="waha-qr-image" alt="קוד QR לחיבור WhatsApp" style="max-width:280px;background:white;padding:10px;border-radius:10px"><div class="hint">סרוק את הקוד מתוך WhatsApp בטלפון. לאחר הסריקה לחץ על בדוק חיבור.</div></div></section>
<section class="two"><div class="card"><h2>רשומות הובלות</h2><div class="hint">כל הובלה נשמרת במסד הנתונים ומופיעה כאן.</div><div class="table"><table><thead><tr><th>#</th><th>סטטוס</th><th>פריטים</th><th>מוסר ← מקבל</th><th>תאריך</th></tr></thead><tbody id="requests"><tr><td colspan="5">התחבר כדי לטעון נתונים</td></tr></tbody></table></div></div><div class="card"><h2>תור הודעות לא ודאיות</h2><div class="table"><table><thead><tr><th>טלפון</th><th>מצב</th><th>שגיאה</th></tr></thead><tbody id="outbox"><tr><td colspan="3">—</td></tr></tbody></table></div></div></section>
<section class="two"><div class="card"><h2>סימולציית צ׳אט</h2><div class="hint">ההודעות רצות בסביבה נפרדת, ולא נשלחות ל־WhatsApp.</div><div id="chat" class="chat"><div class="hint">כתוב הודעה כדי לדבר עם הבוט.</div></div><form id="simulate" class="form"><input id="phone" inputmode="numeric" placeholder="טלפון לדוגמה, למשל 584152101" required><textarea id="text" rows="3" placeholder="כתוב הודעה לבוט…" required></textarea><button>שלח לבוט</button></form></div><div class="card"><h2>גישת בוט</h2><div class="radios"><label><input type="radio" name="access" value="open" checked> פתוח לכולם</label><label><input type="radio" name="access" value="allowlist"> פתוח רק למספרים שאגדיר</label></div><label>מספרים מורשים<textarea id="allowlist" rows="5" placeholder="מספר אחד בכל שורה או מופרד בפסיקים"></textarea></label><div class="hint">מספר חסום אינו מקבל תגובה מהבוט.</div><div class="actions"><button id="save-access" type="button">שמור הגדרת גישה</button></div><hr><h2>איפוס שיחה</h2><input id="reset-phone" inputmode="numeric" placeholder="מספר טלפון לאיפוס"><div class="actions"><button id="reset-one" class="secondary" type="button">אפס שיחה למספר</button><button id="reset-all" class="danger" type="button">אפס את כל זיכרון הבוט</button></div><div class="hint">הפעולה מתחילה שיחה חדשה; רשומות ההובלות וההיסטוריה נשמרות.</div></div></section>
<section class="two"><div class="card"><h2>תורים שנכשלו</h2><div class="table"><table><thead><tr><th>תור</th><th>ניסיונות</th><th>מזהה</th></tr></thead><tbody id="failed"><tr><td colspan="3">—</td></tr></tbody></table></div></div></section>
<section class="card" style="margin-top:14px"><h2>מסד הנתונים</h2><div class="hint">צפייה, עריכה ומחיקה של רשומות. סיסמאות ומסוף SQL אינם חשופים בדף.</div><div class="actions"><select id="db-table"><option value="requests">פניות והובלות</option><option value="contacts">אנשי קשר</option><option value="conversations">שיחות</option><option value="messages">הודעות נכנסות</option><option value="outbox">הודעות יוצאות</option></select><button id="db-load" type="button">טען רשומות</button></div><div class="table db-table-wrap"><table><thead id="db-head"></thead><tbody id="db-rows"><tr><td>בחר טבלה וטען נתונים</td></tr></tbody></table></div><div id="db-pages" class="actions" aria-label="דפדוף בין עמודים"></div>${c.BOT_MODE === "live" ? "" : '<hr><h2>ניקוי סביבת בדיקות</h2><div class="hint">מוחק לצמיתות את כל הנתונים התפעוליים: פניות, הודעות, שיחות, אנשי קשר, קבצים מקושרים, תורים ואירועים. הגדרות מערכת ורשימות יישובים נשארות.</div><div class="actions"><button id="db-clear-all" class="danger" type="button">מחק את כל הרשומות</button></div>'}</section></main>
<script>
const token=document.querySelector('#token'),msg=document.querySelector('#message'),chat=document.querySelector('#chat');token.value=sessionStorage.getItem('haim-admin-token')||'';
function say(text,kind){msg.textContent=text;msg.className='notice '+(kind||'')}function esc(value){const s=String(value??'');return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}function rows(id,html,span){document.querySelector(id).innerHTML=html||'<tr><td colspan="'+span+'">אין נתונים</td></tr>'}function header(extra){return Object.assign({'x-admin-token':token.value.trim()},extra||{})}async function api(path,options){if(!token.value.trim())throw new Error('יש להזין סיסמת ניהול');const o=Object.assign({},options||{});o.headers=header(o.headers);const r=await fetch('/admin/'+path,o);const j=await r.json();if(!r.ok)throw new Error(j.error?.message||j.error?.code||'הפעולה נכשלה');return j}function bubble(text,kind){if(chat.querySelector('.hint'))chat.innerHTML='';const d=document.createElement('div');d.className='bubble '+kind;d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight}function party(x,role){const p=(x.parties||[]).find(v=>v.role===role);return p?(p.name||p.phone||'—'):'—'}
async function refresh(){try{sessionStorage.setItem('haim-admin-token',token.value.trim());say('טוען נתונים…');const a=await Promise.all([api('metrics'),api('requests'),api('outbox?state=uncertain'),api('jobs/failed'),api('access')]);const m=a[0],requests=a[1].requests||[],outbox=a[2].rows||[],failed=a[3].jobs||[],access=a[4];const outTotal=(m.outbox||[]).reduce((n,x)=>n+Number(x.count||0),0),queueTotal=(m.queues||[]).reduce((n,x)=>n+Number(x.stats?.created||0),0);document.querySelector('#metrics').innerHTML='<div class="card metric"><span>תיבת כניסה ממתינה</span><b>'+esc(m.inbox?.pending)+'</b></div><div class="card metric"><span>הודעות יוצאות</span><b>'+outTotal+'</b></div><div class="card metric"><span>תורי עבודה</span><b>'+queueTotal+'</b></div><div class="card metric"><span>קריאות AI</span><b>'+esc(m.ai?.calls)+'</b></div>';rows('#requests',requests.map(x=>'<tr><td>'+esc(x.number)+'</td><td>'+esc(x.status)+'</td><td>'+esc((x.items||[]).map(i=>i.description).join(', '))+'</td><td>'+esc(party(x,'donor'))+' ← '+esc(party(x,'receiver'))+'</td><td>'+esc(x.run_date||(x.proposed_run_date?'מוצע — ממתין לאישור: '+x.proposed_run_date:'—'))+'</td></tr>').join(''),5);rows('#outbox',outbox.map(x=>'<tr><td>'+esc(x.phone)+'</td><td>'+esc(x.state)+'</td><td>'+esc(x.error_code||'—')+'</td></tr>').join(''),3);rows('#failed',failed.map(x=>'<tr><td>'+esc(x.queue)+'</td><td>'+esc(x.retry_count)+'</td><td>'+esc(x.id).slice(0,8)+'</td></tr>').join(''),3);document.querySelector('input[name="access"][value="'+access.mode+'"]').checked=true;document.querySelector('#allowlist').value=(access.phones||[]).join('\n');say('עודכן עכשיו','ok')}catch(e){say(e.message||'הטעינה נכשלה','error')}}
async function waitForReply(url){for(let i=0;i<90;i++){await new Promise(resolve=>setTimeout(resolve,500));const r=await fetch(url,{headers:header()});const j=await r.json();if(!r.ok)throw new Error(j.error?.message||'הסימולציה נכשלה');if(j.message?.processed_at){const reply=j.message.reply||(j.outbox||[]).map(x=>x.text).filter(Boolean).join('\n');return reply||'הבוט עיבד את ההודעה ללא תשובה.'}}throw new Error('הסימולציה עדיין מעבדת. נסה שוב בעוד רגע.')}function wahaSession(){return encodeURIComponent(document.querySelector('#waha-session').value)}async function wahaStatus(){try{const s=await api('waha/status?session='+wahaSession()),el=document.querySelector('#waha-status');el.textContent=s.connected?'מחובר · '+s.status:'מנותק · '+(s.status||'לא זמין')+(s.message?' · '+s.message:'');el.className='notice '+(s.connected?'ok':'error');return s}catch(e){const el=document.querySelector('#waha-status');el.textContent='לא ניתן לבדוק את החיבור: '+(e.message||'שגיאה');el.className='notice error';throw e}}document.querySelector('#connect').onclick=refresh;document.querySelector('#refresh').onclick=refresh;document.querySelector('#waha-session').onchange=()=>wahaStatus().catch(()=>{});document.querySelector('#waha-refresh').onclick=()=>wahaStatus().catch(()=>{});document.querySelector('#waha-reconnect').onclick=async()=>{try{await api('waha/reconnect?session='+wahaSession(),{method:'POST'});say('בקשת חיבור מחדש נשלחה','ok');await wahaStatus()}catch(e){say(e.message||'החיבור מחדש נכשל','error')}};document.querySelector('#waha-qr').onclick=async()=>{try{const r=await api('waha/qr?session='+wahaSession());if(!r.data_url)throw new Error('QR עדיין לא זמין');document.querySelector('#waha-qr-image').src=r.data_url;document.querySelector('#waha-qr-box').style.display='block';say('קוד QR נטען','ok')}catch(e){say(e.message||'קוד ה־QR לא זמין','error')}};setInterval(()=>{if(token.value.trim())wahaStatus().catch(()=>{})},30000);
document.querySelector('#simulate').onsubmit=async e=>{e.preventDefault();const phone=document.querySelector('#phone').value,text=document.querySelector('#text').value;try{bubble(text,'me');document.querySelector('#text').value='';say('הבוט חושב…');const r=await api('simulate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,text})});const reply=await waitForReply(r.result_url);bubble(reply,'bot');say('הסימולציה הושלמה','ok');refresh()}catch(e){bubble('לא התקבלה תשובה: '+(e.message||'שגיאה'),'bot');say(e.message||'הסימולציה נכשלה','error')}};
document.querySelector('#save-access').onclick=async()=>{try{const mode=document.querySelector('input[name="access"]:checked').value,phones=document.querySelector('#allowlist').value.split(/[\s,]+/).filter(Boolean);await api('access',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode,phones})});say('הגדרת הגישה נשמרה','ok')}catch(e){say(e.message||'השמירה נכשלה','error')}};document.querySelector('#reset-one').onclick=async()=>{const phone=document.querySelector('#reset-phone').value.trim();if(!phone)return say('יש להזין מספר טלפון','error');if(!confirm('לאפס את זיכרון השיחה עבור '+phone+'? רשומות ההובלה לא יימחקו.'))return;try{await api('conversations/'+encodeURIComponent(phone)+'/reset',{method:'POST'});say('השיחה אופסה','ok')}catch(e){say(e.message||'האיפוס נכשל','error')}};document.querySelector('#reset-all').onclick=async()=>{if(!confirm('לאפס את זיכרון הבוט לכל המשתמשים? רשומות ההובלה יישמרו.'))return;try{await api('conversations/reset-all',{method:'POST'});say('זיכרון הבוט אופס לכל המשתמשים','ok')}catch(e){say(e.message||'האיפוס נכשל','error')}};
let dbRows={},dbEditable=[];async function loadDb(){try{const table=document.querySelector('#db-table').value,r=await api('database?table='+encodeURIComponent(table));dbEditable=r.editable_fields||[];dbRows=Object.fromEntries(r.rows.map(x=>[x.id,x]));document.querySelector('#db-head').innerHTML='<tr>'+r.columns.map(x=>'<th>'+esc(x)+'</th>').join('')+'<th>פעולות</th></tr>';document.querySelector('#db-rows').innerHTML=r.rows.map(x=>'<tr>'+r.columns.map(k=>'<td>'+esc(x[k])+'</td>').join('')+'<td><button class="secondary" onclick="dbEdit(\''+x.id+'\')">ערוך</button> <button class="danger" onclick="dbDelete(\''+x.id+'\')">מחק</button></td></tr>').join('')||'<tr><td>אין רשומות</td></tr>';say('רשומות המסד נטענו','ok')}catch(e){say(e.message||'טעינת המסד נכשלה','error')}}window.dbEdit=async id=>{const table=document.querySelector('#db-table').value,row=dbRows[id],editable=Object.fromEntries(dbEditable.map(k=>[k,row[k]??null]));if(!dbEditable.length)return say('אין שדות עריכה לטבלה הזו','error');const raw=prompt('ערוך רק את השדות האלו בפורמט JSON',JSON.stringify(editable,null,2));if(raw===null)return;try{const parsed=JSON.parse(raw),changes={};for(const k of dbEditable)if(JSON.stringify(parsed[k]??null)!==JSON.stringify(editable[k]??null))changes[k]=parsed[k]??null;await api('database/'+table+'/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({changes})});await loadDb();say('הרשומה עודכנה','ok')}catch(e){say(e.message||'העדכון נכשל','error')}};window.dbDelete=async id=>{const table=document.querySelector('#db-table').value;if(!confirm('למחוק את הרשומה? פעולה זו אינה ניתנת לביטול.'))return;try{await api('database/'+table+'/'+encodeURIComponent(id),{method:'DELETE'});await loadDb();say('הרשומה נמחקה','ok')}catch(e){say(e.message||'המחיקה נכשלה','error')}};document.querySelector('#db-load').onclick=loadDb;const clearAll=document.querySelector('#db-clear-all');if(clearAll)clearAll.onclick=async()=>{const phrase=prompt('פעולה בלתי הפיכה. להקליד בדיוק: מחק הכל');if(phrase!=='מחק הכל')return say('המחיקה בוטלה','error');try{const r=await api('database/clear-all',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:phrase})});await refresh();await loadDb();say('נמחקו כל רשומות הבדיקות ('+Object.values(r.deleted||{}).reduce((n,v)=>n+Number(v||0),0)+')','ok')}catch(e){say(e.message||'הניקוי נכשל','error')}};
</script><script>
const dbDangerBar=document.createElement('div');dbDangerBar.className='actions';dbDangerBar.style='margin-top:12px';const clearPhoneButton=document.createElement('button');clearPhoneButton.className='danger';clearPhoneButton.type='button';clearPhoneButton.textContent='מחק נתוני מספר';const clearSystemButton=document.createElement('button');clearSystemButton.className='danger';clearSystemButton.type='button';clearSystemButton.textContent='מחק את כל הרשומות';dbDangerBar.append(clearPhoneButton,clearSystemButton);document.querySelector('#db-table')?.parentElement?.parentElement?.append(dbDangerBar);clearPhoneButton.onclick=async()=>{const phone=prompt('הזן מספר למחיקת כל הנתונים הקשורים אליו');if(phone===null||!phone.trim())return;if(!confirm('למחוק לצמיתות את כל נתוני המספר '+phone+'?'))return;try{const r=await api('database/clear-phone',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:phone.trim(),confirm:'מחק מספר'})});await refresh();await window.loadDb();say('נתוני המספר נמחקו','ok')}catch(e){say(e.message||'מחיקת נתוני המספר נכשלה','error')}};clearSystemButton.onclick=async()=>{if(!confirm('למחוק לצמיתות את כל הרשומות במערכת?\n\nהגדרות המערכת ורשימות היישובים לא יימחקו.'))return;try{const r=await api('database/clear-all',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'מחק הכל'})});await refresh();await window.loadDb();say('כל הרשומות נמחקו','ok')}catch(e){say(e.message||'מחיקת כל הרשומות נכשלה','error')}};
const clearAllButton=document.querySelector('#db-clear-all');if(clearAllButton)clearAllButton.onclick=async()=>{if(!confirm('למחוק לצמיתות את כל הרשומות בסביבת הבדיקות?'))return;try{const r=await api('database/clear-all',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'מחק הכל'})});await refresh();await loadDb();say('נמחקו כל רשומות הבדיקות ('+Object.values(r.deleted||{}).reduce((n,v)=>n+Number(v||0),0)+')','ok')}catch(e){say(e.message||'הניקוי נכשל','error')}};
const dbLabels={number:'מספר פנייה',status:'סטטוס',donor_phone:'טלפון מוסר',donor_name:'שם מוסר',pickup_city:'יישוב איסוף',pickup_address:'כתובת איסוף',pickup_floor:'קומת איסוף',receiver_phone:'טלפון מקבל',receiver_name:'שם מקבל',destination_city:'יישוב יעד',destination_address:'כתובת יעד',destination_floor:'קומת יעד',items:'פריטים',item_description:'תיאור פריט',quantity:'כמות',needs_disassembly:'נדרש פירוק',requested_date:'תאריך מבוקש',preferred_time:'שעה מועדפת',run_date:'תאריך הובלה שאושר',proposed_run_date:'מועד מוצע — ממתין לאישור',donor_schedule_approved_date:'אישור מועד המוסר',receiver_schedule_approved_date:'אישור מועד המקבל',represents_both_parties:'אותו אדם משני הצדדים',closed_at:'נסגר בתאריך',human_reason:'סיבת טיפול אנושי',donor_approved:'המוסר אישר השתתפות',receiver_approved:'המקבל אישר השתתפות',photos:'מספר תמונות',media_ids:'תמונות להורדה',locations:'מיקומים שנשלחו',created_at:'נוצר בתאריך',updated_at:'עודכן בתאריך',phone:'טלפון',kind:'סוג הודעה',text:'תוכן',reply:'תשובת הבוט',error_code:'קוד שגיאה',received_at:'התקבל בתאריך',mode:'מצב שיחה',session:'סשן',chat_id:'מזהה צ׳אט',selected_request_id:'פנייה נבחרת',version:'גרסה',state:'מצב שליחה'};
const dbStatusLabels={collecting:'בהשלמת פרטים',available:'ממתינה למקבל',awaiting_approval:'ממתינה לאישור',waiting_capacity:'ממתינה למקום בהובלה',coordinated:'תואמה',human:'בטיפול אנושי',cancel_pending:'ממתינה להחלטה לאחר ביטול',cancelled:'בוטלה',closed:'הושלמה',rejected:'לא מתאימה'};
const dbStatusByLabel=Object.fromEntries(Object.entries(dbStatusLabels).map(([k,v])=>[v,k]));
function dbDisplay(key,value){if(key==='status')return dbStatusLabels[value]||value;if(key==='needs_disassembly'||key==='represents_both_parties'||key==='donor_approved'||key==='receiver_approved')return value===true?'כן':value===false?'לא':'—';return value??'—'}
function dbSafe(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function dbInput(key,value){
  if(key==='status')return '<select data-key="status">'+Object.entries(dbStatusLabels).map(([k,v])=>'<option value="'+k+'" '+(value===k?'selected':'')+'>'+v+'</option>').join('')+'</select>';
  if(['needs_disassembly','represents_both_parties'].includes(key))return '<select data-key="'+key+'"><option value="">לא צוין</option><option value="true" '+(value===true?'selected':'')+'>כן</option><option value="false" '+(value===false?'selected':'')+'>לא</option></select>';
  if(key==='run_date'||key==='requested_date')return '<input data-key="'+key+'" type="date" value="'+dbSafe(value||'')+'">';
  if(key==='human_reason'||key==='preferred_time')return '<input data-key="'+key+'" type="text" maxlength="500" value="'+dbSafe(value||'')+'">';
  if(key==='phone')return '<input data-key="'+key+'" inputmode="numeric" pattern="[0-9+() -]{9,20}" maxlength="20" value="'+dbSafe(value||'')+'">';
  return '<input data-key="'+key+'" maxlength="500" value="'+dbSafe(value||'')+'">';
}
window.dbEdit=async id=>{const table=document.querySelector('#db-table').value,row=dbRows[id];if(!dbEditable.length)return say('אין שדות עריכה לטבלה הזו','error');const wrap=document.createElement('div');wrap.style='display:grid;gap:10px;max-height:70vh;overflow:auto;padding:4px';for(const key of dbEditable){const label=document.createElement('label');label.textContent=dbLabels[key]||key;label.appendChild(document.createElement('br'));label.insertAdjacentHTML('beforeend',dbInput(key,row[key]));wrap.appendChild(label)}const modal=document.createElement('div');modal.style='position:fixed;inset:0;background:#000b;display:grid;place-items:center;padding:20px;z-index:10';const card=document.createElement('div');card.className='card';card.style='width:min(620px,100%)';const title=document.createElement('h2');title.textContent='עריכת רשומה — כל שדה בנפרד';card.append(title,wrap);const actions=document.createElement('div');actions.className='actions';const save=document.createElement('button');save.textContent='שמור שינויים';const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='ביטול';actions.append(save,cancel);card.append(actions);modal.append(card);document.body.append(modal);cancel.onclick=()=>modal.remove();save.onclick=async()=>{const changes={};for(const input of wrap.querySelectorAll('[data-key]')){const key=input.dataset.key;let value=input.value;if(['needs_disassembly','represents_both_parties'].includes(key))value=value===''?null:value==='true';if(key==='status'&&!(value in dbStatusLabels))return say('סטטוס לא תקין','error');if(key==='phone'&&!/^[0-9+() -]{9,20}$/.test(value))return say('מספר הטלפון אינו תקין','error');if(['run_date','requested_date'].includes(key)&&value&&!/^\\d{4}-\\d{2}-\\d{2}$/.test(value))return say('התאריך אינו תקין','error');if(JSON.stringify(value)!==JSON.stringify(row[key]??null))changes[key]=value||null}if(!Object.keys(changes).length){modal.remove();return}if(!confirm('לשמור את השינויים שבחרת?'))return;try{await api('database/'+table+'/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({changes})});modal.remove();await window.loadDb();say('הרשומה עודכנה','ok')}catch(e){say(e.message||'העדכון נכשל','error')}}};
window.loadDb=async()=>{try{const table=document.querySelector('#db-table').value,r=await api('database?table='+encodeURIComponent(table));dbEditable=r.editable_fields||[];dbRows=Object.fromEntries(r.rows.map(x=>[x.id,x]));document.querySelector('#db-head').innerHTML='<tr>'+r.columns.map(x=>'<th>'+dbSafe(dbLabels[x]||x)+'</th>').join('')+'<th>פעולות</th></tr>';document.querySelector('#db-rows').innerHTML=r.rows.map(x=>'<tr>'+r.columns.map(k=>'<td>'+dbSafe(dbDisplay(k,x[k]))+'</td>').join('')+'<td><button class="secondary" onclick="dbEdit(\''+x.id+'\')">עריכת שדות</button> <button class="danger" onclick="dbDelete(\''+x.id+'\')">מחק</button></td></tr>').join('')||'<tr><td>אין רשומות</td></tr>';say('רשומות המסד נטענו','ok')}catch(e){say(e.message||'טעינת המסד נכשלה','error')}};document.querySelector('#db-load').onclick=window.loadDb;
</script><script>
window.dbEdit=async id=>{
  const table=document.querySelector('#db-table').value,row=dbRows[id];
  if(!row)return say('הרשומה לא נמצאה','error');
  const wrap=document.createElement('div');
  wrap.style='display:grid;gap:10px;max-height:70vh;overflow:auto;padding:4px';
  for(const key of Object.keys(row).filter(k=>k!=='id')){
    const label=document.createElement('label');
    label.textContent=(dbLabels[key]||key)+(dbEditable.includes(key)?'':' · לקריאה בלבד');
    label.appendChild(document.createElement('br'));
    if(dbEditable.includes(key)) label.insertAdjacentHTML('beforeend',dbInput(key,row[key]));
    else {const value=document.createElement('div');value.textContent=dbDisplay(key,row[key]);value.style='padding:10px;border:1px solid #38546a;border-radius:8px;color:#9bb1c2;white-space:pre-wrap;word-break:break-word';label.append(value)}
    wrap.append(label);
  }
  const modal=document.createElement('div');modal.style='position:fixed;inset:0;background:#000b;display:grid;place-items:center;padding:20px;z-index:10';
  const card=document.createElement('div');card.className='card';card.style='width:min(700px,100%)';
  const title=document.createElement('h2');title.textContent='עריכת רשומה — כל השדות';card.append(title,wrap);
  const actions=document.createElement('div');actions.className='actions';
  const save=document.createElement('button');save.textContent='שמור שינויים';
  const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='ביטול';
  actions.append(save,cancel);card.append(actions);modal.append(card);document.body.append(modal);
  cancel.onclick=()=>modal.remove();
  save.onclick=async()=>{
    const changes={};
    for(const input of wrap.querySelectorAll('[data-key]')){
      const key=input.dataset.key;let value=input.value;
      if(['needs_disassembly','represents_both_parties'].includes(key))value=value===''?null:value==='true';
      if(key==='status'&&!(value in dbStatusLabels))return say('סטטוס לא תקין','error');
      if(key==='phone'&&!/^[0-9+() -]{9,20}$/.test(value))return say('מספר הטלפון אינו תקין','error');
      if(['run_date','requested_date'].includes(key)&&value&&!/^\\d{4}-\\d{2}-\\d{2}$/.test(value))return say('התאריך אינו תקין','error');
      if(JSON.stringify(value)!==JSON.stringify(row[key]??null))changes[key]=value||null;
    }
    if(!Object.keys(changes).length){modal.remove();return}
    if(!confirm('לשמור את השינויים שבחרת?'))return;
    try{await api('database/'+table+'/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({changes})});modal.remove();await window.loadDb();say('הרשומה עודכנה','ok')}catch(e){say(e.message||'העדכון נכשל','error')}
  };
};
</script><script type="text/plain">
let dbPage=1,dbAllRows=[],dbVisibleRows=[],dbColumns=[],dbTableName='';
function dbDate(v){if(!v)return '—';const d=new Date(v);if(Number.isNaN(d.getTime()))return String(v);const pad=n=>String(n).padStart(2,'0');return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+String(d.getFullYear()).slice(-2)+' '+pad(d.getHours())+':'+pad(d.getMinutes())}
function dbCell(k,v){if(/(^|_)(at|date)$/.test(k)||k==='created_at'||k==='updated_at'||k==='closed_at')return dbDate(v);return dbDisplay(k,v)}
function dbRender(){const start=(dbPage-1)*20,items=dbAllRows.slice(start,start+20);document.querySelector('#db-rows').innerHTML=items.map(x=>'<tr>'+dbColumns.map(k=>{let extra='';if((k==='phone'||k==='donor_phone'||k==='receiver_phone')&&x[k])extra='<br><button class="secondary" type="button" onclick="dbConversation(\\''+dbSafe(x[k])+"\\')">צפה בשיחה</button>";if(k==='media_id'&&x[k])extra=' <a href="/admin/media/'+encodeURIComponent(x[k])+'" target="_blank" download>הורדה</a>';if(k==='location'&&x[k])extra=' <button class="secondary" type="button" onclick="dbCopyLocation(\\''+dbSafe(JSON.stringify(x[k]))+"\\')">העתק מיקום</button>";return '<td>'+dbSafe(dbCell(k,x[k]))+extra+'</td>'}).join('')+'<td><button class="secondary" onclick="dbEdit(\\''+x.id+'\\')">עריכת שדות</button> <button class="danger" onclick="dbDelete(\\''+x.id+'\\')">מחק</button>'+(dbTableName==='requests'?'<br><button class="secondary" onclick="dbRequestFiles(\\''+x.id+'\\')">תמונות ומיקומים</button>':'')+'</td></tr>').join('')||'<tr><td colspan="'+(dbColumns.length+1)+'">אין רשומות</td></tr>';const pages=Math.max(1,Math.ceil(dbAllRows.length/20));document.querySelector('#db-pages').innerHTML='<button class="secondary" '+(dbPage<=1?'disabled':'')+' onclick="dbGoPage('+(dbPage-1)+')">הקודם</button><span>עמוד '+dbPage+' מתוך '+pages+' · '+dbAllRows.length+' רשומות</span><button class="secondary" '+(dbPage>=pages?'disabled':'')+' onclick="dbGoPage('+(dbPage+1)+')">הבא</button>'}
function dbGoPage(p){dbPage=p;dbRender()}
async function dbLoadPage(){try{dbTableName=document.querySelector('#db-table').value;const r=await api('database?table='+encodeURIComponent(dbTableName)+'&limit=100');dbEditable=r.editable_fields||[];dbAllRows=r.rows||[];dbColumns=r.columns||[];dbRows=Object.fromEntries(dbAllRows.map(x=>[x.id,x]));dbPage=1;document.querySelector('#db-head').innerHTML='<tr>'+dbColumns.map(x=>'<th>'+dbSafe(dbLabels[x]||x)+'</th>').join('')+'<th>פעולות</th></tr>';dbRender();say('רשומות המסד נטענו','ok')}catch(e){say(e.message||'טעינת המסד נכשלה','error')}}
window.dbCopyLocation=async raw=>{try{const x=JSON.parse(raw),text=typeof x==='object'&&x.latitude!==undefined?String(x.latitude)+', '+String(x.longitude):String(raw);await navigator.clipboard.writeText(text);say('המיקום הועתק','ok')}catch(e){say('לא ניתן להעתיק את המיקום','error')}};
window.dbRequestFiles=async id=>{try{const [m,l]=await Promise.all([api('database/requests/'+id+'/media'),api('database/requests/'+id+'/locations')]);const text=(m.rows.length?'תמונות שמורות:\n'+m.rows.map(x=>x.url).join('\n'):'אין תמונות')+'\n\n'+(l.rows.length?'מיקומים:\n'+l.rows.map(x=>x.role+': '+x.latitude+', '+x.longitude).join('\n'):'אין מיקומים');const raw=prompt('פרטי מדיה ומיקומים — ניתן להעתיק את הקישורים',text);if(raw!==null&&raw)await navigator.clipboard.writeText(raw)}catch(e){say(e.message||'טעינת המדיה נכשלה','error')}};
window.dbConversation=async phone=>{try{const r=await api('database/phone/'+encodeURIComponent(phone)+'/messages');const modal=document.createElement('div');modal.style='position:fixed;inset:0;background:#000b;display:grid;place-items:center;padding:20px;z-index:20';const card=document.createElement('div');card.className='card';card.style='width:min(760px,100%)';const title=document.createElement('h2');title.textContent='התכתבות עם '+phone;const body=document.createElement('div');body.className='chat';body.innerHTML=r.rows.map(x=>'<div class="bubble me"><b>'+dbSafe(dbDate(x.received_at))+'</b> · '+dbSafe(x.kind)+'<br>'+dbSafe(x.text||'')+(x.location?' <button class="secondary" onclick="dbCopyLocation(\\''+dbSafe(JSON.stringify(x.location))+"\\')">העתק מיקום</button>":'')+(x.media_url?' <a href="'+x.media_url+'" target="_blank" download>הורד תמונה</a>':'')+(x.reply?'<hr><b>תשובת הבוט:</b><br>'+dbSafe(x.reply):'')+'</div>').join('')||'<div class="hint">אין התכתבויות</div>';const form=document.createElement('form');form.className='actions';form.innerHTML='<textarea rows="2" placeholder="כתוב הודעה ישירה…" required></textarea><button>שלח הודעה</button><button type="button" class="secondary">סגור</button>';form.querySelector('button[type=button]').onclick=()=>modal.remove();form.onsubmit=async e=>{e.preventDefault();const input=form.querySelector('textarea');try{await api('conversations/'+encodeURIComponent(phone)+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:input.value})});input.value='';say('ההודעה נשלחה לתור השליחה','ok');const n=await api('database/phone/'+encodeURIComponent(phone)+'/messages');body.innerHTML=n.rows.map(x=>'<div class="bubble me"><b>'+dbSafe(dbDate(x.received_at))+'</b><br>'+dbSafe(x.text||'')+'</div>').join('')}catch(e){say(e.message||'שליחת ההודעה נכשלה','error')}};card.append(title,body,form);modal.append(card);document.body.append(modal)}catch(e){say(e.message||'טעינת ההתכתבות נכשלה','error')}};
window.loadDb=dbLoadPage;document.querySelector('#db-load').onclick=dbLoadPage;
const dbSearch=document.createElement('input');dbSearch.id='db-search';dbSearch.placeholder='חיפוש בכל העמודות…';dbSearch.setAttribute('aria-label','חיפוש בכל העמודות');document.querySelector('#db-load').parentElement.append(dbSearch);let dbSortKey='',dbSortDir=1;const dbRenderBase=dbRender;dbRender=function(){const all=dbAllRows,term=(dbSearch.value||'').trim().toLocaleLowerCase();dbAllRows=all.filter(x=>!term||Object.values(x).some(v=>String(v??'').toLocaleLowerCase().includes(term)));if(dbSortKey)dbAllRows.sort((a,b)=>String(a[dbSortKey]??'').localeCompare(String(b[dbSortKey]??''),'he',{numeric:true})*dbSortDir);dbRenderBase();dbAllRows=all;document.querySelectorAll('#db-head th').forEach((th,i)=>{if(i>=dbColumns.length)return;th.style.cursor='pointer';th.title='לחץ למיון';th.onclick=()=>{const key=dbColumns[i];dbSortDir=dbSortKey===key?-dbSortDir:1;dbSortKey=key;dbRender()}});decoratePhoneCells()};dbSearch.oninput=()=>{dbPage=1;dbRender()};
const requestEditable=['status','run_date','preferred_time','represents_both_parties','human_reason','donor_phone','donor_name','pickup_city','pickup_address','pickup_floor','receiver_phone','receiver_name','destination_city','destination_address','destination_floor','item_description','quantity','needs_disassembly'];
window.dbEdit=async id=>{const table=document.querySelector('#db-table').value,row=dbRows[id];if(table!=='requests')return say('לטבלה הזו יש עריכה ייעודית','error');const wrap=document.createElement('div');wrap.style='display:grid;gap:10px;max-height:70vh;overflow:auto;padding:4px';for(const key of requestEditable){const label=document.createElement('label');label.textContent=dbLabels[key]||({item_description:'תיאור פריט'}[key]||key);label.appendChild(document.createElement('br'));let value=key==='item_description'?(row.items||'').split(',')[0]:row[key];label.insertAdjacentHTML('beforeend',dbInput(key,value));const input=label.querySelector('[data-key]');if(input)input.dataset.key=key;wrap.append(label)}const modal=document.createElement('div');modal.style='position:fixed;inset:0;background:#000b;display:grid;place-items:center;padding:20px;z-index:20';const card=document.createElement('div');card.className='card';card.style='width:min(700px,100%)';const title=document.createElement('h2');title.textContent='עריכת פרטי פנייה';card.append(title,wrap);const actions=document.createElement('div');actions.className='actions';const save=document.createElement('button');save.textContent='שמור שינויים';const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='ביטול';actions.append(save,cancel);card.append(actions);modal.append(card);document.body.append(modal);cancel.onclick=()=>modal.remove();save.onclick=async()=>{const changes={};for(const input of wrap.querySelectorAll('[data-key]')){let v=input.value;if(['pickup_floor','destination_floor','quantity'].includes(input.dataset.key))v=v===''?null:Number(v);if(input.dataset.key==='needs_disassembly')v=v===''?null:v==='true';if(JSON.stringify(v)!==JSON.stringify((input.dataset.key==='item_description'?(row.items||'').split(',')[0]:row[input.dataset.key])??null))changes[input.dataset.key]=v}if(!Object.keys(changes).length){modal.remove();return}if(!confirm('לשמור את פרטי הפנייה?'))return;try{await api('database/requests/'+encodeURIComponent(id)+'/full',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({changes})});modal.remove();await dbLoadPage();say('פרטי הפנייה עודכנו','ok')}catch(e){say(e.message||'עדכון הפנייה נכשל','error')}}};
function decoratePhoneCells(){document.querySelectorAll('#db-rows td').forEach(td=>{const value=td.textContent.trim();if(!/^[0-9]{9}$/.test(value)||td.querySelector('button'))return;td.textContent='';const b=document.createElement('button');b.className='secondary';b.type='button';b.textContent=value;b.onclick=()=>dbConversation(value);td.append(b)})}function decorateRequestArtifacts(){if(dbTableName!=='requests')return;const mi=dbColumns.indexOf('media_ids'),li=dbColumns.indexOf('locations');document.querySelectorAll('#db-rows tr').forEach((tr,i)=>{const x=dbAllRows[(dbPage-1)*20+i];if(!x)return;if(mi>=0){const cell=tr.children[mi];const ids=Array.isArray(x.media_ids)?x.media_ids:[];cell.innerHTML=ids.length?ids.map(id=>'<a href="/admin/media/'+encodeURIComponent(id)+'" target="_blank" download>הורד תמונה</a>').join('<br>'):'—'}if(li>=0){const cell=tr.children[li],ls=Array.isArray(x.locations)?x.locations:[];cell.innerHTML=ls.length?ls.map((l,j)=>'<button class="secondary" type="button" onclick="dbCopyLocation(\\''+dbSafe(JSON.stringify(l))+"\\')">העתק מיקום "+(j+1)+'</button>').join('<br>'):'—'}})}const oldDbRender=dbRender;dbRender=function(){const all=dbAllRows,term=(dbSearch.value||'').trim().toLocaleLowerCase();dbAllRows=all.filter(x=>!term||Object.values(x).some(v=>String(v??'').toLocaleLowerCase().includes(term)));if(dbSortKey)dbAllRows.sort((a,b)=>String(a[dbSortKey]??'').localeCompare(String(b[dbSortKey]??''),'he',{numeric:true})*dbSortDir);oldDbRender();dbAllRows=all;document.querySelectorAll('#db-head th').forEach((th,i)=>{if(i>=dbColumns.length)return;th.style.cursor='pointer';th.title='לחץ למיון';th.onclick=()=>{const key=dbColumns[i];dbSortDir=dbSortKey===key?-dbSortDir:1;dbRender()}});decoratePhoneCells();decorateRequestArtifacts()};dbSearch.oninput=()=>{dbPage=1;dbRender()};
</script><script type="text/plain">
decorateRequestArtifacts=function(){if(dbTableName!=='requests')return;const mi=dbColumns.indexOf('media_ids'),li=dbColumns.indexOf('locations');document.querySelectorAll('#db-rows tr').forEach((tr,i)=>{const x=dbVisibleRows[(dbPage-1)*20+i];if(!x)return;if(mi>=0){const cell=tr.children[mi],ids=Array.isArray(x.media_ids)?x.media_ids:[];cell.innerHTML=ids.length?ids.map(id=>'<a href="/admin/media/'+encodeURIComponent(id)+'" target="_blank" download>הורד תמונה</a>').join('<br>'):'—'}if(li>=0){const cell=tr.children[li],ls=Array.isArray(x.locations)?x.locations:[];cell.innerHTML=ls.length?ls.map((l,j)=>'<button class="secondary" type="button" onclick="dbCopyLocation(\\''+dbSafe(JSON.stringify(l))+"\\')">העתק מיקום "+(j+1)+'</button>').join('<br>'):'—'}})};const dbRenderVisible=dbRender;dbRender=function(){const all=dbAllRows,term=(dbSearch.value||'').trim().toLocaleLowerCase();dbAllRows=all.filter(x=>!term||Object.values(x).some(v=>String(v??'').toLocaleLowerCase().includes(term)));if(dbSortKey)dbAllRows.sort((a,b)=>String(a[dbSortKey]??'').localeCompare(String(b[dbSortKey]??''),'he',{numeric:true})*dbSortDir);dbVisibleRows=dbAllRows.slice();dbRenderVisible();dbAllRows=all;decorateRequestArtifacts()};
</script><script>
(() => {
  async function downloadAdminMedia(anchor){const response=await fetch(anchor.href,{headers:header()});const contentType=response.headers.get('content-type')||'';if(!response.ok||!contentType.startsWith('image/')){const body=await response.json().catch(()=>({}));throw new Error(body.error?.message||'הורדת התמונה נכשלה')}const blob=await response.blob();const objectUrl=URL.createObjectURL(blob);const link=document.createElement('a');link.href=objectUrl;link.download=anchor.dataset.filename||'image';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000)}
  document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest('a[href^="/admin/media/"]'):null;if(!target)return;event.preventDefault();void downloadAdminMedia(target).catch(err=>say(err.message||'הורדת התמונה נכשלה','error'))});
  let allRows=[], columns=[], tableName='', page=1, sortKey='', sortDir=1;
  const perPage=20, head=document.querySelector('#db-head'), body=document.querySelector('#db-rows'), pages=document.querySelector('#db-pages');
  const search=document.createElement('input'); search.placeholder='חיפוש בכל העמודות…'; search.setAttribute('aria-label','חיפוש בכל העמודות'); document.querySelector('#db-load').parentElement.append(search);
  const formatDate=value=>{if(!value)return '—';const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);const n=x=>String(x).padStart(2,'0');return n(d.getDate())+'/'+n(d.getMonth()+1)+'/'+String(d.getFullYear()).slice(-2)+' '+n(d.getHours())+':'+n(d.getMinutes())};
  const valueFor=(key,value)=>/(_at|_date)$/.test(key)||['created_at','updated_at','closed_at','received_at','run_date','requested_date'].includes(key)?formatDate(value):dbDisplay(key,value);
  const clip=async text=>{try{await navigator.clipboard.writeText(text);say('הועתק ללוח','ok')}catch(_){say('לא ניתן להעתיק','error')}};
  const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=text;b.onclick=fn;return b};
  async function conversation(phone){try{const r=await api('database/phone/'+encodeURIComponent(phone)+'/messages');const modal=document.createElement('div');modal.style='position:fixed;inset:0;background:#000b;display:grid;place-items:center;padding:20px;z-index:30';const card=document.createElement('div');card.className='card';card.style='width:min(760px,100%)';const title=document.createElement('h2');title.textContent='כל ההתכתבות עם '+phone;const list=document.createElement('div');list.className='chat';const draw=rows=>{list.replaceChildren();if(!rows.length){list.textContent='אין הודעות שמורות';return}for(const row of rows){const item=document.createElement('div');item.className='bubble me';item.append(document.createTextNode(formatDate(row.received_at)+' · '+(row.kind||'הודעה')+'\n'+(row.text||'')));if(row.reply)item.append(document.createTextNode('\nתשובת הבוט: '+row.reply));if(row.media_url){const a=document.createElement('a');a.href=row.media_url;a.target='_blank';a.download='';a.textContent='הורד תמונה';item.append(document.createElement('br'),a)}if(row.location){item.append(document.createElement('br'),button('העתק מיקום',()=>clip(JSON.stringify(row.location))));}list.append(item)}};draw(r.rows||[]);const form=document.createElement('form');form.className='actions';const text=document.createElement('textarea');text.rows=2;text.required=true;text.placeholder='כתוב הודעה ישירה ל־WhatsApp…';const send=document.createElement('button');send.textContent='שלח הודעה';const close=button('סגור',()=>modal.remove());form.append(text,send,close);form.onsubmit=async e=>{e.preventDefault();try{await api('conversations/'+encodeURIComponent(phone)+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:text.value})});text.value='';say('ההודעה נוספה לתור השליחה','ok')}catch(err){say(err.message||'שליחת ההודעה נכשלה','error')}};card.append(title,list,form);modal.append(card);document.body.append(modal)}catch(err){say(err.message||'טעינת ההתכתבות נכשלה','error')}}
  async function requestFiles(id){try{const r=await Promise.all([api('database/requests/'+id+'/media'),api('database/requests/'+id+'/locations')]);const modal=document.createElement('div');modal.style='position:fixed;inset:0;background:#000b;display:grid;place-items:center;padding:20px;z-index:30';const card=document.createElement('div');card.className='card';card.style='width:min(600px,100%)';const title=document.createElement('h2');title.textContent='תמונות ומיקומים';card.append(title);const media=document.createElement('div');media.textContent=r[0].rows.length?'תמונות שמורות:':'';for(const x of r[0].rows){const a=document.createElement('a');a.href=x.url;a.target='_blank';a.download='';a.textContent='הורד תמונה';media.append(document.createElement('br'),a)}const locations=document.createElement('div');locations.style='margin-top:14px';locations.textContent=r[1].rows.length?'מיקומים שנשלחו:':'אין מיקומים שמורים';for(const x of r[1].rows){locations.append(document.createElement('br'),button('העתק מיקום '+x.role,()=>clip(x.latitude+', '+x.longitude)))}card.append(media,locations,button('סגור',()=>modal.remove()));modal.append(card);document.body.append(modal)}catch(err){say(err.message||'טעינת תמונות ומיקומים נכשלה','error')}}
  function render(){const term=search.value.trim().toLocaleLowerCase();let rows=allRows.filter(row=>!term||Object.values(row).some(v=>String(v??'').toLocaleLowerCase().includes(term)));if(sortKey)rows.sort((a,b)=>String(a[sortKey]??'').localeCompare(String(b[sortKey]??''),'he',{numeric:true})*sortDir);const max=Math.max(1,Math.ceil(rows.length/perPage));page=Math.min(page,max);const visible=rows.slice((page-1)*perPage,page*perPage);body.replaceChildren();for(const row of visible){const tr=document.createElement('tr');for(const key of columns){const td=document.createElement('td');if(['phone','donor_phone','receiver_phone'].includes(key)&&row[key])td.append(button(String(row[key]),()=>conversation(String(row[key]))));else if(key==='media_ids'){const ids=Array.isArray(row[key])?row[key]:[];if(!ids.length)td.textContent='—';for(const id of ids){const a=document.createElement('a');a.href='/admin/media/'+encodeURIComponent(id);a.target='_blank';a.download='';a.textContent='הורד תמונה';td.append(a,document.createElement('br'))}}else if(key==='locations'){const locations=Array.isArray(row[key])?row[key]:[];if(!locations.length)td.textContent='—';for(const location of locations)td.append(button('העתק מיקום',()=>clip(location.latitude+', '+location.longitude)),document.createElement('br'))}else td.textContent=valueFor(key,row[key]);tr.append(td)}const actions=document.createElement('td');if(tableName==='requests')actions.append(button('תמונות ומיקומים',()=>requestFiles(row.id)));tr.append(actions);body.append(tr)}if(!visible.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=columns.length+1;td.textContent='אין רשומות';tr.append(td);body.append(tr)}pages.replaceChildren(button('הקודם',()=>{page--;render()}),document.createTextNode(' עמוד '+page+' מתוך '+max+' · '+rows.length+' רשומות '),button('הבא',()=>{page++;render()}));pages.querySelector('button:first-child').disabled=page<=1;pages.querySelector('button:last-child').disabled=page>=max}
  async function load(){try{tableName=document.querySelector('#db-table').value;const r=await api('database?table='+encodeURIComponent(tableName)+'&limit=100');allRows=r.rows||[];columns=r.columns||[];dbRows=Object.fromEntries(allRows.map(x=>[x.id,x]));dbEditable=r.editable_fields||[];head.replaceChildren();const tr=document.createElement('tr');for(const key of columns){const th=document.createElement('th');th.textContent=dbLabels[key]||key;th.style.cursor='pointer';th.onclick=()=>{sortDir=sortKey===key?-sortDir:1;sortKey=key;render()};tr.append(th)}const action=document.createElement('th');action.textContent='פעולות';tr.append(action);head.append(tr);page=1;render();say('רשומות המסד נטענו','ok')}catch(err){say(err.message||'טעינת המסד נכשלה','error')}}
  search.oninput=()=>{page=1;render()};window.loadDb=load;document.querySelector('#db-load').onclick=load;
})();
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
      const adminRateLimiter = new AdminRateLimiter();
      admin.addHook("onRequest", async (req) => {
        const capability = authenticatedCapability(req, c);
        if (!capability) throw new AppError("admin_unauthorized", 401);
        bindAdminCapability(req, capability);
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
          assertAdminSameOrigin(req, c);
          requireAdminCapability(req, "normal");
          adminRateLimiter.check(req, String(req.headers["x-admin-token"]));
          if ((req.method === "PATCH" || req.method === "DELETE") && req.url.startsWith("/admin/database/"))
            throw new AppError("admin_generic_mutation_unavailable", 404, "מסד הנתונים זמין לקריאה בלבד; השתמש בפעולת אדמין named.");
        }
      });
      const wahaCall = async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("X-Api-Key", c.WAHA_API_KEY);
        if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
        return fetch(`${c.WAHA_BASE_URL}${path}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(c.WAHA_TIMEOUT_MS),
        });
      };
      const allowedWahaSessions = new Set([c.WAHA_SESSION, "default", "TAL_ZOLO"]);
      const requestedWahaSession = (req: FastifyRequest) => {
        const value = (req.query as { session?: unknown } | undefined)?.session;
        const session = typeof value === "string" && value.trim() ? value.trim() : c.WAHA_SESSION;
        if (!allowedWahaSessions.has(session)) throw new AppError("waha_session_not_allowed", 400, "סשן WhatsApp זה אינו מורשה בדף הניהול.");
        return session;
      };
      admin.get("/waha/status", async (req) => {
        const session = requestedWahaSession(req);
        try {
          const r = await wahaCall(`/api/sessions/${encodeURIComponent(session)}`);
          const body = await r.json().catch(() => ({}));
          const status = typeof body?.status === "string" ? body.status : "UNKNOWN";
          return { ok: true, connected: r.ok && status === "WORKING", session, status };
        } catch {
          return { ok: true, connected: false, session, status: "UNAVAILABLE", message: "WAHA אינו זמין" };
        }
      });
      admin.post("/waha/reconnect", async (req) => {
        const session = requestedWahaSession(req);
        const r = await wahaCall("/api/sessions/start", {
          method: "POST",
          body: JSON.stringify({ name: session }),
        });
        if (!r.ok && r.status !== 422) throw new AppError("waha_reconnect_failed", 502, "לא ניתן להתחיל את סשן WhatsApp.");
        const s = runtime.requireStore();
        await s.transaction((client) => s.event(
          client,
          { trace_id: req.id },
          "admin",
          "admin_mutation",
          adminAuditRecord(req, "reconnect_waha", `waha:${session}`, "success", { started: r.ok }),
        ));
        return { ok: true, started: r.ok, session };
      });
      admin.get("/waha/qr", async (req) => {
        const session = requestedWahaSession(req);
        const paths = [
          `/api/${encodeURIComponent(session)}/auth/qr`,
          `/api/sessions/${encodeURIComponent(session)}/auth/qr`,
        ];
        for (const path of paths) {
          const r = await wahaCall(path);
          if (!r.ok) continue;
          const contentType = r.headers.get("content-type") ?? "image/png";
          if (contentType.includes("json")) {
            const body = await r.json().catch(() => ({}));
            const value = typeof body?.value === "string" ? body.value : typeof body?.data === "string" ? body.data : null;
            if (value) return { ok: true, data_url: value.startsWith("data:") ? value : `data:image/png;base64,${value}` };
          } else {
            const bytes = Buffer.from(await r.arrayBuffer());
            // The admin client consumes JSON. Returning the raw PNG made the
            // button appear to do nothing because api() attempted r.json().
            return { ok: true, data_url: `data:${contentType};base64,${bytes.toString("base64")}` };
          }
        }
        throw new AppError("waha_qr_unavailable", 404, "קוד ה־QR עדיין לא זמין. נסה לחבר מחדש ולרענן.");
      });
      admin.get("/metrics", async () => {
        const s = runtime.requireStore();
        const inbox = await s.pool.query(
          `SELECT count(*)::int AS pending,coalesce(extract(epoch FROM clock_timestamp()-min(received_at)),0)::int AS oldest_age_seconds FROM messages WHERE processed_at IS NULL`,
        );
        const outbox = await s.pool.query(
          "SELECT state,count(*)::int count FROM outbox GROUP BY state",
        );
        const outboxAge = await s.pool.query<{ count: number; oldest_age_seconds: number; uncertain_count: number; retrying_count: number }>(
          `SELECT count(*) FILTER (WHERE state IN ('pending','sending','uncertain','failed'))::int AS count,
                  coalesce(extract(epoch FROM clock_timestamp()-min(created_at) FILTER (WHERE state IN ('pending','sending','uncertain','failed'))),0)::int AS oldest_age_seconds,
                  count(*) FILTER (WHERE state='uncertain')::int AS uncertain_count,
                  count(*) FILTER (WHERE state='failed')::int AS retrying_count
             FROM outbox`,
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
        const staleLeases = await s.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM conversation_turns WHERE status IN ('pending','processing') AND deadline_at IS NOT NULL AND deadline_at < clock_timestamp()",
        );
        const promptFailures = await s.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM messages WHERE error_code ILIKE 'openai%' OR error_code ILIKE 'planner%' OR error_code ILIKE '%prompt%'",
        );
        const sheetsImportStates = await s.pool.query<{ review_required: number; failed: number }>(
          "SELECT count(*) FILTER (WHERE state='review_required')::int AS review_required, count(*) FILTER (WHERE state='failed')::int AS failed FROM sheets_import_batches",
        );
        const integrationRetrying = await s.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM integration_outbox WHERE state='pending' AND error_class='retryable'",
        );
        const integrationStaleActive = await s.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM integration_outbox WHERE state='active' AND last_attempt_at < clock_timestamp()-interval '60 seconds'",
        );
        const snapshot: OperationalSnapshot = {
          inbox: { count: Number(inbox.rows[0]?.pending ?? 0), oldestAgeSeconds: Number(inbox.rows[0]?.oldest_age_seconds ?? 0) },
          outbox: { count: Number(outboxAge.rows[0]?.count ?? 0), oldestAgeSeconds: Number(outboxAge.rows[0]?.oldest_age_seconds ?? 0), uncertainCount: Number(outboxAge.rows[0]?.uncertain_count ?? 0) },
          retryingDeliveries: Number(outboxAge.rows[0]?.retrying_count ?? 0),
          integrationRetryingDeliveries: Number(integrationRetrying.rows[0]?.count ?? 0),
          deadLetter: (await s.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM integration_outbox WHERE state='dead_letter'")).rows[0]?.count ?? 0,
          integrationStaleActive: Number(integrationStaleActive.rows[0]?.count ?? 0),
          staleLeases: staleLeases.rows[0]?.count ?? 0,
          fifoBlockers: Object.values(blocked).reduce((sum, value) => sum + value, 0),
          promptFailures: promptFailures.rows[0]?.count ?? 0,
          sheetsReviewRequired: sheetsImportStates.rows[0]?.review_required ?? 0,
          sheetsFailed: sheetsImportStates.rows[0]?.failed ?? 0,
        };
        return {
          ok: true,
          inbox: inbox.rows[0],
          outbox: outbox.rows,
          integrations: (await s.pool.query(
            `SELECT integration,
                    count(*) FILTER (WHERE state='pending')::int AS pending_count,
                    coalesce(extract(epoch FROM clock_timestamp()-min(created_at) FILTER (WHERE state='pending')),0)::int AS oldest_pending_age_seconds,
                    count(*) FILTER (WHERE state='pending' AND error_class='retryable')::int AS retrying_count,
                    count(*) FILTER (WHERE state='dead_letter')::int AS dead_letter_count,
                    count(*) FILTER (WHERE state='active' AND last_attempt_at < clock_timestamp()-interval '60 seconds')::int AS stuck_active_count,
                    coalesce(sum(attempts),0)::int AS attempts
               FROM integration_outbox
              GROUP BY integration ORDER BY integration`,
          )).rows,
          integration_details: (await s.pool.query(
            `SELECT integration,id,event_id,state,attempts,last_error,error_class,
                    created_at,last_attempt_at,next_attempt_at,terminal_at
               FROM integration_outbox
              WHERE state<>'delivered' OR last_error IS NOT NULL
              ORDER BY event_id DESC LIMIT 100`,
          )).rows.map((row) => ({ ...row, last_error: redactDiagnosticText(row.last_error) })),
          queues,
          blocked,
          ai: ai.rows[0],
          observability: buildOperationalSignals(snapshot),
        };
      });
      admin.post("/integrations/:id/replay", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params);
        const b = z.strictObject({ reason }).parse(req.body);
        requireAdminCapability(req, "normal");
        const s = runtime.requireStore();
        await s.transaction(async (client) => {
          const row = await client.query<{ state: string; integration: string; idempotency_key: string }>(
            "SELECT state,integration,idempotency_key FROM integration_outbox WHERE id=$1 FOR UPDATE",
            [p.id],
          );
          const item = row.rows[0];
          if (!item) throw new AppError("integration_delivery_not_found", 404);
          if (item.state === "delivered") throw new AppError("integration_delivery_already_delivered", 409);
          if (item.state !== "dead_letter") throw new AppError("integration_delivery_not_terminal", 409);
          await client.query(
            "UPDATE integration_outbox SET state='pending',attempts=0,last_error=NULL,error_class=NULL,terminal_at=NULL,next_attempt_at=NULL WHERE id=$1",
            [p.id],
          );
          await s.queue.send(client, "integration", { id: p.id }, `integration:${item.integration}:${p.id}`);
          await s.event(client, { trace_id: req.id }, "admin", "integration_delivery_replayed", adminAuditRecord(req, "replay_integration_delivery", `integration_outbox:${p.id}`, "success", { integration_outbox_id: p.id, idempotency_key: item.idempotency_key, reason: b.reason }));
        });
        return { ok: true, id: p.id };
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
        return {
          ok: true,
          requests: requests.map((request) => ({
            ...request,
            status: adminStatusLabel[request.status] ?? request.status,
          })),
        };
      });
      admin.get("/database", async (req) => {
        const q = z
          .object({ table: databaseTable, limit: z.coerce.number().int().min(1).max(100).default(100) })
          .parse(req.query);
        const views = {
          requests: {
            columns: ["number","status","donor_phone","donor_name","pickup_city","pickup_address","pickup_floor","receiver_phone","receiver_name","destination_city","destination_address","destination_floor","items","quantity","needs_disassembly","requested_date","preferred_time","proposed_run_date","donor_schedule_approved_date","receiver_schedule_approved_date","run_date","represents_both_parties","closed_at","human_reason","donor_approved","receiver_approved","photos","media_ids","locations","created_at","updated_at"],
            editableFields: [],
            sql: `SELECT r.id,r.number,r.status,dc.phone AS donor_phone,d.name AS donor_name,d.settlement AS pickup_city,d.address AS pickup_address,d.floor AS pickup_floor,rc.phone AS receiver_phone,v.name AS receiver_name,v.settlement AS destination_city,v.address AS destination_address,v.floor AS destination_floor,string_agg(i.description, ', ' ORDER BY i.position) AS items,coalesce(sum(i.quantity),0)::int AS quantity,bool_or(i.needs_disassembly) AS needs_disassembly,r.earliest_run_date AS requested_date,r.preferred_time,r.proposed_run_date,d.schedule_approved_date AS donor_schedule_approved_date,v.schedule_approved_date AS receiver_schedule_approved_date,r.run_date,r.represents_both_parties,r.closed_at,r.human_reason,d.approved_at IS NOT NULL AS donor_approved,v.approved_at IS NOT NULL AS receiver_approved,(SELECT count(*)::int FROM request_media rm WHERE rm.request_id=r.id) AS photos,(SELECT coalesce(json_agg(rm.media_id ORDER BY rm.media_id),'[]'::json) FROM request_media rm WHERE rm.request_id=r.id) AS media_ids,(SELECT coalesce(json_agg(json_build_object('role',rl.role,'latitude',rl.latitude,'longitude',rl.longitude) ORDER BY rl.role),'[]'::json) FROM request_locations rl WHERE rl.request_id=r.id) AS locations,r.created_at,r.updated_at FROM requests r LEFT JOIN request_parties d ON d.request_id=r.id AND d.role='donor' LEFT JOIN contacts dc ON dc.id=d.contact_id LEFT JOIN request_parties v ON v.request_id=r.id AND v.role='receiver' LEFT JOIN contacts rc ON rc.id=v.contact_id LEFT JOIN request_items i ON i.request_id=r.id GROUP BY r.id,dc.phone,d.name,d.settlement,d.address,d.floor,d.approved_at,d.schedule_approved_date,rc.phone,v.name,v.settlement,v.address,v.floor,v.approved_at,v.schedule_approved_date ORDER BY r.number DESC LIMIT $1`,
          },
          contacts: {
            columns: ["phone", "created_at"],
            editableFields: [],
            sql: "SELECT id,phone,created_at FROM contacts ORDER BY created_at DESC LIMIT $1",
          },
          conversations: {
            columns: ["phone", "mode", "session", "chat_id", "selected_request_id", "version"],
            editableFields: [],
            sql: "SELECT cv.id,co.phone,cv.mode,cv.session,cv.chat_id,cv.selected_request_id,cv.version FROM conversations cv JOIN contacts co ON co.id=cv.contact_id ORDER BY cv.id DESC LIMIT $1",
          },
          messages: {
            columns: ["seq", "phone", "kind", "text", "reply", "error_code", "received_at"],
            editableFields: [],
            sql: "SELECT m.id,m.seq,co.phone,m.kind,m.text,m.reply,m.error_code,m.received_at FROM messages m LEFT JOIN contacts co ON co.id=m.contact_id ORDER BY m.seq DESC LIMIT $1",
          },
          outbox: {
            columns: ["seq", "phone", "state", "text", "error_code", "created_at"],
            editableFields: [],
            sql: "SELECT id,seq,phone,state,text,error_code,created_at FROM outbox ORDER BY seq DESC LIMIT $1",
          },
        }[q.table];
        const rows = await runtime.requireStore().pool.query(views.sql, [q.limit]);
        return { ok: true, table: q.table, columns: views.columns, editable_fields: views.editableFields, rows: rows.rows };
      });
      admin.patch("/database/requests/:id/full", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params);
        const b = z.object({ changes: z.strictObject({
          status: z.enum(["collecting","available","awaiting_approval","waiting_capacity","coordinated","human","cancel_pending","cancelled","closed","rejected"]).optional(),
          run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          preferred_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), represents_both_parties: z.boolean().optional(), human_reason: z.string().max(1000).nullable().optional(),
          donor_phone: z.string().optional(), donor_name: z.string().max(160).nullable().optional(),
          pickup_city: z.string().max(160).nullable().optional(), pickup_address: z.string().max(500).nullable().optional(), pickup_floor: z.coerce.number().int().min(-3).max(100).nullable().optional(),
          receiver_phone: z.string().optional(), receiver_name: z.string().max(160).nullable().optional(),
          destination_city: z.string().max(160).nullable().optional(), destination_address: z.string().max(500).nullable().optional(), destination_floor: z.coerce.number().int().min(-3).max(100).nullable().optional(),
          item_description: z.string().min(1).max(160).nullable().optional(), quantity: z.coerce.number().int().min(1).max(2).optional(), needs_disassembly: z.boolean().nullable().optional(),
        }) }).parse(req.body);
        const changes = b.changes as Record<string, any>, s = runtime.requireStore();
        await s.transaction(async (client) => {
          const current = await client.query<{ role: string; contact_id: string; status: string; run_date: string | null }>("SELECT rp.role,rp.contact_id,r.status,r.run_date::text FROM request_parties rp JOIN requests r ON r.id=rp.request_id WHERE rp.request_id=$1 FOR UPDATE OF r", [p.id]);
          if (current.rows.length === 0) throw new AppError("database_record_not_found", 404, "הרשומה לא נמצאה.");
          const scheduleAffecting = Object.keys(changes).some((key) => key !== "human_reason");
          const effectiveStatus = changes.status ?? current.rows[0]!.status;
          const effectiveDate = changes.run_date === undefined ? current.rows[0]!.run_date : changes.run_date;
          if (effectiveDate && !isTuesdayDate(effectiveDate))
            throw new AppError("tuesday_only", 400, "אפשר לשבץ הובלה רק ביום שלישי.");
          if (effectiveDate)
            await client.query("INSERT INTO transport_runs(date,capacity) VALUES($1,$2) ON CONFLICT DO NOTHING", [effectiveDate, 10]);
          if (effectiveStatus === "coordinated") {
            if (!effectiveDate) throw new AppError("coordinated_requires_run_date", 400, "יש לבחור תאריך הובלה לפני סימון הפנייה כמתואמת.");
            await client.query("SELECT date FROM transport_runs WHERE date=$1 FOR UPDATE", [effectiveDate]);
            const capacity = await client.query<{ capacity: number; status: string }>("SELECT capacity,status FROM transport_runs WHERE date=$1", [effectiveDate]);
            const booked = await client.query<{ n: number }>("SELECT count(*)::int n FROM requests WHERE id<>$2 AND ((run_date=$1 AND status IN ('coordinated','closed')) OR (proposed_run_date=$1 AND status='awaiting_approval'))", [effectiveDate, p.id]);
            if (capacity.rows[0]?.status !== "open" || booked.rows[0]!.n >= capacity.rows[0]!.capacity)
              throw new AppError("transport_capacity_full", 409, "המכסה לתאריך הזה מלאה או שהסבב סגור.");
          }
          const basic = ["status", "run_date", "preferred_time", "represents_both_parties", "human_reason"].filter((k) => changes[k] !== undefined);
          if (basic.length) await client.query(`UPDATE requests SET ${basic.map((k, i) => k + "=$" + (i + 1)).join(",")},updated_at=clock_timestamp(),version=version+1 WHERE id=$${basic.length + 1}`, [...basic.map((k) => changes[k]), p.id]);
          for (const role of ["donor", "receiver"] as const) {
            const prefix = role === "donor" ? "donor" : "receiver", has = Object.keys(changes).some((k) => k.startsWith(prefix) || (role === "donor" && k.startsWith("pickup")) || (role === "receiver" && k.startsWith("destination")));
            if (!has) continue;
            const old = current.rows.find((x) => x.role === role);
            if (!old) continue;
            let contactId = old.contact_id;
            const newPhone = changes[prefix + "_phone"];
            if (newPhone !== undefined) {
              const phone = canonicalPhone(newPhone);
              contactId = (await client.query<{ id: string }>("INSERT INTO contacts(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id", [phone])).rows[0]!.id;
            }
            const fields: string[] = ["contact_id"], values: unknown[] = [contactId];
            const add = (field: string, value: unknown) => { if (value !== undefined) { fields.push(field); values.push(value); } };
            add("name", changes[prefix + "_name"]); add("settlement", changes[prefix === "donor" ? "pickup_city" : "destination_city"]); add("address", changes[prefix === "donor" ? "pickup_address" : "destination_address"]); add("floor", changes[prefix === "donor" ? "pickup_floor" : "destination_floor"]);
            await client.query(`UPDATE request_parties SET ${fields.map((f, i) => f + "=$" + (i + 1)).join(",")} WHERE request_id=$${values.length + 1} AND role=$${values.length + 2}`, [...values, p.id, role]);
          }
          const item = [changes.item_description !== undefined, changes.quantity !== undefined, changes.needs_disassembly !== undefined];
          if (item.some(Boolean)) {
            const fields: string[] = [], values: unknown[] = [];
            const add = (field: string, value: unknown) => { if (value !== undefined) { fields.push(field); values.push(value); } };
            add("description", changes.item_description); add("quantity", changes.quantity); add("needs_disassembly", changes.needs_disassembly);
            if (fields.length) await client.query(`UPDATE request_items SET ${fields.map((f, i) => f + "=$" + (i + 1)).join(",")} WHERE request_id=$${values.length + 1} AND position=0`, [...values, p.id]);
          }
          if (scheduleAffecting) {
            if (changes.status !== undefined || changes.run_date !== undefined)
              await client.query("UPDATE requests SET proposed_run_date=NULL WHERE id=$1", [p.id]);
            await client.query("UPDATE request_parties SET approved_at=NULL,approved_by=NULL,schedule_approved=false,schedule_approved_date=NULL,schedule_approved_at=NULL WHERE request_id=$1", [p.id]);
          }
          await client.query("UPDATE requests SET updated_at=clock_timestamp(),version=version+1 WHERE id=$1", [p.id]);
          await s.event(client, { trace_id: req.id }, "admin", "database_request_full_updated", { fields: Object.keys(changes), manual_schedule_override: changes.status === "coordinated" || changes.run_date !== undefined }, p.id);
        });
        return { ok: true };
      });
      admin.patch("/database/:table/:id", async (req) => {
        const p = z.object({ table: databaseTable, id: uuid }).parse(req.params);
        const body = z.object({ changes: z.record(z.string(), z.unknown()) }).parse(req.body);
        const schemas = {
          requests: z.strictObject({
            status: z.enum(["collecting","available","awaiting_approval","waiting_capacity","coordinated","human","cancel_pending","cancelled","closed","rejected"]).optional(),
            run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
            preferred_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "יש להזין שעה בפורמט HH:MM").nullable().optional(),
            represents_both_parties: z.boolean().optional(),
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
          let effectiveStatus: string | undefined, effectiveDate: string | null | undefined;
          if (p.table === "requests") {
            const state = await client.query<{ status: string; run_date: string | null }>("SELECT status,run_date::text FROM requests WHERE id=$1 FOR UPDATE", [p.id]);
            if (!state.rows[0]) throw new AppError("database_record_not_found", 404, "הרשומה לא נמצאה.");
            effectiveStatus = (parsed as { status?: string }).status ?? state.rows[0].status;
            effectiveDate = (parsed as { run_date?: string | null }).run_date === undefined ? state.rows[0].run_date : (parsed as { run_date?: string | null }).run_date;
            if (effectiveDate && !isTuesdayDate(effectiveDate))
              throw new AppError("tuesday_only", 400, "אפשר לשבץ הובלה רק ביום שלישי.");
            if (effectiveDate)
              await client.query("INSERT INTO transport_runs(date,capacity) VALUES($1,10) ON CONFLICT DO NOTHING", [effectiveDate]);
            if (effectiveStatus === "coordinated") {
              if (!effectiveDate) throw new AppError("coordinated_requires_run_date", 400, "יש לבחור תאריך הובלה לפני סימון הפנייה כמתואמת.");
              await client.query("INSERT INTO transport_runs(date,capacity) VALUES($1,10) ON CONFLICT DO NOTHING", [effectiveDate]);
              await client.query("SELECT date FROM transport_runs WHERE date=$1 FOR UPDATE", [effectiveDate]);
              const capacity = await client.query<{ capacity: number; status: string }>("SELECT capacity,status FROM transport_runs WHERE date=$1", [effectiveDate]);
              const booked = await client.query<{ n: number }>("SELECT count(*)::int n FROM requests WHERE id<>$2 AND ((run_date=$1 AND status IN ('coordinated','closed')) OR (proposed_run_date=$1 AND status='awaiting_approval'))", [effectiveDate, p.id]);
              if (capacity.rows[0]?.status !== "open" || booked.rows[0]!.n >= capacity.rows[0]!.capacity)
                throw new AppError("transport_capacity_full", 409, "המכסה לתאריך הזה מלאה או שהסבב סגור.");
            }
          }
          const r = await client.query(
            `UPDATE ${p.table} SET ${assignment}${p.table === "requests" ? ",updated_at=clock_timestamp(),version=version+1" : ""} WHERE id=$${values.length + 1}`,
            [...values, p.id],
          );
          if (!r.rowCount) throw new AppError("database_record_not_found", 404, "הרשומה לא נמצאה.");
          if (p.table === "requests" && fields.some((field) => ["status", "run_date", "preferred_time", "represents_both_parties"].includes(field))) {
            if (fields.some((field) => ["preferred_time", "represents_both_parties"].includes(field)))
              await client.query("UPDATE requests SET proposed_run_date=NULL WHERE id=$1", [p.id]);
            await client.query("UPDATE request_parties SET approved_at=NULL,approved_by=NULL,schedule_approved=false,schedule_approved_date=NULL,schedule_approved_at=NULL WHERE request_id=$1", [p.id]);
            await s.event(client, { trace_id: req.id }, "admin", "admin_manual_schedule_override", { id: p.id, fields, status: effectiveStatus, run_date: effectiveDate, manual_schedule_override: fields.some((field) => ["status", "run_date"].includes(field)) });
          }
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
      admin.post("/database/clear-all", async (req) => {
        assertDestructiveAllowed(req, c);
        z.strictObject({ confirm: z.literal("מחק הכל") }).parse(req.body);
        const s = runtime.requireStore();
        const deleted: Record<string, number> = {};
        await s.transaction(async (client) => {
          const remove = async (table: string, sql: string) => {
            deleted[table] = (await client.query(sql)).rowCount ?? 0;
          };
          await remove("integration_outbox", "DELETE FROM integration_outbox");
          await remove("transport_capacity_approvals", "DELETE FROM transport_capacity_approvals");
          await client.query("UPDATE transport_runs SET capacity=10 WHERE status='open'");
          await remove("request_events", "DELETE FROM request_events");
          await remove("request_verifications", "DELETE FROM request_verifications");
          await remove("outbox", "DELETE FROM outbox");
          await remove("request_media", "DELETE FROM request_media");
          await remove("request_locations", "DELETE FROM request_locations");
          await remove("matches", "DELETE FROM matches");
          await remove("request_parties", "DELETE FROM request_parties");
          await remove("request_items", "DELETE FROM request_items");
          await client.query("UPDATE conversations SET selected_request_id=NULL");
          await remove("requests", "DELETE FROM requests");
          await remove("command_results", "DELETE FROM command_results");
          await client.query("UPDATE messages SET media_id=NULL");
          await remove("media", "DELETE FROM media");
          await client.query("UPDATE messages SET turn_id=NULL");
          await remove("turn_messages", "DELETE FROM turn_messages");
          await remove("conversation_turns", "DELETE FROM conversation_turns");
          await remove("messages", "DELETE FROM messages");
          await remove("conversation_resets", "DELETE FROM conversation_resets");
          await remove("conversations", "DELETE FROM conversations");
          await remove("contact_identities", "DELETE FROM contact_identities");
          await remove("searches", "DELETE FROM searches");
          await remove("contacts", "DELETE FROM contacts");
          await client.query("UPDATE request_counter SET value=0 WHERE id=true");
          await s.event(client, { trace_id: req.id }, "admin", "admin_test_data_cleared", adminAuditRecord(req, "clear_test_data", "test_database", "success", { deleted }));
        });
        runtime.log.warn({ trace_id: req.id, deleted }, "admin_database_cleared");
        return { ok: true, deleted };
      });
      admin.post("/requests/cancel-phone", async (req) => {
        const body = z
          .strictObject({
            phone: z.string().min(3).max(40),
            confirm: z.literal("בטל פניות"),
          })
          .parse(req.body);
        const phone = canonicalPhone(body.phone);
        const s = runtime.requireStore();
        const deleted = await s.purgePhone(phone);
        await s.transaction(async (client) => {
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "admin_phone_requests_purged",
            adminAuditRecord(req, "cancel_phone_requests", `phone:${phone}`, "success", deleted),
          );
        });
        return { ok: true, phone, ...deleted };
      });
      admin.post("/database/clear-phone", async (req) => {
        assertDestructiveAllowed(req, c);
        const body = z
          .strictObject({ phone: z.string().min(3).max(40), confirm: z.literal("מחק מספר") })
          .parse(req.body);
        const phone = canonicalPhone(body.phone);
        const s = runtime.requireStore();
        const deleted: Record<string, number> = {};
        await s.transaction(async (client) => {
          const contactIds = await client.query<{ id: string }>(
            "SELECT id FROM contacts WHERE phone=$1 FOR UPDATE",
            [phone],
          );
          if (!contactIds.rows.length) return;
          const ids = contactIds.rows.map((row) => row.id);
          const requests = await client.query<{ id: string }>(
            "SELECT DISTINCT request_id AS id FROM request_parties WHERE contact_id=ANY($1::uuid[])",
            [ids],
          );
          const conversations = await client.query<{ id: string }>(
            "SELECT id FROM conversations WHERE contact_id=ANY($1::uuid[])",
            [ids],
          );
          const messages = await client.query<{ id: string }>(
            "SELECT id FROM messages WHERE contact_id=ANY($1::uuid[])",
            [ids],
          );
          const requestIds = requests.rows.map((row) => row.id);
          const conversationIds = conversations.rows.map((row) => row.id);
          const messageIds = messages.rows.map((row) => row.id);
          const remove = async (name: string, sql: string, values: unknown[] = []) => {
            deleted[name] = (await client.query(sql, values)).rowCount ?? 0;
          };
          if (requestIds.length) {
            // Drop conversation pointers before deleting requests.
            await client.query(
              "UPDATE conversations SET selected_request_id=NULL WHERE selected_request_id=ANY($1::uuid[])",
              [requestIds],
            );
            await remove("integration_outbox", "DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE request_id=ANY($1::uuid[]))", [requestIds]);
            await remove("request_events", "DELETE FROM request_events WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("request_verifications", "DELETE FROM request_verifications WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("media", "DELETE FROM media WHERE id IN (SELECT media_id FROM request_media WHERE request_id=ANY($1::uuid[]))", [requestIds]);
            await remove("request_media", "DELETE FROM request_media WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("request_locations", "DELETE FROM request_locations WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("matches", "DELETE FROM matches WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("outbox", "DELETE FROM outbox WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("request_parties", "DELETE FROM request_parties WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("request_items", "DELETE FROM request_items WHERE request_id=ANY($1::uuid[])", [requestIds]);
            await remove("requests", "DELETE FROM requests WHERE id=ANY($1::uuid[])", [requestIds]);
          }
          if (messageIds.length) {
            await remove("integration_outbox", "DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE message_id=ANY($1::uuid[]))", [messageIds]);
            await remove("request_events", "DELETE FROM request_events WHERE message_id=ANY($1::uuid[])", [messageIds]);
            await remove("command_results", "DELETE FROM command_results WHERE message_id=ANY($1::uuid[])", [messageIds]);
            await remove("outbox", "DELETE FROM outbox WHERE message_id=ANY($1::uuid[]) OR phone=$2", [messageIds, phone]);
            await remove("media", "DELETE FROM media WHERE message_id=ANY($1::uuid[])", [messageIds]);
            // Detach turn links before deleting messages.
            await client.query(
              "UPDATE messages SET turn_id=NULL, media_id=NULL WHERE id=ANY($1::uuid[])",
              [messageIds],
            );
            await remove("turn_messages", "DELETE FROM turn_messages WHERE message_id=ANY($1::uuid[])", [messageIds]);
            await remove("messages", "DELETE FROM messages WHERE id=ANY($1::uuid[])", [messageIds]);
          } else {
            await remove("outbox", "DELETE FROM outbox WHERE phone=$1", [phone]);
          }
          if (conversationIds.length) {
            await remove("conversation_resets", "DELETE FROM conversation_resets WHERE conversation_id=ANY($1::uuid[])", [conversationIds]);
            await remove("turn_messages", "DELETE FROM turn_messages WHERE turn_id IN (SELECT id FROM conversation_turns WHERE conversation_id=ANY($1::uuid[]))", [conversationIds]);
            await remove("conversation_turns", "DELETE FROM conversation_turns WHERE conversation_id=ANY($1::uuid[])", [conversationIds]);
            await remove("conversations", "DELETE FROM conversations WHERE id=ANY($1::uuid[])", [conversationIds]);
          }
          await remove("contact_identities", "DELETE FROM contact_identities WHERE contact_id=ANY($1::uuid[])", [ids]);
          await remove("searches", "DELETE FROM searches WHERE contact_id=ANY($1::uuid[])", [ids]);
          await remove("contacts", "DELETE FROM contacts WHERE id=ANY($1::uuid[])", [ids]);
          // Audit after wipe — do not attach to deleted contact/message rows.
          await s.event(client, { trace_id: req.id }, "admin", "admin_test_phone_data_cleared", adminAuditRecord(req, "clear_test_phone_data", `phone:${phone}`, "success", { deleted }));
        });
        runtime.log.warn({ trace_id: req.id, phone, deleted }, "admin_phone_data_cleared");
        return { ok: true, phone, deleted };
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
          await s.event(client, { trace_id: req.id }, "admin", "bot_access_changed", adminAuditRecord(req, "update_bot_access", "bot_access", "success", access));
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
          await s.event(client, { trace_id: req.id }, "admin", "conversation_reset", adminAuditRecord(req, "reset_conversation", `phone:${phone}`, "success", { phone, conversations: conversations.rowCount }));
        });
        return { ok: true, phone };
      });
      admin.post("/conversations/:phone/release-queue", async (req) => {
        const phone = canonicalPhone(
            z.object({ phone: z.string() }).parse(req.params).phone,
          ),
          s = runtime.requireStore();
        const released = await s.queue.releaseSingleton("conversation", phone, ["failed"]);
        await s.transaction(async (client) => {
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "conversation_queue_released",
            adminAuditRecord(req, "release_conversation_queue", `phone:${phone}`, "success", { phone, released }),
          );
        });
        return { ok: true, phone, released };
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
          await s.event(client, { trace_id: req.id }, "admin", "all_conversations_reset", adminAuditRecord(req, "reset_all_conversations", "all_conversations", "success", { conversations: result.rowCount }));
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
      admin.get("/database/requests/:id/media", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params), s = runtime.requireStore();
        const rows = await s.pool.query(
          `SELECT m.id,m.mime_type,m.size_bytes,m.created_at::text AS created_at
             FROM request_media rm JOIN media m ON m.id=rm.media_id
            WHERE rm.request_id=$1 ORDER BY m.created_at`,
          [p.id],
        );
        return { ok: true, rows: rows.rows.map((x) => ({ ...x, url: `/admin/media/${x.id}` })) };
      });
      admin.get("/database/requests/:id/locations", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params), s = runtime.requireStore();
        const rows = await s.pool.query(
          `SELECT role,latitude,longitude,captured_at::text AS captured_at
             FROM request_locations WHERE request_id=$1 ORDER BY role`,
          [p.id],
        );
        return { ok: true, rows: rows.rows };
      });
      admin.get("/database/conversations/:id/messages", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params), s = runtime.requireStore();
        const rows = await s.pool.query(
          `SELECT id,seq,kind,text,reply,location,media_id,received_at::text AS received_at
             FROM messages WHERE conversation_id=$1 ORDER BY seq`,
          [p.id],
        );
        return { ok: true, rows: rows.rows.map((x) => ({ ...x, media_url: x.media_id ? `/admin/media/${x.media_id}` : null })) };
      });
      admin.get("/database/phone/:phone/messages", async (req) => {
        const p = z.object({ phone: z.string() }).parse(req.params), phone = canonicalPhone(p.phone), s = runtime.requireStore();
        const rows = await s.pool.query(
          `SELECT m.id,m.seq,m.kind,m.text,m.reply,m.location,m.media_id,m.received_at::text AS received_at
             FROM messages m JOIN contacts c ON c.id=m.contact_id
            WHERE c.phone=$1 ORDER BY m.seq`,
          [phone],
        );
        return { ok: true, phone, rows: rows.rows.map((x) => ({ ...x, media_url: x.media_id ? `/admin/media/${x.media_id}` : null })) };
      });
      admin.post("/conversations/:phone/send", async (req) => {
        const p = z.object({ phone: z.string() }).parse(req.params);
        const b = z.strictObject({ text: z.string().trim().min(1).max(16000) }).parse(req.body);
        const phone = canonicalPhone(p.phone), s = runtime.requireStore(), trace_id = randomUUID();
        return s.transaction(async (client) => {
          const outbox_id = await s.outbound(
            client,
            { trace_id, mode: c.BOT_MODE, phone },
            { phone, text: b.text },
            `admin-direct:${phone}:${trace_id}`,
          );
          await s.event(
            client,
            { trace_id },
            "admin",
            "admin_mutation",
            adminAuditRecord(req, "send_admin_message", `phone:${phone}`, "success", { outbox_id }),
          );
          return { ok: true, outbox_id };
        });
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
          await simulation.requireStore().transaction((client) =>
            simulation.requireStore().event(
              client,
              { trace_id: req.id },
              "admin",
              "admin_mutation",
              adminAuditRecord(req, "simulate_message", `simulation:${result.id}`, "success", { message_id: result.id }),
            ),
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
            adminAuditRecord(req, "resume_request", `request:${r.id}`, "success", { reason: b.reason }),
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
            adminAuditRecord(req, "resume_conversation", `phone:${phone}`, "success", { phone, reason: b.reason }),
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
            adminAuditRecord(req, "coordinate_request", `request:${r.id}`, "success", { date: r.run_date, reason: b.reason }),
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
            adminAuditRecord(req, "complete_request", `request:${r.id}`, "success", { reason: b.reason }),
            r.id,
          );
          return { ok: true, request: r };
        });
      });
      admin.post("/transport-runs/:date/capacity", async (req) => {
        const p = z.object({ date: z.iso.date() }).parse(req.params),
          b = z
            .strictObject({
              capacity: z.number().int().min(1).max(MAX_TRANSPORT_CAPACITY),
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
            `SELECT count(*)::int n FROM requests
             WHERE (run_date=$1 AND status IN ('coordinated','closed'))
                OR (proposed_run_date=$1 AND status='awaiting_approval')`,
            [p.date],
          );
          if (used.rows[0]!.n > b.capacity)
            throw new AppError("capacity_below_bookings", 409);
          await client.query(
            "UPDATE transport_runs SET capacity=$2 WHERE date=$1",
            [p.date, b.capacity],
          );
          await client.query(
            `UPDATE transport_capacity_approvals SET status='approved',resolved_at=clock_timestamp(),resolved_by=$2
             WHERE run_date=$1 AND status='pending' AND requested_capacity<=$3`,
            [p.date, "admin-ui", b.capacity],
          );
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "capacity_changed",
            adminAuditRecord(req, "change_transport_capacity", `transport:${p.date}`, "success", { date: p.date, ...b }),
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
            adminAuditRecord(req, "change_location_policy", `location:${b.name}`, "success", b),
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
              "UPDATE outbox SET state='pending',delivery_state='failed',error_code=NULL WHERE id=$1",
              [p.id],
            );
            await s.queue.boss.retry("send", out.job_id, {
              db: { executeSql: (text, values) => client.query(text, values) },
            });
          } else {
            await client.query(
              "UPDATE outbox SET state=$2,delivery_state=$4,provider_id=$3,sent_at=clock_timestamp(),delivered_at=CASE WHEN $4='delivered' THEN clock_timestamp() ELSE delivered_at END WHERE id=$1",
              [
                p.id,
                b.outcome === "delivered" ? "sent" : "cancelled",
                b.provider_id,
                b.outcome === "delivered" ? "delivered" : "failed",
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
            adminAuditRecord(req, "resolve_outbox", `outbox:${p.id}`, "success", { outbox_id: p.id, ...b }),
          );
        });
        return { ok: true };
      });
      admin.post("/outbox/:id/receipt", async (req) => {
        const p = z.object({ id: uuid }).parse(req.params),
          b = z.strictObject({
            state: z.enum(["accepted", "delivered", "read", "failed", "uncertain"]),
            provider_id: z.string().max(300).nullable(),
          }).parse(req.body),
          s = runtime.requireStore();
        await s.transaction(async (client) => {
          const current = await client.query<{ delivery_state: string }>(
            "SELECT delivery_state FROM outbox WHERE id=$1 FOR UPDATE",
            [p.id],
          );
          if (!current.rows[0]) throw new AppError("outbox_not_found", 404);
          const rank: Record<string, number> = {
            queued: 0, uncertain: 1, failed: 1, accepted: 2, delivered: 3, read: 4,
          };
          if (rank[b.state]! < rank[current.rows[0].delivery_state]!) return;
          await client.query(
            `UPDATE outbox SET delivery_state=$2,provider_id=COALESCE($3,provider_id),
               provider_accepted_at=CASE WHEN $2 IN ('accepted','delivered','read') THEN COALESCE(provider_accepted_at,clock_timestamp()) ELSE provider_accepted_at END,
               delivered_at=CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at,clock_timestamp()) ELSE delivered_at END,
               read_at=CASE WHEN $2='read' THEN COALESCE(read_at,clock_timestamp()) ELSE read_at END,
               error_code=CASE WHEN $2='failed' THEN error_code ELSE NULL END
             WHERE id=$1`,
            [p.id, b.state, b.provider_id],
          );
          await s.event(
            client,
            { trace_id: req.id },
            "admin",
            "outbox_receipt",
            adminAuditRecord(req, "record_outbox_receipt", `outbox:${p.id}`, "success", { outbox_id: p.id, ...b }),
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
          await s.event(client, { trace_id: req.id }, "admin", "job_retried", adminAuditRecord(req, "retry_job", `job:${p.queue}:${p.id}`, "success", { queue: p.queue, job_id: p.id, reason: b.reason }));
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
