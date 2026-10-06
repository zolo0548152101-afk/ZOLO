import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { COOKIE, sessionToken } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { password?: string } | null;
  const password = body?.password ?? "";
  const expected = process.env.ADMIN_PASSWORD ?? "";
  const got = Buffer.from(sessionToken(password || " "));
  const want = Buffer.from(sessionToken(expected || "\0"));
  if (!expected || !timingSafeEqual(got, want)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, sessionToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return response;
}
