#!/usr/bin/env python3
"""Live WAHA: reproduce Israel's phone burst (fast messages + contact card).

Protocol: WORKING default (me=972584152101) → real sendText to bot.
No webhook inject / simulate. Full Israel-time transcript + Postgres.
"""
from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from urllib.parse import urlparse
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
EXPECTED_ME = "972584152101@c.us"
ISRAEL = "584152101"
TAL_PHONE = "536662043"
TZ = ZoneInfo("Asia/Jerusalem")
BOT_CHAT = BOT_CHAT_CUS
OUT = "/tmp/israel-burst-retest-report.json"


def http_json(method, url, body=None, headers=None, timeout=90):
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
            return e.code, json.loads(raw) if raw else raw
        except Exception:
            return e.code, raw


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
    return default


def resolve_bot_chat():
    global BOT_CHAT
    code, overview = http_json(
        "GET",
        f"{WAHA}/api/{SESSION}/chats/overview?limit=50",
        headers={"X-Api-Key": API_KEY},
    )
    if code != 200:
        raise SystemExit(f"STOP: chats overview HTTP {code}")
    found = BOT_CHAT_CUS
    for c in overview or []:
        cid = c.get("id") or ""
        name = c.get("name") or ""
        if "חיים" in name and "יחד" in name:
            found = cid
            break
    BOT_CHAT = found
    print(f"BOT_CHAT resolved={found}", flush=True)


def admin_prep_once():
    require_sender_session()
    for path, body in [
        ("/admin/requests/cancel-phone", {"phone": ISRAEL, "confirm": "בטל פניות"}),
        (f"/admin/conversations/{ISRAEL}/reset", None),
        ("/admin/database/clear-all", {"confirm": "מחק הכל"}),
    ]:
        code, b = http_json("POST", BOT + path, body, {"x-admin-token": ADMIN})
        print(f"admin {path} HTTP {code}", flush=True)
        if code >= 300:
            raise SystemExit(f"STOP: admin {path} failed {code} {b}")


def send_text(text: str):
    require_sender_session()
    code, body = http_json(
        "POST",
        f"{WAHA}/api/sendText",
        {"session": SESSION, "chatId": BOT_CHAT, "text": text},
        {"X-Api-Key": API_KEY},
    )
    print(f"sendText HTTP {code}: {text}", flush=True)
    if code >= 300:
        raise SystemExit(f"STOP: sendText failed HTTP {code} {body}")
    return body


def send_contact():
    """Share Tal's contact card if WAHA supports it; else text fallback with phone."""
    require_sender_session()
    payloads = [
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contacts": [
                {
                    "fullName": "אא טל",
                    "whatsappId": f"972{TAL_PHONE}@c.us",
                    "phoneNumber": f"+972{TAL_PHONE}",
                }
            ],
        },
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contact": {
                "fullName": "אא טל",
                "phoneNumber": f"+972{TAL_PHONE}",
            },
        },
    ]
    for path in ("/api/sendContact", "/api/sendContacts", "/api/sendContactVcard"):
        for body in payloads:
            code, resp = http_json(
                "POST",
                f"{WAHA}{path}",
                body,
                {"X-Api-Key": API_KEY},
            )
            print(f"sendContact {path} HTTP {code}", flush=True)
            if code < 300:
                return {"ok": True, "path": path, "resp": resp}
    # Fallback: name + phone as text (still exercises sticky handoff)
    print("WARN: contact API unavailable; sending phone as text", flush=True)
    send_text(f"זה הטלפון של טל 0{TAL_PHONE}")
    return {"ok": False, "fallback": "text_phone"}


def chat_messages(limit=80):
    code, body = http_json(
        "GET",
        f"{WAHA}/api/{SESSION}/chats/{urllib.parse.quote(BOT_CHAT, safe='')}/messages?limit={limit}",
        headers={"X-Api-Key": API_KEY},
    )
    if code != 200:
        # LID chats sometimes need alternate path
        code2, body2 = http_json(
            "GET",
            f"{WAHA}/api/messages?session={SESSION}&chatId={urllib.parse.quote(BOT_CHAT, safe='')}&limit={limit}",
            headers={"X-Api-Key": API_KEY},
        )
        if code2 != 200:
            raise SystemExit(f"STOP: messages HTTP {code}/{code2}")
        return body2 or []
    return body or []


def fmt_ts(ts):
    if ts is None:
        return datetime.now(TZ).strftime("%H:%M:%S")
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts if ts < 1e12 else ts / 1000, TZ).strftime(
            "%H:%M:%S"
        )
    return str(ts)


def wait_bot_replies(since: float, seen: set, min_count=1, timeout=90):
    """Collect bot replies after since; return when quiet 6s after at least min_count."""
    deadline = time.time() + timeout
    got = []
    last_new = None
    while time.time() < deadline:
        for m in chat_messages(60):
            mid = str(m.get("id") or "")
            if mid in seen:
                continue
            from_me = m.get("fromMe")
            body = (m.get("body") or m.get("text") or "").strip()
            ts = m.get("timestamp") or m.get("messageTimestamp")
            tsec = ts if isinstance(ts, (int, float)) and ts < 1e12 else (ts / 1000 if isinstance(ts, (int, float)) else 0)
            if tsec and tsec < since - 2:
                continue
            if from_me is False or (isinstance(m.get("from"), str) and "543414386" in m.get("from", "")):
                # inbound to default = bot
                pass
            # In default→bot chat, bot messages have fromMe=false on default session
            if from_me is True:
                continue
            if not body:
                continue
            seen.add(mid)
            row = {"id": mid, "time": fmt_ts(ts), "text": body}
            got.append(row)
            last_new = time.time()
            print(f"<<< [{row['time']}] {body}", flush=True)
        if len(got) >= min_count and last_new and time.time() - last_new >= 6:
            break
        time.sleep(1.2)
    return got


def db(sql: str) -> str:
    url = urlparse(ENV["DATABASE_URL"])
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
        "health": http_json("GET", f"{BOT}/health")[1],
        "conversation": db(
            "SELECT c.phone,conv.mode,conv.version,coalesce(r.number::text,''),"
            "coalesce(conv.pending_counterparty_name,''),coalesce(conv.pending_counterparty_phone,'') "
            "FROM conversations conv JOIN contacts c ON c.id=conv.contact_id "
            "LEFT JOIN requests r ON r.id=conv.selected_request_id "
            "WHERE c.phone LIKE '%584152101'"
        ),
        "requests": db("SELECT number,status,origin FROM requests ORDER BY number"),
        "items": db(
            "SELECT r.number,i.position,i.kind,i.description "
            "FROM request_items i JOIN requests r ON r.id=i.request_id ORDER BY r.number,i.position"
        ),
        "parties": db(
            "SELECT r.number,p.role,c.phone,coalesce(p.name,'') "
            "FROM request_parties p JOIN contacts c ON c.id=p.contact_id "
            "JOIN requests r ON r.id=p.request_id ORDER BY r.number,p.role"
        ),
        "messages": db(
            "SELECT to_char(m.received_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS'),"
            "m.kind,left(coalesce(m.text,''),120),left(coalesce(m.reply,''),200),"
            "coalesce(m.error_code,''),coalesce(m.turn_generation::text,'') "
            "FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id "
            "WHERE c.phone LIKE '%584152101' ORDER BY m.seq"
        ),
        "turns": db(
            "SELECT t.generation,t.status,"
            "to_char(t.opened_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS'),"
            "to_char(coalesce(t.completed_at,t.opened_at) AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') "
            "FROM conversation_turns t JOIN conversations cv ON cv.id=t.conversation_id "
            "JOIN contacts c ON c.id=cv.contact_id WHERE c.phone LIKE '%584152101' "
            "ORDER BY t.generation"
        ),
        "outbox": db(
            "SELECT to_char(o.created_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS'),"
            "to_char(coalesce(o.sent_at,o.created_at) AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS'),"
            "o.state,left(o.text,200),coalesce(o.error_code,'') "
            "FROM outbox o WHERE o.phone LIKE '%584152101' ORDER BY o.created_at"
        ),
    }


def main():
    code, health = http_json("GET", f"{BOT}/health")
    print(f"health HTTP {code} {health}", flush=True)
    if code != 200 or not (health or {}).get("ok"):
        raise SystemExit("STOP: bot health failed")
    require_sender_session()
    resolve_bot_chat()
    admin_prep_once()
    time.sleep(2)

    seen = set()
    for m in chat_messages(40):
        mid = str(m.get("id") or "")
        if mid:
            seen.add(mid)

    transcript = []
    contact_meta = None

    # Israel's burst: fast texts, then contact, then item
    burst = ["שלום", "אנע", "רוצה למסור", "לטל", "קוראים לי ישראל"]
    since = time.time()
    for i, text in enumerate(burst):
        send_text(text)
        transcript.append(
            {"who": "me", "time": datetime.now(TZ).strftime("%H:%M:%S"), "text": text}
        )
        time.sleep(0.7 if i < len(burst) - 1 else 0.3)

    # Wait for first bot reply after the burst (should be ONE answer)
    replies1 = wait_bot_replies(since, seen, min_count=1, timeout=75)
    for r in replies1:
        transcript.append({"who": "bot", "time": r["time"], "text": r["text"]})

    since2 = time.time()
    contact_meta = send_contact()
    transcript.append(
        {
            "who": "me",
            "time": datetime.now(TZ).strftime("%H:%M:%S"),
            "text": "[כרטיס איש קשר אא טל]" if contact_meta.get("ok") else "זה הטלפון של טל 0536662043",
        }
    )
    time.sleep(1.0)
    send_text("מיטה")
    transcript.append(
        {"who": "me", "time": datetime.now(TZ).strftime("%H:%M:%S"), "text": "מיטה"}
    )

    replies2 = wait_bot_replies(since2, seen, min_count=1, timeout=90)
    for r in replies2:
        transcript.append({"who": "bot", "time": r["time"], "text": r["text"]})

    # Extra quiet drain for any dual-reply
    time.sleep(8)
    extra = wait_bot_replies(time.time() - 10, seen, min_count=0, timeout=8)
    for r in extra:
        transcript.append({"who": "bot", "time": r["time"], "text": r["text"]})

    snap = db_snapshot()
    report = {
        "started": datetime.now(TZ).isoformat(),
        "health": health,
        "contact_meta": contact_meta,
        "transcript": transcript,
        "db": snap,
        "bot_reply_count": sum(1 for t in transcript if t["who"] == "bot"),
        "intro_count": sum(
            1
            for t in transcript
            if t["who"] == "bot" and ("סוכן האוטומטי" in t["text"] or "בהרצה ניסיונית" in t["text"])
        ),
        "path_ask_count": sum(
            1
            for t in transcript
            if t["who"] == "bot"
            and ("למסור פריט" in t["text"] and "לקבל פריט" in t["text"])
        ),
    }

    print("\n----- תמליל מלא -----", flush=True)
    for row in transcript:
        who = "אני" if row["who"] == "me" else "בוט"
        print(f"[{row['time']}] {who}: {row['text']}", flush=True)
    print("----- סוף תמליל -----\n", flush=True)
    print("----- PostgreSQL -----", flush=True)
    for k, v in snap.items():
        print(f"{k}:", v if v else "(none)", flush=True)
    print("----- סוף DB -----\n", flush=True)

    # Hard checks
    problems = []
    if report["intro_count"] > 1:
        problems.append(f"intro repeated {report['intro_count']} times")
    if report["path_ask_count"] > 1:
        problems.append(f"path asked {report['path_ask_count']} times")
    first_bot = next((t for t in transcript if t["who"] == "bot"), None)
    if first_bot and "למסור פריט" in first_bot["text"] and "לקבל פריט" in first_bot["text"]:
        problems.append("first reply re-asked path despite רוצה למסור")

    sent_rows = []
    for line in (snap.get("outbox") or "").split("\n"):
        if not line:
            continue
        parts = line.split("|")
        if len(parts) >= 4 and parts[2] == "sent":
            sent_rows.append(parts[3])
    report["sent_replies"] = sent_rows
    if len(sent_rows) > 3:
        problems.append(f"too many sent outbox replies: {len(sent_rows)}")

    parties = snap.get("parties") or ""
    if "donor|584152101|ישראל" not in parties.replace(" ", ""):
        # tolerate spacing from db dump
        if "ישראל" not in parties or "donor" not in parties:
            problems.append("donor_name ישראל missing")
    if "536662043" not in parties:
        problems.append("receiver phone 536662043 missing")
    if "טל" not in parties:
        problems.append("receiver name טל missing")

    last_bot = next((t for t in reversed(transcript) if t["who"] == "bot"), None)
    if not last_bot or "תמונה" not in last_bot["text"]:
        problems.append(f"expected photo ask next, got: {(last_bot or {}).get('text')}")

    report["problems"] = problems
    with open(OUT, "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"REPORT {OUT}", flush=True)
    print(
        f"intro_count={report['intro_count']} path_ask_count={report['path_ask_count']} problems={problems}",
        flush=True,
    )
    if problems:
        raise SystemExit("STOP: " + "; ".join(problems))
    print("OK burst retest passed", flush=True)


if __name__ == "__main__":
    main()
