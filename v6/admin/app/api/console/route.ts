import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { dbError } from "@/lib/db";
import {
  cancelPhone,
  clearAll,
  clearPhone,
  deleteRow,
  listTableChoices,
  loadTable,
  overview,
  requestFiles,
  resetAll,
  resetOne,
  sendDirect,
  setAccess,
  simulate,
  thread,
  updateRow,
  wahaQr,
  wahaReconnect,
  wahaStatus,
} from "@/lib/console";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function gate() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: { message: "יש להזין סיסמת ניהול" } }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request) {
  const denied = await gate();
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const table = url.searchParams.get("table");
    if (table) return NextResponse.json(await loadTable(table));
    return NextResponse.json({ ...(await overview()), tables: await listTableChoices() });
  } catch (error) {
    return NextResponse.json({ error: { message: dbError(error) } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await gate();
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: { message: "חסרה פעולה" } }, { status: 400 });
  }
  try {
    const action = body.action;
    if (action === "access") {
      await setAccess(String(body.mode ?? ""), Array.isArray(body.phones) ? body.phones.map(String) : []);
    } else if (action === "reset-one") await resetOne(String(body.phone ?? ""));
    else if (action === "reset-all") await resetAll();
    else if (action === "cancel-phone") await cancelPhone(String(body.phone ?? ""), String(body.confirm ?? ""));
    else if (action === "clear-phone") await clearPhone(String(body.phone ?? ""), String(body.confirm ?? ""));
    else if (action === "clear-all") await clearAll(String(body.confirm ?? ""));
    else if (action === "simulate") {
      const reply = await simulate(String(body.phone ?? ""), String(body.text ?? ""));
      return NextResponse.json({ ok: true, reply });
    } else if (action === "waha-status") return NextResponse.json({ ok: true, ...(await wahaStatus(String(body.session ?? ""))) });
    else if (action === "waha-reconnect") return NextResponse.json({ ok: true, ...(await wahaReconnect(String(body.session ?? ""))) });
    else if (action === "waha-qr") return NextResponse.json({ ok: true, ...(await wahaQr(String(body.session ?? ""))) });
    else if (action === "thread") return NextResponse.json({ ok: true, ...(await thread(String(body.phone ?? ""))) });
    else if (action === "files") return NextResponse.json({ ok: true, ...(await requestFiles(String(body.id ?? ""))) });
    else if (action === "send") await sendDirect(String(body.phone ?? ""), String(body.text ?? ""));
    else if (action === "update-row") {
      await updateRow(String(body.table ?? ""), (body.keys ?? {}) as Record<string, unknown>, (body.changes ?? {}) as Record<string, unknown>);
    } else if (action === "delete-row") {
      await deleteRow(String(body.table ?? ""), (body.keys ?? {}) as Record<string, unknown>);
    } else return NextResponse.json({ error: { message: "פעולה לא מוכרת" } }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : dbError(error);
    return NextResponse.json({ error: { message } }, { status: 400 });
  }
}
