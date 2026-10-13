#!/usr/bin/env python3
"""Rerun Israel's conversation #9 — proxy donate for mom + Tal dresser.

Original (~00:56–00:59 Israel / 21:56–21:59 UTC):
  1) Writing for 84yo mom who has no WhatsApp; dresser 4 drawers at Herzl 22 fl1
  2) No photo, no disassembly; to Tal + vCard; Tal Ben Zvi 6 fl3; ask Oct 27
  3) Yes contact Tal

Bugs: donor name saved as «אמא»; Tal notice said «אמא רוצה למסור לך»;
Oct 27 preference not persisted (earliest_run_date null).
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
        (f"/admin/conversations/{ISRAEL}/reset", {}),
        ("/admin/requests/cancel-phone", {"phone": TAL, "confirm": "בטל פניות"}),
        (f"/admin/conversations/{TAL}/reset", {}),
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
        "coalesce(earliest_run_date::text,''),coalesce(proposed_run_date::text,''),"
        "coalesce(run_date::text,'') FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.position,i.kind,i.description,i.quantity,"
        "coalesce(i.working::text,''),coalesce(i.needs_disassembly::text,'') "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    outbox = db(
        "SELECT phone,state,format_state,coalesce(delivery_state,''),"
        "replace(replace(coalesce(text,''), E'\\n', ' '), E'\\r', ' '),"
        "coalesce(dedupe_key,'') FROM outbox ORDER BY created_at"
    )
    verifications = db(
        "SELECT r.number,rv.role,rv.state,"
        "CASE WHEN rv.outbox_id IS NULL THEN 'no_outbox' ELSE 'has_outbox' END,"
        "CASE WHEN rv.queued_at IS NULL THEN 'no_queued_at' ELSE 'has_queued_at' END "
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
    return step


def asks_name(text: str) -> bool:
    return any(x in text for x in ("שם", "קורא", "איך קוראים", "מה שמך", "שמה"))


def asks_contact(text: str) -> bool:
    return any(x in text for x in ("לכתוב לטל", "לאמת", "לפנות", "כן או לא", "שאכתוב"))


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
    send_text("שלום, אני כותב בשביל אמא שלי בת 84, היא לא יודעת וואטסאפ")
    time.sleep(0.35)
    send_text("היא רוצה למסור שידה עם 4 מגירות, תקינה, נמצאת אצלה בבית שאן רחוב הרצל 22 קומה 1")
    time.sleep(0.35)
    send_text(
        "שלום, אני כותב בשביל אמא שלי בת 84, היא לא יודעת וואטסאפ\n"
        "היא רוצה למסור שידה עם 4 מגירות, תקינה, נמצאת אצלה בבית שאן רחוב הרצל 22 קומה 1\n"
        "את יודעת היא פעם הייתה מורה, לימדה דורות שלמים בעיר, איזה אישה"
    )
    r1 = wait_replies(since, seen, min_count=1)
    s1 = snapshot("opening-proxy", r1)
    reply1 = " ".join(r1)
    report["checks"]["has_dresser"] = "שידה" in (s1["items"] or "") or "other|" in (
        s1["items"] or ""
    )
    report["checks"]["pickup_herzl"] = "הרצל" in (s1["parties"] or "")
    report["checks"]["pickup_beit_shean"] = "בית שאן" in (s1["parties"] or "")
    report["checks"]["donor_not_ima_early"] = "|אמא|" not in (s1["parties"] or "") and not (
        s1["parties"] or ""
    ).endswith("|אמא")

    since2 = time.time()
    seen2 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("אין תמונה, לא צריך פירוק")
    time.sleep(0.35)
    send_text("השידה הולכת לטל")
    time.sleep(0.35)
    send_contact()
    time.sleep(0.35)
    send_text("טל גרה בבית שאן, רחוב בן צבי 6 קומה 3")
    time.sleep(0.35)
    send_text(
        "אין תמונה, לא צריך פירוק\n"
        "השידה הולכת לטל\n"
        "טל גרה בבית שאן, רחוב בן צבי 6 קומה 3\n"
        "ואפשר ב-27 באוקטובר? לא השבוע הזה"
    )
    r2 = wait_replies(since2, seen2, min_count=1)
    s2 = snapshot("tal-oct27", r2)
    reply2 = " ".join(r2)
    report["checks"]["receiver_tal_phone"] = TAL in (s2["parties"] or "")
    report["checks"]["tal_ben_zvi"] = "בן צבי" in (s2["parties"] or "") or "בן-צבי" in (
        s2["parties"] or ""
    )
    report["checks"]["oct27_persisted"] = "2026-10-27" in (s2["requests"] or "")
    report["checks"]["donor_not_ima"] = "|אמא|" not in (s2["parties"] or "") and "אמא|" not in (
        s2["parties"] or ""
    )
    # Must NOT have already messaged Tal with «אמא».
    tal_early = [
        ln for ln in (s2["outbox"] or "").splitlines() if ln.startswith(f"{TAL}|")
    ]
    report["checks"]["no_notice_before_real_name"] = not tal_early or all(
        "אמא" not in ln for ln in tal_early
    )
    needs_name = asks_name(reply1 + " " + reply2) or (
        "|donor|" in (s2["parties"] or "")
        and re.search(r"\|donor\|584152101\|\|", s2["parties"] or "")
    )
    # Empty donor name in parties: number|role|phone|name|...
    donor_line = next(
        (
            ln
            for ln in (s2["parties"] or "").splitlines()
            if "|donor|" in ln
        ),
        "",
    )
    donor_parts = donor_line.split("|")
    donor_name = donor_parts[3] if len(donor_parts) > 3 else ""
    report["checks"]["asks_or_awaits_real_name"] = (
        asks_name(reply2) or donor_name == "" or donor_name not in ("אמא", "אימא")
    ) and donor_name not in ("אמא", "אימא")

    since3 = time.time()
    seen3 = {str(m.get("id") or "") for m in chat_messages(40)}
    # Supply a real given name for mom.
    send_text("קוראים לה רחל")
    r3 = wait_replies(since3, seen3, min_count=1)
    s3 = snapshot("name-rachel", r3)
    reply3 = " ".join(r3)
    report["checks"]["donor_name_rachel"] = "רחל" in (s3["parties"] or "")
    report["checks"]["still_not_ima"] = "אמא" not in (s3["parties"] or "")

    # If contact not yet asked, answer yes after ask; else yes now.
    since4 = time.time()
    seen4 = {str(m.get("id") or "") for m in chat_messages(40)}
    if asks_contact(reply2 + " " + reply3):
        send_text("כן")
    else:
        # Prompt may ask contact next — nudge.
        send_text("כן, אפשר לכתוב לטל")
    r4 = wait_replies(since4, seen4, min_count=1, timeout=180)
    time.sleep(4)
    s4 = snapshot("contact-yes", r4)
    reply4 = " ".join(r4)

    tal_notices = [
        ln for ln in (s4["outbox"] or "").splitlines() if ln.startswith(f"{TAL}|")
    ]
    notice_text = " ".join(tal_notices)
    report["checks"]["notice_to_tal"] = bool(tal_notices)
    report["checks"]["notice_sent"] = any("|sent|" in ln for ln in tal_notices)
    report["checks"]["notice_not_ima"] = "אמא" not in notice_text
    report["checks"]["notice_has_rachel_or_generic"] = (
        "רחל" in notice_text or "המוסר" in notice_text
    )
    report["checks"]["affirms_contact"] = any(
        x in reply4 for x in ("כותב", "פונה", "אכתוב", "שולח")
    )
    ver = s4["verifications"] or ""
    report["checks"]["verification_advanced"] = any(
        x in ver
        for x in (
            "|queued|has_outbox|has_queued_at",
            "|provider_accepted|has_outbox|has_queued_at",
            "|delivered|has_outbox|has_queued_at",
        )
    )
    report["checks"]["oct27_still"] = "2026-10-27" in (s4["requests"] or "")
    out_phones = {
        ln.split("|", 1)[0]
        for ln in (s4["outbox"] or "").splitlines()
        if ln.strip()
    }
    report["checks"]["outbox_allowlist"] = out_phones.issubset({ISRAEL, TAL, ""})

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    report["notice_sample"] = notice_text[:400]
    report["needs_name_signal"] = needs_name
    out = "/tmp/live-conv9-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv9 retest", flush=True)


if __name__ == "__main__":
    main()
