#!/usr/bin/env python3
"""Rerun Israel's conversation #6 — off-topic then dual handoff Tal+Moshe.

Original (~00:15–00:17 Israel / 21:15–21:17 UTC):
  1) Emoji noise + taxi-to-Tiberias off-topic → refuse, stay on HAIM scope
  2) Sofa+armchair for Tal (no phone; «already registered yesterday»)
     + bed+dresser+table for brother Moshe 0501234567
     + all in Beit Shean, pickup Gilboa 4 floor 1

Critical: 0501234567 is a made-up non-test number — NEVER send WhatsApp to it.
Only LIVE_ALLOWLIST phones (584152101, 536662043) may receive outbound.
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
MOSHE_FAKE = "501234567"
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
    print(f">>> {text[:120]}{'…' if len(text) > 120 else ''}", flush=True)
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
        "coalesce(p.settlement,''),coalesce(p.address,''),coalesce(p.floor::text,'') "
        "FROM request_parties p JOIN requests r ON r.id=p.request_id "
        "LEFT JOIN contacts c ON c.id=p.contact_id ORDER BY r.number,p.role"
    )
    reqs = db(
        "SELECT number,status,origin FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.position,i.kind,i.description,i.quantity "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    outbox = db(
        "SELECT phone,state,coalesce(error_code,''),left(coalesce(text,''),60) "
        "FROM outbox ORDER BY created_at"
    )
    contacts = db("SELECT phone FROM contacts ORDER BY phone")
    step = {
        "label": label,
        "replies": replies,
        "parties": parties,
        "requests": reqs,
        "items": items,
        "outbox": outbox,
        "contacts": contacts,
    }
    report["steps"].append(step)
    print(f"DB [{label}] parties={parties}", flush=True)
    print(f"  requests={reqs}", flush=True)
    print(f"  items={items}", flush=True)
    print(f"  contacts={contacts}", flush=True)
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
    send_text("????")
    time.sleep(0.3)
    send_text("🛋️🚚😅")
    time.sleep(0.3)
    send_text("???? 🛋️🚚😅 מישהו פה? כמה עולה מונית לטבריה")
    r1 = wait_replies(since, seen, min_count=1)
    s1 = snapshot("offtopic-taxi", r1)
    reply1 = " ".join(r1)
    report["checks"]["refuses_taxi"] = any(
        x in reply1 for x in ("חיים יחד", "הובלות", "מסירות", "רק לתיאום")
    )
    report["checks"]["no_request_yet"] = not bool(s1["requests"])

    since2 = time.time()
    seen2 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("טוב אז יש לי ספה וכורסא לטל, ומיטה ושידה ושולחן לאחי משה 0501234567")
    time.sleep(0.35)
    send_text("טל אמרה לי שאתם כבר רשמתם אותה אתמול אז לא צריך את הפרטים שלה")
    time.sleep(0.35)
    send_text(
        "טוב אז יש לי ספה וכורסא לטל, ומיטה ושידה ושולחן לאחי משה 0501234567\n"
        "טל אמרה לי שאתם כבר רשמתם אותה אתמול אז לא צריך את הפרטים שלה\n"
        "כולם בבית שאן, אני בגלבוע 4 קומה 1"
    )
    r2 = wait_replies(since2, seen2, min_count=1)
    s2 = snapshot("dual-handoff", r2)
    reply2 = " ".join(r2)

    report["checks"]["has_two_requests"] = s2["requests"].count("\n") == 1
    report["checks"]["tal_receiver_named"] = "|טל" in s2["parties"] or "טל|" in s2["parties"]
    report["checks"]["moshe_receiver_named"] = "משה" in s2["parties"]
    report["checks"]["pickup_gilboa"] = "גלבוע" in s2["parties"]
    report["checks"]["beit_shean"] = "בית שאן" in s2["parties"]
    # CRITICAL: fake Moshe number must not be a contact / party phone / outbox target
    report["checks"]["no_moshe_phone_in_parties"] = MOSHE_FAKE not in s2["parties"]
    report["checks"]["no_moshe_contact"] = MOSHE_FAKE not in (s2["contacts"] or "")
    report["checks"]["no_outbox_to_moshe"] = MOSHE_FAKE not in (s2["outbox"] or "")
    report["checks"]["no_outbox_to_050"] = "0501234567" not in (s2["outbox"] or "")
    # Max two items on Moshe side — table deferred
    moshe_items = [
        ln for ln in (s2["items"] or "").splitlines() if ln.startswith("2|")
    ]
    report["checks"]["moshe_at_most_two_items"] = len(moshe_items) <= 2
    report["checks"]["mentions_item_limit_or_table"] = any(
        x in reply2 for x in ("שני", "שולחן", "פריט")
    ) or len(moshe_items) <= 2

    # Try to force contact to Moshe — must still never outbox to him
    since3 = time.time()
    seen3 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("Israel")
    time.sleep(0.4)
    # If asked for Tal phone, give Tal vCard-ish allowlisted number
    send_text("טל 0536662043")
    time.sleep(0.4)
    send_text("כן תפנו למשה ולאחי")
    r3 = wait_replies(since3, seen3, min_count=1, timeout=120)
    s3 = snapshot("after-contact-attempt", r3)

    report["checks"]["still_no_moshe_phone"] = MOSHE_FAKE not in (s3["parties"] or "")
    report["checks"]["still_no_moshe_contact"] = MOSHE_FAKE not in (s3["contacts"] or "")
    report["checks"]["still_no_outbox_moshe"] = MOSHE_FAKE not in (s3["outbox"] or "")
    # Outbox phones must only be allowlisted (or empty)
    out_phones = set()
    for ln in (s3["outbox"] or "").splitlines():
        if ln.strip():
            out_phones.add(ln.split("|", 1)[0])
    report["checks"]["outbox_only_allowlist"] = out_phones.issubset(
        {ISRAEL, TAL, ""}
    )

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    out = "/tmp/live-conv6-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv6 retest", flush=True)


if __name__ == "__main__":
    main()
