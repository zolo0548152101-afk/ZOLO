#!/usr/bin/env python3
"""Live WAHA tests from session default (0584152101) → bot 0543414386.

Rules (owner):
- Only real sendText from WORKING default session
- No webhook inject / simulate / internal container hacks
- Full Israel-time transcript + Postgres rows
- Stop on first wrong reply
"""
from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

ENV = {}
for line in open("/root/haim-bot.env"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    ENV[k] = v.strip().strip('"')

WAHA = "http://127.0.0.1:3001"
BOT = "http://127.0.0.1:3010"
API_KEY = ENV["WAHA_API_KEY"]
ADMIN = ENV["HAIM_ADMIN_TOKEN"]
SESSION = "default"
BOT_CHAT_CUS = "972543414386@c.us"
BOT_CHAT = BOT_CHAT_CUS  # resolved to LID when available (WEBJS)
EXPECTED_ME = "972584152101@c.us"
ISRAEL = "584152101"
TZ = ZoneInfo("Asia/Jerusalem")

report = {
    "started_at": datetime.now(TZ).isoformat(),
    "flows": [],
    "ok": True,
    "stopped_reason": None,
    "bot_chat_resolved": None,
}


def http_json(method: str, url: str, body=None, headers=None, timeout=90):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    hdrs = dict(headers or {})
    if data is not None:
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            parsed = json.loads(raw) if raw else raw
        except Exception:
            parsed = raw
        return e.code, parsed


def require_sender_session():
    code, sessions = http_json(
        "GET", f"{WAHA}/api/sessions?all=true", headers={"X-Api-Key": API_KEY}
    )
    if code != 200:
        raise SystemExit(f"STOP: sessions HTTP {code}: {sessions}")
    default = next((s for s in sessions if s.get("name") == SESSION), None)
    if not default:
        raise SystemExit("STOP: session default missing")
    me = (default.get("me") or {}).get("id")
    status = default.get("status")
    print(f"SESSION {SESSION} status={status} me={me}", flush=True)
    if status != "WORKING" or me != EXPECTED_ME:
        raise SystemExit(
            f"STOP: session {SESSION} must be WORKING with me={EXPECTED_ME}, got status={status} me={me}"
        )
    tal = next((s for s in sessions if s.get("name") == "TAL_ZOLO"), None)
    if tal:
        print(
            f"SESSION TAL_ZOLO status={tal.get('status')} me={(tal.get('me') or {}).get('id')}",
            flush=True,
        )
    return default


def resolve_bot_chat() -> str:
    """WEBJS often stores the bot under @lid; @c.us message fetch can 500."""
    global BOT_CHAT
    code, overview = http_json(
        "GET",
        f"{WAHA}/api/{SESSION}/chats/overview?limit=50",
        headers={"X-Api-Key": API_KEY},
    )
    if code != 200:
        raise SystemExit(f"STOP: chats overview HTTP {code}: {overview}")
    found = None
    for c in overview or []:
        cid = c.get("id") or ""
        name = c.get("name") or ""
        last = ((c.get("lastMessage") or {}).get("to") or "") + " " + (
            (c.get("lastMessage") or {}).get("from") or ""
        )
        if BOT_CHAT_CUS in cid or "543414386" in cid:
            found = cid
            break
        if "חיים" in name and ("יחד" in name or "@lid" in cid):
            found = cid
            break
        if BOT_CHAT_CUS in last or "543414386" in last:
            found = cid
            break
    if not found:
        # fallback: keep c.us for send; reading may still use overview poll
        found = BOT_CHAT_CUS
    BOT_CHAT = found
    report["bot_chat_resolved"] = found
    print(f"BOT_CHAT resolved={found}", flush=True)
    return found


def admin_clear_all():
    code, body = http_json(
        "POST",
        f"{BOT}/admin/database/clear-all",
        {"confirm": "מחק הכל"},
        {"x-admin-token": ADMIN},
    )
    print(f"admin clear-all HTTP {code}: {body}", flush=True)
    if code >= 300:
        raise SystemExit(f"STOP: clear-all failed {code} {body}")
    return body


def admin_reset_phone(phone: str):
    code, body = http_json(
        "POST",
        f"{BOT}/admin/conversations/{urllib.parse.quote(phone)}/reset",
        None,
        {"x-admin-token": ADMIN},
    )
    print(f"admin reset HTTP {code}: {body}", flush=True)
    return code, body


def admin_cancel_phone(phone: str):
    code, body = http_json(
        "POST",
        f"{BOT}/admin/requests/cancel-phone",
        {"phone": phone, "confirm": "בטל פניות"},
        {"x-admin-token": ADMIN},
    )
    print(f"admin cancel-phone HTTP {code}: {body}", flush=True)
    return code, body


def admin_prep():
    """Owner: cancel-phone + reset + clear_all (do not delete WhatsApp chat)."""
    require_sender_session()
    admin_cancel_phone(ISRAEL)
    admin_reset_phone(ISRAEL)
    admin_clear_all()


def send_text(text: str):
    require_sender_session()
    # Always send to canonical @c.us (WAHA resolves); chat read uses LID.
    code, body = http_json(
        "POST",
        f"{WAHA}/api/sendText",
        {"session": SESSION, "chatId": BOT_CHAT_CUS, "text": text},
        {"X-Api-Key": API_KEY},
    )
    print(f"sendText HTTP {code}", flush=True)
    if code >= 300:
        print(f"sendText ERROR BODY: {json.dumps(body, ensure_ascii=False)}", flush=True)
        raise SystemExit(f"STOP: sendText failed HTTP {code}")
    return body


def chat_messages(limit=40):
    chat = BOT_CHAT or resolve_bot_chat()
    # Prefer session-scoped path with resolved LID
    code, body = http_json(
        "GET",
        f"{WAHA}/api/{SESSION}/chats/{urllib.parse.quote(chat, safe='@')}/messages?limit={limit}",
        headers={"X-Api-Key": API_KEY},
    )
    if code == 200:
        return body or []
    # Fallback query API
    code2, body2 = http_json(
        "GET",
        f"{WAHA}/api/messages?session={SESSION}&chatId={urllib.parse.quote(chat, safe='@')}&limit={limit}",
        headers={"X-Api-Key": API_KEY},
    )
    if code2 == 200:
        return body2 or []
    raise SystemExit(f"STOP: get messages HTTP {code}/{code2}: {body} / {body2}")


def fmt_ts(ts: int | float | None) -> str:
    if not ts:
        return "??:??:??"
    return datetime.fromtimestamp(int(ts), TZ).strftime("%H:%M:%S")


def wait_bot_reply(after_ts: float, seen_ids: set | None = None, timeout=90) -> dict | None:
    deadline = time.time() + timeout
    seen = seen_ids or set()
    while time.time() < deadline:
        msgs = chat_messages(50)
        candidates = []
        for m in msgs:
            if m.get("fromMe"):
                continue
            mid = str(m.get("id") or "")
            if mid and mid in seen:
                continue
            t = float(m.get("timestamp") or 0)
            if t < after_ts - 2:
                continue
            body = (m.get("body") or "").strip()
            if body:
                candidates.append(m)
        if candidates:
            # newest bot reply after our send
            candidates.sort(key=lambda x: float(x.get("timestamp") or 0))
            return candidates[-1]
        time.sleep(2)
    return None


def db(sql: str) -> str:
    url = urllib.parse.urlparse(ENV["DATABASE_URL"])
    cid = (
        subprocess.check_output(["docker", "ps", "-qf", "name=whatsapp_haim-db"], text=True)
        .strip()
        .split("\n")[0]
    )
    return subprocess.check_output(
        [
            "docker",
            "exec",
            "-e",
            f"PGPASSWORD={url.password}",
            "-e",
            "PGOPTIONS=-c search_path=haim_core",
            cid,
            "psql",
            "-U",
            url.username,
            "-d",
            url.path.lstrip("/"),
            "-At",
            "-F",
            "|",
            "-c",
            sql,
        ],
        text=True,
    ).strip()


def db_snapshot():
    return {
        "requests": db(
            "SELECT number,status,origin,verification_contacted::text,"
            "coalesce(human_reason,''),represents_both_parties::text "
            "FROM requests ORDER BY number"
        ),
        "items": db(
            "SELECT r.number,i.kind,i.description,i.quantity,i.free::text,i.working::text "
            "FROM request_items i JOIN requests r ON r.id=i.request_id ORDER BY r.number"
        ),
        "parties": db(
            "SELECT r.number,p.role,c.phone,coalesce(p.name,''),coalesce(p.settlement,''),"
            "coalesce(p.address,''),coalesce(p.floor::text,''),(p.approved_at IS NOT NULL)::text "
            "FROM request_parties p JOIN contacts c ON c.id=p.contact_id "
            "JOIN requests r ON r.id=p.request_id ORDER BY r.number,p.role"
        ),
        "events": db(
            "SELECT r.number,e.event_type,e.actor FROM request_events e "
            "JOIN requests r ON r.id=e.request_id ORDER BY e.created_at"
        ),
        "verifications": db(
            "SELECT r.number,v.role,v.state,coalesce(v.last_error,'') "
            "FROM request_verifications v JOIN requests r ON r.id=v.request_id ORDER BY r.number"
        ),
        "conversation": db(
            "SELECT c.phone,conv.mode,coalesce(r.number::text,''),"
            "coalesce(conv.pending_counterparty_name,''),coalesce(conv.pending_counterparty_phone,'') "
            "FROM conversations conv JOIN contacts c ON c.id=conv.contact_id "
            "LEFT JOIN requests r ON r.id=conv.selected_request_id "
            "WHERE c.phone LIKE '%584152101'"
        ),
        "messages": db(
            "SELECT to_char(m.received_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS'),"
            "left(coalesce(m.text,''),120), left(coalesce(m.reply,''),160) "
            "FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id "
            "WHERE c.phone LIKE '%584152101' OR m.chat_id LIKE '%584152101%' "
            "ORDER BY m.seq"
        ),
        "request_ids": db("SELECT id::text||'|'||number::text FROM requests ORDER BY number"),
    }


def print_transcript(lines: list[dict]):
    print("\n----- תמליל מלא -----", flush=True)
    for row in lines:
        who = "אני" if row["who"] == "me" else "בוט"
        print(f"[{row['time']}] {who}: {row['text']}", flush=True)
    print("----- סוף תמליל -----\n", flush=True)


def print_db(snap: dict):
    print("----- PostgreSQL -----", flush=True)
    for k in ("requests", "items", "parties", "events", "verifications", "conversation", "messages", "request_ids"):
        print(f"{k}:", snap.get(k) or "(none)", flush=True)
    print("----- סוף DB -----\n", flush=True)


def step(flow: dict, text: str, expect=None) -> str:
    """Send one message, wait for bot reply, append transcript. expect: callable(reply)->(ok,reason)."""
    seen = flow.setdefault("seen_ids", set())
    before = time.time()
    send_text(text)
    flow["transcript"].append(
        {"who": "me", "time": datetime.now(TZ).strftime("%H:%M:%S"), "text": text, "ts": before}
    )
    reply_msg = wait_bot_reply(before, seen_ids=seen)
    if not reply_msg:
        flow["transcript"].append(
            {"who": "bot", "time": datetime.now(TZ).strftime("%H:%M:%S"), "text": "(אין תשובה)", "ts": time.time()}
        )
        print_transcript(flow["transcript"])
        print_db(db_snapshot())
        report["ok"] = False
        report["stopped_reason"] = f"no bot reply after: {text}"
        raise SystemExit("STOP: no bot reply")
    mid = str(reply_msg.get("id") or "")
    if mid:
        seen.add(mid)
    reply = (reply_msg.get("body") or "").strip()
    flow["transcript"].append(
        {
            "who": "bot",
            "time": fmt_ts(reply_msg.get("timestamp")),
            "text": reply,
            "ts": float(reply_msg.get("timestamp") or time.time()),
        }
    )
    print(f"<<< {reply}", flush=True)
    if expect:
        ok, reason = expect(reply)
        if not ok:
            print_transcript(flow["transcript"])
            print_db(db_snapshot())
            report["ok"] = False
            report["stopped_reason"] = reason
            raise SystemExit(f"STOP: wrong reply — {reason}")
    return reply


def run_flow_contact_after_details():
    flow = {"name": "contact_after_details", "transcript": [], "db_final": None}
    print("\n######## FLOW: contact after details ########", flush=True)
    require_sender_session()
    admin_prep()
    time.sleep(2)

    def no_early_contact(r: str):
        if "אפנה" in r:
            return False, "invented אפנה"
        if "האם תרצה שנפנה" in r:
            return False, "asked contact before own details"
        if "נפנה לצד השני עכשיו" in r:
            return False, "contacted now too early"
        return True, "ok"

    step(
        flow,
        "יש לי מיטה תקינה למסירה לטל 0536662043",
        no_early_contact,
    )
    step(flow, "בית שאן", no_early_contact)
    step(
        flow,
        "ישראל רחוב אילת 4",
        lambda r: (
            ("האם תרצה שנפנה" in r or "נפנה" in r or "פרטים" in r) and "אפנה" not in r,
            "expected contact ask after details, no אפנה",
        ),
    )
    snap = db_snapshot()
    flow["db_final"] = snap
    # verification must still be false
    if "true" in (snap["requests"] or "").split("|")[3:4]:
        # requests: number|status|origin|verification_contacted|...
        parts = (snap["requests"] or "").split("|")
        if len(parts) >= 4 and parts[3].lower() in ("t", "true"):
            print_transcript(flow["transcript"])
            print_db(snap)
            raise SystemExit("STOP: verification_contacted true too early")
    print_transcript(flow["transcript"])
    print_db(snap)
    report["flows"].append(flow)
    return flow


def run_flow_outside_reuse():
    flow = {"name": "outside_area_reuse", "transcript": [], "db_final": None}
    print("\n######## FLOW: outside-area same request ########", flush=True)
    require_sender_session()
    admin_prep()
    time.sleep(2)

    step(
        flow,
        "יש לי ספה למסירה לטל 0536662043",
        lambda r: ("אפנה" not in r and "האם תרצה שנפנה" not in r, "no early contact"),
    )
    before_ids = db("SELECT id::text||'|'||number::text FROM requests ORDER BY number")
    step(
        flow,
        "טבריה רחוב הגליל 1",
        lambda r: ("לא נוכל" in r or "בית שאן" in r, "expected outside rejection"),
    )
    mid = db_snapshot()
    if "rejected" not in (mid["requests"] or ""):
        print_transcript(flow["transcript"])
        print_db(mid)
        raise SystemExit("STOP: expected rejected status")
    step(
        flow,
        "אני רוצה למסור את הספה בבית שאן רחוב אילת 4, השם ישראל",
        lambda r: ("אפנה" not in r, "no invented אפנה after correction"),
    )
    snap = db_snapshot()
    after_ids = snap["request_ids"]
    open_n = db("SELECT count(*) FROM requests WHERE status NOT IN ('rejected','cancelled','closed')")
    if before_ids != after_ids or open_n != "1" or "collecting" not in (snap["requests"] or ""):
        print_transcript(flow["transcript"])
        print_db(snap)
        print(f"before_ids={before_ids} after_ids={after_ids} open_n={open_n}", flush=True)
        raise SystemExit("STOP: expected same request row reopened to collecting")
    flow["db_final"] = snap
    flow["same_request_row"] = {"before": before_ids, "after": after_ids, "equal": True}
    print_transcript(flow["transcript"])
    print_db(snap)
    report["flows"].append(flow)
    return flow


def run_flow_moshe_no_afna():
    flow = {"name": "moshe_link_no_afna", "transcript": [], "db_final": None}
    print("\n######## FLOW: moshe handoff no אפנה ########", flush=True)
    require_sender_session()
    admin_prep()
    time.sleep(2)

    def no_afna(r: str):
        if "אפנה" in r or "נפנה לצד השני עכשיו" in r:
            return False, f"invented contact claim: {r}"
        return True, "ok"

    step(flow, "יש לי כיסא למסירה", no_afna)
    step(flow, "מוסר למשה הוא מאשר", no_afna)
    step(flow, "0536662043", no_afna)
    step(
        flow,
        "כן",
        lambda r: (
            "אפנה" not in r
            and "נפנה לצד השני עכשיו" not in r
            and any(x in r for x in ("יישוב", "שם", "כתובת", "קישרתי")),
            "after confirm must keep asking donor details, not contact",
        ),
    )
    snap = db_snapshot()
    # must have receiver משה, verification false, no verif rows ideally
    if "משה" not in (snap["parties"] or "") and "536662043" not in (snap["parties"] or ""):
        print_transcript(flow["transcript"])
        print_db(snap)
        raise SystemExit("STOP: receiver not linked in DB")
    parts = (snap["requests"] or "").split("|")
    if len(parts) >= 4 and parts[3].lower() in ("t", "true"):
        print_transcript(flow["transcript"])
        print_db(snap)
        raise SystemExit("STOP: verification_contacted true after link only")
    flow["db_final"] = snap
    print_transcript(flow["transcript"])
    print_db(snap)
    report["flows"].append(flow)
    return flow


def main():
    print("health", http_json("GET", f"{BOT}/health")[1], flush=True)
    require_sender_session()
    resolve_bot_chat()
    try:
        run_flow_contact_after_details()
        run_flow_outside_reuse()
        run_flow_moshe_no_afna()
    except SystemExit as e:
        report["ok"] = False
        report["stopped_reason"] = str(e)
        raise
    finally:
        report["ended_at"] = datetime.now(TZ).isoformat()
        for flow in report.get("flows") or []:
            flow.pop("seen_ids", None)
        with open("/tmp/live-waha-default-report.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print("wrote /tmp/live-waha-default-report.json", flush=True)
    print("ALL_FLOWS_OK", flush=True)


if __name__ == "__main__":
    main()
