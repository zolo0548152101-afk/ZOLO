#!/usr/bin/env python3
"""Rerun Israel's conversation #7 — status 47 + seek fridge/bed + dual chair handoffs.

Original (~00:30–00:33 Israel / 21:30–21:33 UTC):
  1) Status of request #47 + need fridge and bed
  2) Beit Shean HaArba'a 10 floor 4 + 6 chairs to Tal + 6 chairs to self + when?

Bugs: second donate (self) merged into Tal's chairs and wiped Tal;
seek fridge was overwritten by bed (one search row per contact).
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
    print(f">>> {text[:140]}{'…' if len(text) > 140 else ''}", flush=True)
    if code >= 300:
        raise SystemExit(f"STOP: sendText {code} {body}")


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
        "coalesce(p.settlement,''),coalesce(p.address,''),coalesce(p.floor::text,''),"
        "r.represents_both_parties::text "
        "FROM request_parties p JOIN requests r ON r.id=p.request_id "
        "LEFT JOIN contacts c ON c.id=p.contact_id ORDER BY r.number,p.role"
    )
    reqs = db("SELECT number,status,origin,represents_both_parties::text FROM requests ORDER BY number")
    items = db(
        "SELECT r.number,i.position,i.kind,i.description,i.quantity "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    searches = db(
        "SELECT kind,state,coalesce(settlement,''),coalesce(address,''),coalesce(floor::text,'') "
        "FROM searches ORDER BY kind"
    )
    outbox = db(
        "SELECT phone,state,left(coalesce(text,''),80) FROM outbox ORDER BY created_at"
    )
    step = {
        "label": label,
        "replies": replies,
        "parties": parties,
        "requests": reqs,
        "items": items,
        "searches": searches,
        "outbox": outbox,
    }
    report["steps"].append(step)
    print(f"DB [{label}] requests={reqs}", flush=True)
    print(f"  parties={parties}", flush=True)
    print(f"  items={items}", flush=True)
    print(f"  searches={searches}", flush=True)
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
    send_text("שלום, מה הסטטוס של בקשה מספר 47 שלי? הזמנתי שבוע שעבר")
    time.sleep(0.35)
    send_text(
        "שלום, מה הסטטוס של בקשה מספר 47 שלי? הזמנתי שבוע שעבר\n"
        "ובכלל אני צריכה מקרר ומיטה לבית, אין לי כלום, אתם נותנים?"
    )
    r1 = wait_replies(since, seen, min_count=1)
    s1 = snapshot("status-seek", r1)
    reply1 = " ".join(r1)
    report["checks"]["mentions_47_unknown"] = "47" in reply1
    report["checks"]["has_fridge_search"] = "fridge" in (s1["searches"] or "")
    report["checks"]["has_bed_search"] = "bed" in (s1["searches"] or "")
    report["checks"]["both_searches_early"] = (
        report["checks"]["has_fridge_search"] and report["checks"]["has_bed_search"]
    )

    since2 = time.time()
    seen2 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("בית שאן, רחוב הארבעה 10 קומה 4 בלי מעלית")
    time.sleep(0.35)
    send_text("אה ושכחתי, אני גם מוסרת: 6 כיסאות לטל ו-6 כיסאות לעצמי בדירה החדשה")
    time.sleep(0.35)
    send_text(
        "בית שאן, רחוב הארבעה 10 קומה 4 בלי מעלית\n"
        "אה ושכחתי, אני גם מוסרת: 6 כיסאות לטל ו-6 כיסאות לעצמי בדירה החדשה\n"
        "מתי אתם יכולים?"
    )
    r2 = wait_replies(since2, seen2, min_count=1)
    s2 = snapshot("address-chairs", r2)
    reply2 = " ".join(r2)

    req_lines = [ln for ln in (s2["requests"] or "").splitlines() if ln.strip()]
    report["checks"]["two_chair_requests"] = len(req_lines) >= 2
    report["checks"]["tal_named_receiver"] = "טל" in (s2["parties"] or "")
    # Self-as-both: receiver phone = Israel OR represents_both true on one request
    report["checks"]["self_move_present"] = (
        f"|{ISRAEL}|" in (s2["parties"] or "")
        and "true" in (s2["requests"] or "")
    ) or (s2["parties"] or "").count(ISRAEL) >= 2
    # Tal must not be wiped into pure self-only single request
    report["checks"]["tal_not_wiped"] = "טל" in (s2["parties"] or "")
    report["checks"]["chairs_qty_six"] = "|chairs|" in (s2["items"] or "") and "|6" in (
        s2["items"] or ""
    )
    # Both searches still present with Beit Shean address
    report["checks"]["fridge_still"] = "fridge|" in (s2["searches"] or "")
    report["checks"]["bed_still"] = "bed|" in (s2["searches"] or "")
    report["checks"]["search_beit_shean"] = "בית שאן" in (s2["searches"] or "")
    report["checks"]["search_haarbaa"] = "ארבעה" in (s2["searches"] or "")
    report["checks"]["mentions_tuesday_or_asks_name"] = any(
        x in reply2 for x in ("שלישי", "16:00", "שם", "קורא")
    )
    # No outbox outside allowlist
    out_phones = {
        ln.split("|", 1)[0]
        for ln in (s2["outbox"] or "").splitlines()
        if ln.strip()
    }
    report["checks"]["outbox_allowlist"] = out_phones.issubset({ISRAEL, TAL, ""})

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    out = "/tmp/live-conv7-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv7 retest", flush=True)


if __name__ == "__main__":
    main()
