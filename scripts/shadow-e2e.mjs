// Four isolated admin simulations. The endpoint is simulation-only and never
// reaches WAHA. The script refuses a live base URL or a missing explicit opt-in.
const base = (process.env.BOT_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const token = process.env.HAIM_ADMIN_TOKEN;
if (process.env.RUN_SHADOW_E2E !== "true" || !token)
  throw new Error("Set RUN_SHADOW_E2E=true and HAIM_ADMIN_TOKEN for local shadow E2E");
if (process.env.BOT_MODE === "live" || /easypanel|waha/i.test(base))
  throw new Error("shadow_e2e_refuses_live_or_remote_target");
async function api(path, options = {}) {
  const r = await fetch(base + path, { ...options, headers: { "x-admin-token": token, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(10000) });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}:${data.error?.code ?? r.status}`);
  return data;
}
const cases = [
  ["500000101", "אני רוצה למסור מיטה"],
  ["500000102", "אני מחפש מקרר"],
  ["500000103", "יש לי כיסא למסירה"],
  ["500000104", "אני רוצה לדבר עם אדם"],
];
const evidence = [];
for (const [phone, text] of cases) {
  const accepted = await api("/admin/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, text }) });
  let result;
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await api(accepted.result_url);
    if (result.message?.processed_at) break;
  }
  if (!result?.message?.processed_at) throw new Error(`shadow_case_timeout:${phone}`);
  evidence.push({ phone, processed: true, request_count: result.requests?.length ?? 0, outbox_states: (result.outbox ?? []).map((x) => x.state) });
}
if (evidence.some((x) => x.outbox_states.some((s) => s === "sent"))) throw new Error("shadow_e2e_live_send_detected");
console.log(JSON.stringify({ mode: "shadow", cases: evidence }, null, 2));
