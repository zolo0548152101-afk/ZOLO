import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const COOKIE = "haim_admin";

export function sessionToken(password = process.env.ADMIN_PASSWORD): string {
  if (!password) throw new Error("ADMIN_PASSWORD is not set");
  return createHmac("sha256", password).update("haim-v6-admin").digest("hex");
}

export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  const got = jar.get(COOKIE)?.value ?? "";
  const want = sessionToken();
  if (got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export async function requireUser(): Promise<void> {
  if (!(await isAuthed())) redirect("/login");
}
