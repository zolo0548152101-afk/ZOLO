import { readConfig } from "../config.js";
import { migrate } from "./migrate.js";
import { Queue } from "../infrastructure/queue.js";
const log = { info: () => {}, warn: () => {}, error: () => {} };
try {
  const c = readConfig();
  const targets =
    c.ENABLE_SIMULATE && c.DB_SCHEMA !== "haim_core_sim"
      ? [
          c,
          {
            ...c,
            DB_SCHEMA: "haim_core_sim" as const,
            BOT_MODE: "simulation" as const,
          },
        ]
      : [c];
  for (const config of targets) {
    await migrate(config);
    const q = new Queue(config, log, true);
    try {
      await q.start(true);
    } finally {
      await q.stop();
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      migrations: "applied",
      schemas: targets.map((t) => t.DB_SCHEMA),
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      ok: false,
      code: "migration_failed",
      action: "check DB permissions, connectivity and migration checksums",
    }),
  );
  process.exitCode = 1;
}
