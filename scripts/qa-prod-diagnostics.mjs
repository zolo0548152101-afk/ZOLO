import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`SET search_path TO ${process.env.DB_SCHEMA}`);
const result = await pool.query(`
  SELECT o.id,o.job_id,o.seq,o.phone,o.state,o.error_code,o.text,o.created_at,
         r.number AS request_number
    FROM outbox o
    LEFT JOIN requests r ON r.id=o.request_id
   ORDER BY o.seq DESC
   LIMIT 30
`);
console.log(JSON.stringify(result.rows, null, 2));
const job = await pool.query(
  "SELECT id,state,retry_count,start_after,created_on,completed_on,output FROM haim_core_jobs.job WHERE id=$1",
  ["83962a41-8a7a-4ef5-aba6-4738642162f0"],
);
console.log(JSON.stringify({ verification_job: job.rows[0] ?? null }, null, 2));
const sendJobs = await pool.query(
  "SELECT id,name,state,singleton_key,retry_count,start_after,created_on,completed_on FROM haim_core_jobs.job WHERE name='send' ORDER BY created_on DESC LIMIT 20",
);
console.log(JSON.stringify({ send_jobs: sendJobs.rows }, null, 2));
await pool.end();
