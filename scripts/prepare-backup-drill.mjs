import pg from "pg";

const target = new URL(process.env.BACKUP_DRILL_TARGET_URL);
const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
target.pathname = "/postgres";
target.searchParams.set("application_name", "haim-qa-backup-restore-admin");
const client = new pg.Client({ connectionString: target.toString() });
await client.connect();
try {
  await client.query(`CREATE DATABASE "${database.replace(/"/g, "")}"`);
} catch (error) {
  if (error.code !== "42P04") throw error;
} finally {
  await client.end();
}
