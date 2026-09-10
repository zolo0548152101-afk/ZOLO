// Read-only health checks + isolated simulation. No webhook changes or WhatsApp sends.
const base = (process.env.BOT_BASE_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const token = process.env.HAIM_ADMIN_TOKEN;
if (!token) throw new Error("HAIM_ADMIN_TOKEN is required");
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "x-admin-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(path + ": " + (data.error?.code ?? response.status));
  return data;
}
for (const path of ["/health", "/ready"]) {
  const result = await request(path);
  console.log(
    JSON.stringify({ check: path, ok: result.ok, mode: result.mode }),
  );
}
const accepted = await request("/admin/simulate", {
  phone: "0500000001",
  text: "שלום",
});
let done = false;
for (let i = 0; i < 30; i++) {
  const result = await request(accepted.result_url);
  if (
    result.message.processed_at &&
    result.outbox.length &&
    result.outbox.every((x) => x.state === "simulation")
  ) {
    if (result.requests.length !== 0)
      throw new Error("greeting_created_request");
    console.log(
      JSON.stringify({
        check: "isolated_greeting",
        ok: true,
        mode: "simulation",
        id: accepted.id,
      }),
    );
    done = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!done) throw new Error("simulation_did_not_complete_in_30_seconds");
