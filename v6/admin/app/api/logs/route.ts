import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { loadLogs } from "@/lib/logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const rows = await loadLogs({
    phone: url.searchParams.get("phone") ?? "",
    level: url.searchParams.get("level") ?? "",
    event: url.searchParams.get("event") ?? "",
    from: url.searchParams.get("from") ?? "",
    to: url.searchParams.get("to") ?? "",
    conversation: url.searchParams.get("conversation") ?? "",
  });
  return NextResponse.json(rows);
}
