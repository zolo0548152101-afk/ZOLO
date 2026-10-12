#!/usr/bin/env python3
"""Replay Israel's rename conversation and assert receiver name becomes טל.

Exact opening from the failing live run (typos preserved):
  שלום
  אני רותה להעביר מיוה
  אני רותה להעביר מיוה למשה
  [vCard אא טל / 972536662043]
  אני רוצה בעצם לטל שלחתי לך את הנייד שלה
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
BOT_CHAT = BOT_CHAT_CUS
EXPECTED_ME = "972584152101@c.us"
ISRAEL = "584152101"
TAL_PHONE = "536662043"
TZ = ZoneInfo("Asia/Jerusalem")

report = {
    "started_at": datetime.now(TZ).isoformat(),
    "steps": [],
    "ok": False,
    "receiver_name": None,
    "git_sha": None,
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
    return default


def resolve_bot_chat() -> str:
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
        if BOT_CHAT_CUS in cid or "543414386" in cid:
            found = cid
            break
        if "חיים" in name and ("יחד" in name or "@lid" in cid):
            found = cid
            break
    if found:
        BOT_CHAT = found
    report["bot_chat"] = BOT_CHAT
    print(f"BOT_CHAT={BOT_CHAT}", flush=True)
    return BOT_CHAT


def admin_clear():
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
    print(f">>> {text}", flush=True)
    if code >= 300:
        raise SystemExit(f"STOP: sendText failed HTTP {code} {body}")
    return body


def send_contact():
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
            print(f">>> [contact אא טל] {path} HTTP {code}", flush=True)
            if code < 300:
                return {"ok": True, "path": path, "resp": resp}
    # Fallback with caption matching the live failure shape
    send_text(
        "אני רותה להעביר מיוה למשה\n"
        "BEGIN:VCARD\nVERSION:3.0\nN:;אא טל ;;;\nFN:אא טל\n"
        f"item1.TEL;waid=972{TAL_PHONE}:+972 53-666-2043\n"
        "item1.X-ABLabel:אחר\nEND:VCARD\nכרטיס איש קשר"
    )
    return {"ok": False, "fallback": "text_vcard"}


def chat_messages(limit=80):
    code, body = http_json(
        "GET",
        f"{WAHA}/api/{SESSION}/chats/{urllib.parse.quote(BOT_CHAT, safe='')}/messages?limit={limit}",
        headers={"X-Api-Key": API_KEY},
    )
    if code != 200:
        code2, body2 = http_json(
            "GET",
            f"{WAHA}/api/messages?session={SESSION}&chatId={urllib.parse.quote(BOT_CHAT, safe='')}&limit={limit}",
            headers={"X-Api-Key": API_KEY},
        )
        if code2 != 200:
            raise SystemExit(f"STOP: messages HTTP {code}/{code2}")
        return body2 or []
    return body or []


def wait_bot_replies(since: float, seen: set, min_count=1, timeout=120):
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
            tsec = (
                ts
                if isinstance(ts, (int, float)) and ts < 1e12
                else (ts / 1000 if isinstance(ts, (int, float)) else 0)
            )
            if tsec and tsec < since - 2:
                continue
            if from_me is True:
                continue
            if not body:
                continue
            seen.add(mid)
            row = {"id": mid, "text": body}
            got.append(row)
            last_new = time.time()
            print(f"<<< {body}", flush=True)
        if len(got) >= min_count and last_new and time.time() - last_new >= 6:
            break
        time.sleep(1.2)
    return got


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


def step(label: str, send_fn, expect_min=1):
    since = time.time()
    seen = {str(m.get("id") or "") for m in chat_messages(40)}
    send_fn()
    replies = wait_bot_replies(since, seen, min_count=expect_min)
    parties = db(
        "SELECT r.number,p.role,coalesce(c.phone,''),coalesce(p.name,'') "
        "FROM request_parties p LEFT JOIN contacts c ON c.id=p.contact_id "
        "JOIN requests r ON r.id=p.request_id ORDER BY r.number,p.role"
    )
    row = {
        "label": label,
        "replies": [r["text"] for r in replies],
        "parties": parties,
    }
    report["steps"].append(row)
    print(f"DB parties after [{label}]: {parties}", flush=True)
    return row


def main():
    require_sender_session()
    resolve_bot_chat()
    code, health = http_json("GET", f"{BOT}/health")
    report["health"] = health
    report["git_sha"] = (health or {}).get("git_sha") or ENV.get("GIT_SHA")
    print(f"health={health} GIT_SHA={report['git_sha']}", flush=True)

    admin_clear()
    empty = db("SELECT count(*) FROM requests")
    if empty != "0":
        raise SystemExit(f"STOP: clear-all left requests={empty}")

    step("שלום", lambda: send_text("שלום"))
    step("מיום", lambda: send_text("אני רותה להעביר מיוה"))
    step("למשה", lambda: send_text("אני רותה להעביר מיוה למשה"))
    step("vcard", send_contact)

    def receiver_state(parties_blob: str):
        for line in parties_blob.splitlines():
            parts = line.split("|")
            if len(parts) >= 4 and parts[1] == "receiver":
                return {"phone": parts[2], "name": parts[3]}
        return {"phone": "", "name": ""}

    mid = receiver_state(report["steps"][-1]["parties"])
    print(f"mid-state after vcard: {mid}", flush=True)
    # Reproduce the failing path: phone already linked, name still משה.
    if mid["phone"] != TAL_PHONE or mid["name"] != "משה":
        step(
            "attach-phone-as-moshe",
            lambda: send_text(f"המספר של משה הוא 0{TAL_PHONE}"),
        )
        mid = receiver_state(report["steps"][-1]["parties"])
        print(f"mid-state after phone attach: {mid}", flush=True)
    if mid["phone"] != TAL_PHONE:
        raise SystemExit(
            f"STOP: need receiver phone={TAL_PHONE} before rename, got {mid}"
        )
    if mid["name"] != "משה":
        raise SystemExit(
            f"STOP: need receiver name משה before rename, got {mid}"
        )
    report["pre_rename_receiver"] = mid

    step("rename-to-tal", lambda: send_text("אני רוצה בעצם לטל שלחתי לך את הנייד שלה"))

    parties = db(
        "SELECT r.number,p.role,coalesce(c.phone,''),coalesce(p.name,'') "
        "FROM request_parties p LEFT JOIN contacts c ON c.id=p.contact_id "
        "JOIN requests r ON r.id=p.request_id ORDER BY r.number,p.role"
    )
    report["final_parties"] = parties
    final = receiver_state(parties)
    report["receiver_name"] = final["name"]
    report["receiver_phone"] = final["phone"]
    report["ok"] = final["name"] == "טל" and final["phone"] == TAL_PHONE
    report["finished_at"] = datetime.now(TZ).isoformat()

    out = "/tmp/live-rename-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        raise SystemExit(
            f"FAIL: expected receiver name טל, got {receiver_name!r}; parties={parties!r}"
        )
    print("PASS: receiver name is טל", flush=True)


if __name__ == "__main__":
    main()
