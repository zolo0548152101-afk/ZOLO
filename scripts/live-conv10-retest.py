#!/usr/bin/env python3
"""Rerun Israel's conversation #10 — armchair→sofa + Friday ask + Tal.

Original (~01:07–01:10 Israel / 22:07–22:10 UTC):
  1) Israel armchair HaEmek 3 ground, no photo, to Tal + vCard + HaNasi 11 fl2
  2) Bot auto-contacted Tal about armchair (no consent ask)
  3) Friday please + actually 3-seat sofa + address HaEmek 5
  4) Bot refused Friday but invented «שלישי 13/10»; Tal left with stale armchair notice

Bugs: contact without consent; stale item on Tal notice; invented calendar date.
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
        "coalesce(proposed_run_date::text,''),coalesce(run_date::text,'') "
        "FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.position,i.kind,i.description,i.quantity "
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
        "CASE WHEN rv.outbox_id IS NULL THEN 'no_outbox' ELSE 'has_outbox' END "
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
    print(f"  outbox={outbox}", flush=True)
    return step


def tal_lines(outbox: str):
    return [ln for ln in (outbox or "").splitlines() if ln.startswith(f"{TAL}|")]


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
    send_text(
        "היי, ישראל כאן. יש לי כורסה תקינה בבית שאן, רחוב העמק 3 קומת קרקע, אין תמונה, לא צריך פירוק"
    )
    time.sleep(0.35)
    send_text("זה לטל")
    time.sleep(0.35)
    send_contact()
    time.sleep(0.35)
    send_text(
        "היי, ישראל כאן. יש לי כורסה תקינה בבית שאן, רחוב העמק 3 קומת קרקע, אין תמונה, לא צריך פירוק\n"
        "זה לטל\n"
        "טל בבית שאן רחוב הנשיא 11 קומה 2"
    )
    r1 = wait_replies(since, seen, min_count=1)
    s1 = snapshot("opening", r1)
    reply1 = " ".join(r1)

    report["checks"]["has_request"] = bool(s1["requests"])
    report["checks"]["donor_israel"] = "ישראל" in (s1["parties"] or "")
    report["checks"]["receiver_tal"] = TAL in (s1["parties"] or "")
    report["checks"]["pickup_haemek"] = "עמק" in (s1["parties"] or "")
    # Critical: must NOT have messaged Tal yet — need consent ask first.
    report["checks"]["no_tal_notice_before_consent"] = not tal_lines(s1["outbox"] or "")
    report["checks"]["asks_contact_consent"] = any(
        x in reply1 for x in ("לכתוב לטל", "לאמת", "לפנות", "כן או לא", "שאכתוב")
    )
    report["checks"]["does_not_claim_contacted"] = not any(
        x in reply1 for x in ("כותב לטל עכשיו", "כתבתי לטל", "פניתי לטל")
    )

    since2 = time.time()
    seen2 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("כן")
    r2 = wait_replies(since2, seen2, min_count=1, timeout=180)
    time.sleep(3)
    s2 = snapshot("consent-yes", r2)
    reply2 = " ".join(r2)
    tal2 = tal_lines(s2["outbox"] or "")
    report["checks"]["notice_after_consent"] = bool(tal2)
    report["checks"]["notice_mentions_armchair_or_sofa"] = any(
        x in " ".join(tal2) for x in ("כורס", "ספה")
    )
    report["checks"]["affirms_contact"] = any(
        x in reply2 for x in ("כותב", "פונה", "אכתוב", "שולח")
    )

    since3 = time.time()
    seen3 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("רגע, אפשר שזה יהיה ביום שישי הקרוב? בשלישי אני עובד")
    time.sleep(0.35)
    send_text("ובעצם זה לא כורסה, זה ספה תלת מושבית")
    time.sleep(0.35)
    send_text(
        "רגע, אפשר שזה יהיה ביום שישי הקרוב? בשלישי אני עובד\n"
        "ובעצם זה לא כורסה, זה ספה תלת מושבית\n"
        "והכתובת שלי השתנתה, רחוב העמק 5 ולא 3"
    )
    r3 = wait_replies(since3, seen3, min_count=1, timeout=180)
    time.sleep(4)
    s3 = snapshot("friday-sofa-address", r3)
    reply3 = " ".join(r3)

    report["checks"]["item_is_sofa"] = "sofa|" in (s3["items"] or "") or "ספה" in (
        s3["items"] or ""
    )
    report["checks"]["address_haemek_5"] = "עמק 5" in (s3["parties"] or "")
    report["checks"]["refuses_friday"] = any(
        x in reply3 for x in ("שישי", "רק בשלישי", "בימי שלישי", "הן בשלישי")
    )
    # Must not invent a concrete dd/mm date unless proposed_run_date is set.
    req = (s3["requests"] or "").splitlines()[0] if s3["requests"] else ""
    parts = req.split("|")
    proposed = parts[4] if len(parts) > 4 else ""
    invented = bool(re.search(r"\d{1,2}/\d{1,2}", reply3))
    report["checks"]["no_invented_calendar_date"] = (not invented) or bool(proposed)

    tal3 = tal_lines(s3["outbox"] or "")
    tal_blob = " ".join(tal3)
    report["checks"]["correction_notice_has_sofa"] = "ספה" in tal_blob
    # Prefer an explicit correction, or at least latest Tal text mentions sofa.
    report["checks"]["correction_or_update_to_tal"] = (
        "עדכון" in tal_blob or tal_blob.count("ספה") >= 1
    )
    out_phones = {
        ln.split("|", 1)[0]
        for ln in (s3["outbox"] or "").splitlines()
        if ln.strip()
    }
    report["checks"]["outbox_allowlist"] = out_phones.issubset({ISRAEL, TAL, ""})

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    report["reply3"] = reply3[:400]
    report["tal_notices"] = tal_blob[:500]
    out = "/tmp/live-conv10-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv10 retest", flush=True)


if __name__ == "__main__":
    main()
