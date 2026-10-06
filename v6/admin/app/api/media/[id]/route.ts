import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { mediaPayload } from "@/lib/console";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: { message: "יש להזין סיסמת ניהול" } }, { status: 401 });
  }
  const { id } = await context.params;
  const result = await mediaPayload(id);
  if ("error" in result) {
    return NextResponse.json({ error: { message: result.error } }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(result.bytes), {
    headers: {
      "content-type": result.type,
      "cache-control": "private, no-store",
      "content-disposition": 'attachment; filename="image"',
    },
  });
}
