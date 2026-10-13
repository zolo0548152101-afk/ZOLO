#!/usr/bin/env python3
"""Rerun Israel's conversation #3 — Holon outside + Beit Shean correction + Tal.

Original bursts (~23:32–23:34 Israel / 20:32–20:34 UTC):
  1) fridge working + next Tuesday ask
  2) Holon Sokolov 12 floor 3 + exact 16:00 demand + photo later
  3) insist → correct to Beit Shean Herzl 5 + Tal recipient + vCard

Bugs: Holon became distance-review; after correction floor=3 and
needs_distance_check/team_notes about Holon stayed sticky.
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
                    "whatsappId": f"972{TAL}@c.us",
                    "phoneNumber": f"+972{TAL}",
                }
            ],
        },
        {
            "session": SESSION,
            "chatId": BOT_CHAT,
            "contact": {"fullName": "טל", "phoneNumber": f"+972{TAL}"},
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
    send_text(
        "BEGIN:VCARD\nVERSION:3.0\nFN:טל\n"
        f"TEL;type=CELL;type=VOICE;waid=972{TAL}:+972{TAL}\n"
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


def burst(label, texts, gap=0.35, contact_after=None):
    since = time.time()
    seen = {str(m.get("id") or "") for m in chat_messages(40)}
    for t in texts:
        send_text(t)
        time.sleep(gap)
    if contact_after:
        send_contact()
        time.sleep(gap)
    replies = wait_replies(since, seen, min_count=1)
    parties = db(
        "SELECT r.number,p.role,coalesce(c.phone,''),coalesce(p.name,''),"
        "coalesce(p.settlement,''),coalesce(p.address,''),coalesce(p.floor::text,'') "
        "FROM request_parties p JOIN requests r ON r.id=p.request_id "
        "LEFT JOIN contacts c ON c.id=p.contact_id ORDER BY r.number,p.role"
    )
    reqs = db(
        "SELECT number,status,origin,needs_distance_check::text,"
        "coalesce(team_notes,''),coalesce(preferred_time,'') "
        "FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.kind,i.description,i.quantity,coalesce(i.working::text,'') "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    holon_decision = db(
        "SELECT coalesce(decision,'') FROM service_locations WHERE name='חולון'"
    )
    step = {
        "label": label,
        "replies": replies,
        "parties": parties,
        "requests": reqs,
        "items": items,
        "holon_decision": holon_decision,
    }
    report["steps"].append(step)
    print(f"DB after [{label}]: parties={parties}", flush=True)
    print(f"  requests={reqs}", flush=True)
    print(f"  items={items} holon={holon_decision}", flush=True)
    return step


def main():
    require_session()
    resolve_bot_chat()
    code, health = http_json("GET", f"{BOT}/health")
    report["health"] = health
    report["git_sha"] = ENV.get("GIT_SHA")
    print(f"health={health} GIT_SHA={report['git_sha']}", flush=True)
    admin_reset()

    s1 = burst(
        "fridge-open",
        [
            "אהלן אחי מה קורה",
            "יש לי מקרר תקין בול למסור, אחלה מצב",
            "תבואו ביום שלישי הקרוב סבבה?",
        ],
    )
    r1 = " ".join(s1["replies"])
    report["checks"]["opening_fridge"] = "fridge" in s1["items"] or "מקרר" in s1["items"]
    report["checks"]["opening_mentions_fridge"] = "מקרר" in r1

    s2 = burst(
        "holon-exact-time",
        [
            "בחולון, רחוב סוקולוב 12 קומה 3 בלי מעלית",
            "אחי אבל חייב שזה יהיה השלישי הזה ב16:00 בדיוק אחרת אני זורק אותו",
            "תמונה אשלח אח״כ",
        ],
    )
    r2 = " ".join(s2["replies"])
    report["checks"]["refuses_holon"] = "חולון" in r2 and (
        "לא נוכל" in r2 or "רק בבית שאן" in r2 or "בית שאן" in r2 or "לא" in r2
    )
    report["checks"]["no_exact_1600_promise"] = "בדיוק" in r2 or "להבטיח" in r2 or "16:00" in r2
    # Must not leave Holon as sticky distance-review after this turn either
    report["checks"]["holon_not_review"] = s2["holon_decision"] in ("", "outside")

    s3 = burst(
        "beit-shean-tal",
        [
            "נו באמת זה רק שעה נסיעה",
            "טוב אז בעצם המקרר אצל אחותי בבית שאן, רחוב הרצל 5",
            "והמקבלת זה לא אני, זאת טל",
        ],
        contact_after=True,
    )
    r3 = " ".join(s3["replies"])
    parties = s3["parties"]
    reqs = s3["requests"]
    donor = next((ln for ln in parties.splitlines() if "|donor|" in ln), "")
    receiver = next((ln for ln in parties.splitlines() if "|receiver|" in ln), "")
    # donor: settlement בית שאן, address הרצל, floor empty (not 3)
    donor_parts = donor.split("|") if donor else []
    report["checks"]["settlement_beit_shean"] = len(donor_parts) > 4 and "בית שאן" in donor_parts[4]
    report["checks"]["address_herzl"] = len(donor_parts) > 5 and "הרצל" in donor_parts[5]
    report["checks"]["floor_cleared"] = len(donor_parts) > 6 and donor_parts[6] == ""
    report["checks"]["receiver_tal_phone"] = f"|receiver|{TAL}|" in parties
    report["checks"]["receiver_name_tal"] = "|טל|" in receiver or receiver.endswith("|טל") or "|טל|" in f"|{receiver}|"
    # needs_distance_check false / f
    report["checks"]["no_distance_check"] = (
        "|false|" in f"|{reqs}|" or "|f|" in f"|{reqs}|"
    ) and "בדיקת מרחק" not in reqs
    report["checks"]["mentions_tal_or_name_ask"] = "טל" in r3 or "קוראים" in r3
    report["checks"]["item_still_fridge"] = "fridge" in s3["items"]

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    out = "/tmp/live-conv3-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv3 retest", flush=True)


if __name__ == "__main__":
    main()
