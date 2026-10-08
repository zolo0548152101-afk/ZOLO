import { neon } from "@neondatabase/serverless";

export function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("postgres")) {
    throw new Error("DATABASE_URL is missing or invalid");
  }
  return neon(url);
}

export type ClusterRow = {
  ashkol: string;
  settlement_name: string;
  settlement_code: string;
  bzb: number;
  voters: number;
  valid: number;
  right_votes: number;
  turnout_pct: number;
  right_pct: number;
  ballot_count: number;
  lat: number | null;
  lng: number | null;
};
