import { Pool, type QueryResultRow } from "pg";

const globalForPg = globalThis as unknown as { haimPool?: Pool };

export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!globalForPg.haimPool) {
    globalForPg.haimPool = new Pool({ connectionString: url, max: 4 });
  }
  return globalForPg.haimPool;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export function dbError(error: unknown): string {
  if (error && typeof error === "object") {
    const row = error as { detail?: string; message?: string };
    if (row.detail) return row.detail;
    if (row.message) return row.message;
  }
  return "הפעולה נכשלה";
}
