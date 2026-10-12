#!/usr/bin/env python3
"""Rerun Israel's conversation #8 — mattress/blocks → bed + Tal verification.

Original (~00:38–00:44 Israel / 21:38–21:44 UTC):
  1) Mattress + leftover renovation bags (blocks/cement) — come take now
  2) Rant about Tuesday-only + pickup HaMayan 8 fl2 + Tal vCard
  3) Name Israel; item is single bed with mattress; Tal at Shaul HaMelech 15 fl0
  4) Yes contact Tal

Bugs: notice invented שלישי 13/10/2026 while proposed_run_date/run_date null;
request_verifications stuck at consented with null outbox_id/queued_at.
Same invented-date pattern as conv#5 notice.
"""
from __future__ import annotations

import json
import re
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
    print(f">>> {text[:160]}{'…' if len(text) > 160 else ''}", flush=True)
    if code >= 300:
        raise SystemExit(f"STOP: sendText {code} {body}")


def send_contact():
    require_session()
    code, body = http_json(
        "POST",
        f"{WAHA}/api/sendContactVcard",
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contacts": [
                {
                    "fullName": "טל",
                    "organization": "",
                    "whatsappId": "972536662043",
                    "phoneNumber": "+972536662043",
                }
            ],
        },
        {"X-Api-Key": API_KEY},
    )
    print(">>> [vCard Tal 536662043]", flush=True)
    if code >= 300:
        # Fallback shape used by older WAHA builds
        code2, body2 = http_json(
            "POST",
            f"{WAHA}/api/sendContactVcard",
            {
                "session": SESSION,
                "chatId": BOT_CHAT,
                "contactsIds": ["972536662043"],
            },
            {"X-Api-Key": API_KEY},
        )
        if code2 >= 300:
            raise SystemExit(f"STOP: sendContact {code}/{code2} {body}/{body2}")


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
        "coalesce(proposed_run_date::text,''),coalesce(run_date::text,'') "
        "FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.position,i.kind,i.description,i.quantity,"
        "coalesce(i.working::text,'') "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    outbox = db(
        "SELECT phone,state,format_state,coalesce(delivery_state,''),"
        "left(coalesce(text,''),220),coalesce(dedupe_key,'') "
        "FROM outbox ORDER BY created_at"
    )
    verifications = db(
        "SELECT r.number,rv.role,rv.state,"
        "CASE WHEN rv.outbox_id IS NULL THEN 'no_outbox' ELSE 'has_outbox' END,"
        "CASE WHEN rv.queued_at IS NULL THEN 'no_queued_at' ELSE 'has_queued_at' END,"
        "coalesce(rv.provider_accepted_at::text,'') "
        "FROM request_verifications rv JOIN requests r ON r.id=rv.request_id "
        "ORDER BY r.number,rv.role"
    )
    step = {
        "label": label,
        "replies": replies,
        "parties": parties,
        "requests": reqs,
        "items": items,
        "outbox": outbox,
        "verifications": verifications,
    }
    report["steps"].append(step)
    print(f"DB [{label}] requests={reqs}", flush=True)
    print(f"  parties={parties}", flush=True)
    print(f"  items={items}", flush=True)
    print(f"  verifications={verifications}", flush=True)
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
    send_text("יש לי מזרן ושקים של בלוקים ומלט שנשארו משיפוץ, תבואו לקחת")
    time.sleep(0.35)
    send_text(
        "יש לי מזרן ושקים של בלוקים ומלט שנשארו משיפוץ, תבואו לקחת\n"
        "מהר לפני שהשכן מתלונן"
    )
    r1 = wait_replies(since, seen, min_count=1)
    s1 = snapshot("opening-mattress", r1)
    reply1 = " ".join(r1)
    report["checks"]["records_mattress_or_bed"] = any(
        x in (s1["items"] or "") for x in ("mattress", "bed", "מזרן")
    )
    report["checks"]["refuses_construction_waste"] = any(
        x in reply1 for x in ("בלוק", "מלט", "לא מפנ", "לא לוקח", "לא מעביר")
    ) or "בלוק" not in (s1["items"] or "")
    report["checks"]["explains_tuesday_window"] = "שלישי" in reply1

    since2 = time.time()
    seen2 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("מה זה השטויות האלה, רק בשלישי?? איזה חרא של שירות")
    time.sleep(0.35)
    send_text("טוב תקין, אין תמונה. אני בבית שאן רחוב המעיין 8 קומה 2")
    time.sleep(0.35)
    send_text("המקבלת טל")
    time.sleep(0.35)
    send_contact()
    r2 = wait_replies(since2, seen2, min_count=1)
    s2 = snapshot("pickup-tal", r2)
    reply2 = " ".join(r2)
    report["checks"]["pickup_beit_shean"] = "בית שאן" in (s2["parties"] or "")
    report["checks"]["pickup_hamayan"] = "מעיין" in (s2["parties"] or "")
    report["checks"]["pickup_floor_2"] = "|2" in (s2["parties"] or "")
    report["checks"]["receiver_tal"] = "טל" in (s2["parties"] or "")
    report["checks"]["receiver_tal_phone"] = TAL in (s2["parties"] or "")

    since3 = time.time()
    seen3 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("חזרתי. ישראל")
    time.sleep(0.35)
    send_text("שינוי: במקום מזרן זה בעצם מיטת יחיד עם המזרן")
    time.sleep(0.35)
    send_text(
        "חזרתי. ישראל שינוי: במקום מזרן זה בעצם מיטת יחיד עם המזרן "
        "וטל גרה בבית שאן רחוב שאול המלך 15 קומה 0"
    )
    r3 = wait_replies(since3, seen3, min_count=1)
    s3 = snapshot("bed-tal-address", r3)
    reply3 = " ".join(r3)
    report["checks"]["item_is_bed"] = "bed|" in (s3["items"] or "") or "מיט" in (
        s3["items"] or ""
    )
    report["checks"]["donor_name_israel"] = "ישראל" in (s3["parties"] or "")
    report["checks"]["tal_address_shaul"] = "שאול" in (s3["parties"] or "")
    report["checks"]["asks_contact_consent"] = any(
        x in reply3 for x in ("לכתוב לטל", "לאמת", "לפנות", "כן או לא", "שאכתוב")
    )

    since4 = time.time()
    seen4 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("כן יאללה")
    r4 = wait_replies(since4, seen4, min_count=1, timeout=180)
    # Give notice send a moment
    time.sleep(4)
    s4 = snapshot("contact-yes", r4)
    reply4 = " ".join(r4)

    tal_notices = [
        ln
        for ln in (s4["outbox"] or "").splitlines()
        if ln.startswith(f"{TAL}|")
    ]
    notice_text = " ".join(tal_notices)
    report["checks"]["notice_outbox_to_tal"] = bool(tal_notices)
    report["checks"]["notice_sent"] = any("|sent|" in ln for ln in tal_notices)
    # Must NOT invent a concrete calendar date while still collecting / no proposal.
    invented = bool(re.search(r"\d{1,2}/\d{1,2}/\d{4}", notice_text))
    dates_null = "|collecting|direct|true||" in (s4["requests"] or "") or (
        "||" in (s4["requests"] or "")
        and "proposed" not in (s4["requests"] or "")
    )
    # requests format: number|status|origin|verification_contacted|proposed|run
    req = (s4["requests"] or "").splitlines()[0] if s4["requests"] else ""
    parts = req.split("|")
    no_schedule = len(parts) >= 6 and parts[4] == "" and parts[5] == ""
    report["checks"]["no_invented_calendar_date"] = (not invented) if no_schedule else True
    report["checks"]["notice_mentions_tuesday_window"] = "שלישי" in notice_text
    report["checks"]["notice_mentions_no_date_yet"] = (
        not no_schedule
        or any(x in notice_text for x in ("טרם נקבע", "עדיין לא נקבע", "לא נקבע תאריך"))
    )
    report["checks"]["affirms_contact"] = any(
        x in reply4 for x in ("כותב", "פונה", "אכתוב", "שולח", "פניתי")
    ) and not any(x in reply4 for x in ("לא יצאה", "לא נשלח", "כרגע לא יצאה"))

    ver = s4["verifications"] or ""
    report["checks"]["verification_advanced"] = any(
        x in ver
        for x in (
            "|queued|has_outbox|has_queued_at|",
            "|provider_accepted|has_outbox|has_queued_at|",
            "|delivered|has_outbox|has_queued_at|",
        )
    )
    report["checks"]["verification_not_stuck_consented"] = "|consented|no_outbox|" not in ver
    report["checks"]["verification_contacted_flag"] = "true" in (s4["requests"] or "")

    # Only test numbers in outbox
    out_phones = {
        ln.split("|", 1)[0]
        for ln in (s4["outbox"] or "").splitlines()
        if ln.strip()
    }
    report["checks"]["outbox_allowlist"] = out_phones.issubset({ISRAEL, TAL, ""})

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    report["no_schedule"] = no_schedule
    report["notice_sample"] = notice_text[:400]
    out = "/tmp/live-conv8-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv8 retest", flush=True)


if __name__ == "__main__":
    main()
