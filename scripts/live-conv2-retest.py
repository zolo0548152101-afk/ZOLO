#!/usr/bin/env python3
"""Rerun Israel's conversation #2 — self-as-both sofa move with helper vCard.

Original coalesced burst (~23:23 Israel / 20:23 UTC):
  שלום אני צריך עזרה עם הובלה של ספה
  [vCard טל / 972536662043]
  זאת טל היא המקבלת
  לא רגע, אני גם התורם וגם המקבל בעצם, טל רק עוזרת

Bug: reply understood self-as-both, but DB left receiver.name='טל'.
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
TAL = "536662043"
TZ = ZoneInfo("Asia/Jerusalem")

report = {
    "started_at": datetime.now(TZ).isoformat(),
    "ok": False,
    "checks": {},
    "steps": [],
}


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
            parsed = json.loads(raw) if raw else raw
        except Exception:
            parsed = raw
        return e.code, parsed


def require_session():
    code, sessions = http_json(
        "GET", f"{WAHA}/api/sessions?all=true", headers={"X-Api-Key": API_KEY}
    )
    if code != 200:
        raise SystemExit(f"STOP: sessions {code}")
    default = next((s for s in sessions if s.get("name") == SESSION), None)
    me = (default or {}).get("me", {}).get("id")
    status = (default or {}).get("status")
    if status != "WORKING" or me != EXPECTED_ME:
        raise SystemExit(f"STOP: session {status} me={me}")
    return default


def resolve_bot_chat():
    global BOT_CHAT
    code, overview = http_json(
        "GET",
        f"{WAHA}/api/{SESSION}/chats/overview?limit=50",
        headers={"X-Api-Key": API_KEY},
    )
    if code != 200:
        raise SystemExit(f"STOP: overview {code}")
    for c in overview or []:
        cid = c.get("id") or ""
        name = c.get("name") or ""
        if BOT_CHAT_CUS in cid or "543414386" in cid or ("חיים" in name and "יחד" in name):
            BOT_CHAT = cid
            break
    print(f"BOT_CHAT={BOT_CHAT}", flush=True)


def admin_reset():
    for path, body in [
        ("/admin/requests/cancel-phone", {"phone": ISRAEL, "confirm": "בטל פניות"}),
        (f"/admin/conversations/{ISRAEL}/reset", None),
        ("/admin/requests/cancel-phone", {"phone": TAL, "confirm": "בטל פניות"}),
        (f"/admin/conversations/{TAL}/reset", None),
        ("/admin/database/clear-all", {"confirm": "מחק הכל"}),
    ]:
        code, b = http_json("POST", BOT + path, body, {"x-admin-token": ADMIN})
        print(f"admin {path} HTTP {code}", flush=True)
        if code >= 300:
            raise SystemExit(f"STOP: admin {path} {code} {b}")


def send_text(text: str):
    require_session()
    code, body = http_json(
        "POST",
        f"{WAHA}/api/sendText",
        {"session": SESSION, "chatId": BOT_CHAT, "text": text},
        {"X-Api-Key": API_KEY},
    )
    print(f">>> {text}", flush=True)
    if code >= 300:
        raise SystemExit(f"STOP: sendText {code} {body}")


def send_contact():
    payloads = [
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contacts": [
                {
                    "fullName": "טל",
                    "vcard": (
                        "BEGIN:VCARD\nVERSION:3.0\nFN:טל\n"
                        "TEL;type=CELL;type=VOICE;waid=972536662043:+972536662043\n"
                        "END:VCARD"
                    ),
                }
            ],
        },
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contact": {
                "fullName": "טל",
                "phoneNumber": "+972536662043",
            },
        },
    ]
    for path in ("/api/sendContact", "/api/sendContacts", "/api/sendContactVcard"):
        for body in payloads:
            code, resp = http_json(
                "POST", f"{WAHA}{path}", body, {"X-Api-Key": API_KEY}
            )
            print(f">>> [contact טל] {path} HTTP {code}", flush=True)
            if code < 300:
                return {"ok": True, "path": path}
    # Fallback: embed vCard text like WhatsApp sometimes surfaces it
    send_text(
        "BEGIN:VCARD\nVERSION:3.0\nFN:טל\n"
        "TEL;type=CELL;type=VOICE;waid=972536662043:+972536662043\n"
        "END:VCARD\nכרטיס איש קשר: שם=טל; טלפון=536662043"
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
            raise SystemExit(f"STOP: messages {code}/{code2}")
        return body2 or []
    return body or []


def wait_replies(since, seen, min_count=1, timeout=120):
    deadline = time.time() + timeout
    got = []
    last_new = None
    while time.time() < deadline:
        for m in chat_messages(60):
            mid = str(m.get("id") or "")
            if mid in seen:
                continue
            if m.get("fromMe") is True:
                continue
            body = (m.get("body") or m.get("text") or "").strip()
            ts = m.get("timestamp") or m.get("messageTimestamp")
            tsec = (
                ts
                if isinstance(ts, (int, float)) and ts < 1e12
                else (ts / 1000 if isinstance(ts, (int, float)) else 0)
            )
            if tsec and tsec < since - 2:
                continue
            if not body:
                continue
            seen.add(mid)
            got.append(body)
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


def main():
    require_session()
    resolve_bot_chat()
    code, health = http_json("GET", f"{BOT}/health")
    report["health"] = health
    report["git_sha"] = ENV.get("GIT_SHA")
    print(f"health={health} GIT_SHA={report['git_sha']}", flush=True)
    admin_reset()

    since = time.time()
    seen = {str(m.get("id") or "") for m in chat_messages(40)}

    send_text("שלום אני צריך עזרה עם הובלה של ספה")
    time.sleep(0.4)
    send_contact()
    time.sleep(0.4)
    send_text("זאת טל היא המקבלת")
    time.sleep(0.35)
    send_text("לא רגע, אני גם התורם וגם המקבל בעצם, טל רק עוזרת")

    replies = wait_replies(since, seen, min_count=1)
    reply = " ".join(replies)

    parties = db(
        "SELECT r.number,p.role,coalesce(c.phone,''),coalesce(p.name,''),"
        "(p.approved_at IS NOT NULL)::text "
        "FROM request_parties p JOIN requests r ON r.id=p.request_id "
        "LEFT JOIN contacts c ON c.id=p.contact_id "
        "ORDER BY r.number,p.role"
    )
    reqs = db(
        "SELECT number,status,origin,represents_both_parties::text,photo_status "
        "FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.kind,i.description,i.quantity "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    step = {
        "label": "self-both-sofa",
        "replies": replies,
        "parties": parties,
        "requests": reqs,
        "items": items,
    }
    report["steps"].append(step)
    print(f"DB parties={parties}", flush=True)
    print(f"DB requests={reqs}", flush=True)
    print(f"DB items={items}", flush=True)

    # Reply understood self-as-both / helper
    report["checks"]["reply_self_both"] = (
        ("מוסר" in reply and "מקבל" in reply)
        or ("שני" in reply and "צד" in reply)
        or ("עוזר" in reply)
    )
    report["checks"]["reply_mentions_sofa"] = "ספה" in reply
    # DB: sofa saved, direct, represents_both
    report["checks"]["item_sofa"] = "|sofa|" in items or "sofa|" in items
    report["checks"]["origin_direct"] = "|direct|" in reqs
    # psql -At may print boolean as t/true depending on driver/settings
    report["checks"]["represents_both"] = (
        "|t|" in f"|{reqs}|"
        or "|true|" in f"|{reqs}|"
        or reqs.rstrip().endswith("|t")
        or reqs.rstrip().endswith("|true")
    )
    # Both parties on Israel's phone
    donor_israel = f"|donor|{ISRAEL}|" in parties
    receiver_israel = f"|receiver|{ISRAEL}|" in parties
    report["checks"]["donor_phone_israel"] = donor_israel
    report["checks"]["receiver_phone_israel"] = receiver_israel
    # Critical: receiver name must NOT be טל (helper)
    receiver_rows = [ln for ln in parties.splitlines() if "|receiver|" in ln]
    receiver_name_tal = any(
        ln.split("|")[3] == "טל" for ln in receiver_rows if ln.count("|") >= 3
    )
    report["checks"]["receiver_name_not_tal"] = (not receiver_name_tal) and bool(
        receiver_rows
    )
    # Tal's phone must not be a party
    report["checks"]["tal_phone_not_party"] = f"|{TAL}|" not in parties

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    out = "/tmp/live-conv2-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv2 retest", flush=True)


if __name__ == "__main__":
    main()
