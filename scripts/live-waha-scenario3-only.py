#!/usr/bin/env python3
"""Live WAHA: scenario 3 only — other recipient; intro once; photo first."""
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
EXPECTED_ME = "972584152101@c.us"
ISRAEL = "584152101"
TZ = ZoneInfo("Asia/Jerusalem")
BOT_CHAT = BOT_CHAT_CUS


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
        {"session": SESSION, "chatId": BOT_CHAT_CUS, "text": text},
        {"X-Api-Key": API_KEY},
    )
    print(f"sendText HTTP {code}: {text}", flush=True)
    if code >= 300:
        print(f"ERROR BODY: {body}", flush=True)
        raise SystemExit(f"STOP: sendText failed HTTP {code}")
    return body


def chat_messages(limit=50):
    code, body = http_json(
        "GET",
        f"{WAHA}/api/{SESSION}/chats/{urllib.parse.quote(BOT_CHAT, safe='@')}/messages?limit={limit}",
        headers={"X-Api-Key": API_KEY},
    )
    if code == 200:
        return body or []
    code2, body2 = http_json(
        "GET",
        f"{WAHA}/api/messages?session={SESSION}&chatId={urllib.parse.quote(BOT_CHAT, safe='@')}&limit={limit}",
        headers={"X-Api-Key": API_KEY},
    )
    if code2 == 200:
        return body2 or []
    raise SystemExit(f"STOP: get messages HTTP {code}/{code2}")


def fmt_ts(ts):
    if not ts:
        return "??:??:??"
    return datetime.fromtimestamp(int(ts), TZ).strftime("%H:%M:%S")


def wait_bot_reply(after_ts: float, seen_ids: set, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        msgs = chat_messages(50)
        candidates = []
        for m in msgs:
            if m.get("fromMe"):
                continue
            mid = str(m.get("id") or "")
            if mid and mid in seen_ids:
                continue
            t = float(m.get("timestamp") or 0)
            if t < after_ts - 2:
                continue
            body = (m.get("body") or "").strip()
            if body:
                candidates.append(m)
        if candidates:
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
        "request_count": db("SELECT count(*) FROM requests"),
        "requests": db("SELECT number,status,origin FROM requests ORDER BY number"),
        "items": db(
            "SELECT r.number,i.position,i.kind,i.description,i.quantity "
            "FROM request_items i JOIN requests r ON r.id=i.request_id ORDER BY r.number,i.position"
        ),
        "parties": db(
            "SELECT r.number,p.role,c.phone,coalesce(p.name,'') "
            "FROM request_parties p JOIN contacts c ON c.id=p.contact_id "
            "JOIN requests r ON r.id=p.request_id ORDER BY r.number,p.role"
        ),
        "conversation": db(
            "SELECT c.phone,conv.mode,conv.version,coalesce(r.number::text,'') "
            "FROM conversations conv JOIN contacts c ON c.id=conv.contact_id "
            "LEFT JOIN requests r ON r.id=conv.selected_request_id "
            "WHERE c.phone LIKE '%584152101'"
        ),
        "messages": db(
            "SELECT to_char(m.received_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS'),"
            "left(coalesce(m.text,''),100), left(coalesce(m.reply,''),200) "
            "FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id "
            "WHERE c.phone LIKE '%584152101' OR m.chat_id LIKE '%584152101%' "
            "ORDER BY m.seq"
        ),
        "request_ids": db("SELECT id::text||'|'||number::text FROM requests ORDER BY number"),
    }


def print_transcript(lines):
    print("\n----- תמליל מלא -----", flush=True)
    for row in lines:
        who = "אני" if row["who"] == "me" else "בוט"
        print(f"[{row['time']}] {who}: {row['text']}", flush=True)
    print("----- סוף תמליל -----\n", flush=True)


def print_db(snap, label=""):
    print(f"----- PostgreSQL {label} -----", flush=True)
    for k, v in snap.items():
        print(f"{k}:", v or "(none)", flush=True)
    print("----- סוף DB -----\n", flush=True)


def step(flow, text, expect=None):
    seen = flow.setdefault("seen_ids", set())
    before = time.time()
    send_text(text)
    flow["transcript"].append(
        {"who": "me", "time": datetime.now(TZ).strftime("%H:%M:%S"), "text": text}
    )
    reply_msg = wait_bot_reply(before, seen)
    if not reply_msg:
        flow["transcript"].append(
            {"who": "bot", "time": datetime.now(TZ).strftime("%H:%M:%S"), "text": "(אין תשובה)"}
        )
        print_transcript(flow["transcript"])
        print_db(db_snapshot())
        raise SystemExit(f"STOP: no bot reply after: {text}")
    mid = str(reply_msg.get("id") or "")
    if mid:
        seen.add(mid)
    reply = (reply_msg.get("body") or "").strip()
    flow["transcript"].append(
        {"who": "bot", "time": fmt_ts(reply_msg.get("timestamp")), "text": reply}
    )
    print(f"<<< {reply}", flush=True)
    snap = db_snapshot()
    print_db(snap, f"אחרי: {text}")
    if expect:
        ok, reason = expect(reply, snap)
        if not ok:
            print_transcript(flow["transcript"])
            raise SystemExit(f"STOP: wrong reply — {reason}")
    return reply, snap


def main():
    report = {
        "started_at": datetime.now(TZ).isoformat(),
        "ok": True,
        "stopped_reason": None,
        "transcript": [],
    }
    print("health", http_json("GET", f"{BOT}/health")[1], flush=True)
    require_sender_session()
    resolve_bot_chat()
    print("\n######## SCENARIO 3 only: בנוסף למקבל אחר ########", flush=True)
    print("admin clear ONCE at start only", flush=True)
    admin_prep_once()
    time.sleep(2)
    flow = {"transcript": [], "seen_ids": set()}
    try:
        step(
            flow,
            "אני רוצה למסור מיטה",
            lambda r, s: (
                s["request_count"] == "1"
                and ("סוכן האוטומטי" in r or "בהרצה ניסיונית" in r)
                and "תמונה" in r,
                "first turn: intro + photo",
            ),
        )
        step(
            flow,
            "אני רוצה למסור מקרר",
            lambda r, s: (
                "במקום" in r and "בנוסף" in r and s["request_count"] == "1",
                "ask replace/add",
            ),
        )
        step(
            flow,
            "בנוסף",
            lambda r, s: (
                ("אותו מקבל" in r or "מקבל אחר" in r or "אדם אחר" in r)
                and s["request_count"] == "1",
                "ask recipient",
            ),
        )
        step(
            flow,
            "מקבל אחר",
            lambda r, s: (
                s["request_count"] == "2"
                and "fridge" in (s["items"] or "")
                and "תמונה" in r
                and "תקין" not in r
                and "שמיש" not in r
                and "סוכן האוטומטי" not in r
                and "בהרצה ניסיונית" not in r,
                "request 2 opens with photo, no re-intro",
            ),
        )
        intro_hits = sum(
            1
            for row in flow["transcript"]
            if row["who"] == "bot"
            and ("סוכן האוטומטי" in row["text"] or "בהרצה ניסיונית" in row["text"])
        )
        print(f"intro_hits={intro_hits}", flush=True)
        if intro_hits != 1:
            raise SystemExit(f"STOP: self-intro appeared {intro_hits} times, expected 1")
        print_transcript(flow["transcript"])
        print_db(db_snapshot(), "סופי")
        report["transcript"] = flow["transcript"]
        report["db_final"] = db_snapshot()
        report["intro_hits"] = intro_hits
        print("SCENARIO3_OK", flush=True)
    except SystemExit as e:
        report["ok"] = False
        report["stopped_reason"] = str(e)
        report["transcript"] = flow.get("transcript", [])
        raise
    finally:
        report["ended_at"] = datetime.now(TZ).isoformat()
        with open("/tmp/live-waha-scenario3-report.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print("wrote /tmp/live-waha-scenario3-report.json", flush=True)


if __name__ == "__main__":
    main()
