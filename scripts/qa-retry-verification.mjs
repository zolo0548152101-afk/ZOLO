const response = await fetch(
  "http://127.0.0.1:3000/admin/outbox/ab546e3c-e5b9-4780-a153-1d7b391b0dc4/resolve",
  {
    method: "POST",
    headers: {
      "x-admin-token": process.env.HAIM_ADMIN_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      outcome: "not_delivered",
      provider_id: null,
      reason: "live_allowlist_removed_retry_verification",
    }),
  },
);
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
