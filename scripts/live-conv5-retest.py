#!/usr/bin/env python3
"""Rerun Israel's conversation #5 — washing machine Narkisim→Tal Dekel.

Original (~23:51–23:55 Israel / 20:51–20:55 UTC):
  1) Burst: donate washing machine + Beit Shean Narkisim 4 ground + receiver Tal + vCard
  2) Israel → cancel impulse → uncancel («לא לבטל! תמשיכי»)
  3) Tal address Dekel 9 floor 1 + ask for another/new request (same machine)
  4) כן → contact counterparty

Bug: contact_counterparty queued notice (outbox sent to Tal) but phrase saw
empty notices_queued and falsely said «לא יצאה הודעת אימות».
Ignore photo WAHA 500 on the tester side (not part of this script).
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
    print(f">>> {text[:100]}{'…' if len(text) > 100 else ''}", flush=True)
    if code >= 300:
        raise SystemExit(f"STOP: sendText {code} {body}")


def send_contact():
    payloads = [
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contacts": [
                {
                    "vcard": (
                        "BEGIN:VCARD\nVERSION:3.0\nFN:טל\n"
                        "TEL;type=CELL;type=VOICE;waid=972536662043:+972536662043\n"
                        "END:VCARD"
                    )
                }
            ],
        },
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contact": {
                "fullName": "טל",
                "phoneNumber": "+972536662043",
                "organization": "",
            },
        },
    ]
    for path in ("/api/sendContact", "/api/sendContacts", "/api/sendContactVcard"):
        for body in payloads:
            code, resp = http_json(
                "POST", f"{WAHA}{path}", body, {"X-Api-Key": API_KEY}
            )
            if code < 300:
                print(f"sendContact {path} HTTP {code}", flush=True)
                return {"ok": True, "path": path}
    # Fallback: embed vCard text so the bot still parses the phone.
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


def wait_replies(since, seen, min_count=1, timeout=150):
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


def snapshot(label, replies):
    parties = db(
        "SELECT r.number,p.role,coalesce(c.phone,''),coalesce(p.name,''),"
        "coalesce(p.settlement,''),coalesce(p.address,''),coalesce(p.floor::text,'') "
        "FROM request_parties p JOIN requests r ON r.id=p.request_id "
        "LEFT JOIN contacts c ON c.id=p.contact_id ORDER BY r.number,p.role"
    )
    reqs = db(
        "SELECT number,status,origin,coalesce(verification_contacted::text,''),"
        "coalesce(human_reason,'') FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.position,i.kind,i.description,i.quantity,"
        "coalesce(i.working::text,'') "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    outbox = db(
        "SELECT phone,state,format_state,coalesce(delivery_state,''),"
        "left(coalesce(text,''),80),coalesce(dedupe_key,'') "
        "FROM outbox ORDER BY created_at"
    )
    pending = db(
        "SELECT coalesce(c.phone,''), coalesce(cv.pending_extra_item::text,'') "
        "FROM conversations cv JOIN contacts c ON c.id=cv.contact_id"
    )
    meta = db(
        "SELECT left(coalesce(m.reply,''),160), "
        "coalesce(m.ai_metadata->'agent_claims'->>'contacted_counterparty',''), "
        "coalesce(jsonb_array_length(m.ai_metadata->'tool_results'),0)::text "
        "FROM messages m WHERE m.reply IS NOT NULL AND m.reply <> '' "
        "ORDER BY m.received_at DESC LIMIT 3"
    )
    step = {
        "label": label,
        "replies": replies,
        "parties": parties,
        "requests": reqs,
        "items": items,
        "outbox": outbox,
        "pending": pending,
        "meta": meta,
    }
    report["steps"].append(step)
    print(f"DB [{label}] parties={parties}", flush=True)
    print(f"  requests={reqs}", flush=True)
    print(f"  items={items}", flush=True)
    print(f"  outbox={outbox}", flush=True)
    return step


def main():
    require_session()
    resolve_bot_chat()
    code, health = http_json("GET", f"{BOT}/health")
    report["health"] = health
    report["git_sha"] = ENV.get("GIT_SHA") or (health or {}).get("git_sha")
    print(f"health={health} GIT_SHA={report['git_sha']}", flush=True)
    admin_reset()

    since = time.time()
    seen = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("hi, I want to donate a washing machine, מכונת כביסה עובדת")
    time.sleep(0.35)
    send_text("pickup בית שאן, רחוב הנרקיסים 4, ground floor")
    time.sleep(0.35)
    send_text("receiver is my friend Tal")
    time.sleep(0.35)
    send_contact()
    r1 = wait_replies(since, seen, min_count=1)
    s1 = snapshot("opening-narkisim", r1)
    reply1 = " ".join(r1)

    report["checks"]["has_request"] = bool(s1["requests"])
    report["checks"]["has_washing_machine"] = "washing_machine" in s1["items"]
    report["checks"]["pickup_narkisim"] = "נרקיס" in s1["parties"] or "נרקיסים" in s1["parties"]
    report["checks"]["pickup_beit_shean"] = "בית שאן" in s1["parties"]
    report["checks"]["receiver_tal_phone"] = TAL in s1["parties"]
    report["checks"]["asks_name"] = "קורא" in reply1 or "שם" in reply1

    since2 = time.time()
    seen2 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("Israel")
    time.sleep(0.35)
    send_text("actually cancel everything, never mind")
    time.sleep(0.35)
    send_text("Israel actually cancel everything, never mind wait no no sorry, לא לבטל! תמשיכי")
    r2 = wait_replies(since2, seen2, min_count=1)
    s2 = snapshot("uncancel-israel", r2)
    reply2 = " ".join(r2)
    status2 = s2["requests"].split("|")[1] if s2["requests"] else ""
    report["checks"]["not_cancelled"] = status2 not in ("cancelled", "cancel_pending")
    report["checks"]["donor_name_israel"] = "ישראל" in s2["parties"] or "Israel" in s2["parties"]
    report["checks"]["uncancel_ack"] = "לא מבטל" in reply2 or "ממשיכ" in reply2 or "ישראל" in reply2

    since3 = time.time()
    seen3 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("Tal is in בית שאן, רחוב הדקל 9 floor 1")
    time.sleep(0.35)
    send_text("new request: washing machine from me to Tal again please")
    time.sleep(0.35)
    send_text(
        "Tal is in בית שאן, רחוב הדקל 9 floor 1\n"
        "new request: washing machine from me to Tal again please\n"
        "same one, אותה מכונה, just open another request to be safe"
    )
    r3 = wait_replies(since3, seen3, min_count=1)
    s3 = snapshot("dekel-another", r3)
    reply3 = " ".join(r3)
    report["checks"]["receiver_dekel"] = "דקל" in s3["parties"]
    report["checks"]["receiver_floor_1"] = "|1" in s3["parties"] or s3["parties"].endswith("|1")
    # Must not invent a twin silently — stay on request #1 (or ask confirm).
    req_lines = [ln for ln in (s3["requests"] or "").splitlines() if ln.strip()]
    report["checks"]["single_open_request"] = len(req_lines) == 1 and req_lines[0].startswith("1|")
    pending_has_confirm = "confirm_another_delivery" in (s3["pending"] or "")
    asks_separate = any(
        x in reply3 for x in ("הובלה נוספת", "פנייה נפרדת", "הובלה נפרדת", "בנפרד", "נוספת")
    )
    asks_contact = any(x in reply3 for x in ("לכתוב לטל", "לאמת", "לפנות", "כן או לא"))
    report["checks"]["asks_confirm_or_contact"] = (
        pending_has_confirm or asks_separate or asks_contact
    )

    since4 = time.time()
    seen4 = {str(m.get("id") or "") for m in chat_messages(40)}
    # If bot asked about separate delivery, decline twin then consent to contact.
    if pending_has_confirm or asks_separate:
        send_text("לא, אותה פנייה")
        time.sleep(0.5)
        # May ask contact next — wait a beat then כן
        wait_replies(since4, seen4, min_count=1, timeout=90)
        since4 = time.time()
        seen4 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("כן")
    r4 = wait_replies(since4, seen4, min_count=1)
    s4 = snapshot("contact-yes", r4)
    reply4 = " ".join(r4)

    notice_lines = [
        ln for ln in (s4["outbox"] or "").splitlines() if ln.startswith(f"{TAL}|")
    ]
    report["checks"]["notice_outbox_to_tal"] = any(
        "notice:" in ln or "sent" in ln or "ready" in ln for ln in notice_lines
    ) or any(ln.startswith(TAL) for ln in notice_lines)
    report["checks"]["notice_state_sent"] = any(
        f"{TAL}|sent|" in ln or f"{TAL}|ready|" in ln for ln in notice_lines
    ) or any("|sent|" in ln and TAL in ln for ln in (s4["outbox"] or "").splitlines())
    # Critical: must NOT deny the verification send after notices were queued.
    report["checks"]["no_false_notice_denial"] = not any(
        x in reply4
        for x in (
            "לא יצאה",
            "לא נשלח",
            "לא נשלחה",
            "כרגע לא יצאה",
            "לא יצאה אליו הודעת אימות",
        )
    )
    report["checks"]["affirms_contact"] = any(
        x in reply4
        for x in ("כותב", "פונה", "נפנה", "אכתוב", "שולח", "פניתי", "רשמתי את האישור")
    ) and report["checks"]["no_false_notice_denial"]
    report["checks"]["verification_contacted"] = "true" in (s4["requests"] or "")

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    out = "/tmp/live-conv5-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv5 retest", flush=True)


if __name__ == "__main__":
    main()
