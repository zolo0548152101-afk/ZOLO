"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "./auth";
import { dbError, query } from "./db";

export type ActionResult = { ok: true; detail?: string } | { ok: false; error: string };

async function call(sql: string, params: unknown[]): Promise<ActionResult> {
  await requireUser();
  try {
    const rows = await query<{ result: unknown }>(sql, params);
    revalidatePath("/", "layout");
    return { ok: true, detail: JSON.stringify(rows[0]?.result ?? {}) };
  } catch (error) {
    return { ok: false, error: dbError(error) };
  }
}

export async function cancelPhone(phone: string, confirm: string): Promise<ActionResult> {
  return call("SELECT public.haim_cancel_phone($1, $2) AS result", [phone, confirm]);
}

export async function resetPhone(phone: string): Promise<ActionResult> {
  return call("SELECT public.haim_reset($1) AS result", [phone]);
}

export async function clearAll(confirm: string): Promise<ActionResult> {
  return call("SELECT public.haim_clear_all($1) AS result", [confirm]);
}

export async function setAccess(mode: string, phonesText: string): Promise<ActionResult> {
  const phones = phonesText
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return call("SELECT public.haim_set_access($1, $2::jsonb) AS result", [
    mode,
    JSON.stringify(phones),
  ]);
}
