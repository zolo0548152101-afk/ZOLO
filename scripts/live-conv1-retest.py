#!/usr/bin/env python3
"""Rerun Israel's conversation #1 burst and assert the known failure modes are gone.

Original messages (coalesced bursts):
  הייי
  יש לי מיטה למסור דחוף
  בעצם ארון לא מיטה
  + סלח על הטעיות אני בנסיעה  (present in coalesced text)

  אין תמונה עכשיו
  רגע בעצם זה 12 כסאות ולא ארון חח
  כולם תקינים
  אתם גם לוקחים מקרר?
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


def burst(label, texts, gap=0.35):
    since = time.time()
    seen = {str(m.get("id") or "") for m in chat_messages(40)}
    for t in texts:
        send_text(t)
        time.sleep(gap)
    replies = wait_replies(since, seen, min_count=1)
    items = db(
        "SELECT r.number,i.kind,i.description,i.quantity,coalesce(i.working::text,''),coalesce(i.free::text,'') "
        "FROM request_items i JOIN requests r ON r.id=i.request_id ORDER BY r.number,i.position"
    )
    photo = db("SELECT number,photo_status,status,origin FROM requests ORDER BY number")
    step = {"label": label, "replies": replies, "items": items, "requests": photo}
    report["steps"].append(step)
    print(f"DB after [{label}]: items={items} requests={photo}", flush=True)
    return step


def main():
    require_session()
    resolve_bot_chat()
    code, health = http_json("GET", f"{BOT}/health")
    report["health"] = health
    report["git_sha"] = ENV.get("GIT_SHA")
    print(f"health={health} GIT_SHA={report['git_sha']}", flush=True)
    admin_reset()

    # Burst 1 — same content as Israel's coalesced opening
    s1 = burst(
        "opening",
        [
            "הייי",
            "יש לי מיטה למסור דחוף",
            "בעצם ארון לא מיטה",
            "סלח על הטעיות אני בנסיעה",
        ],
    )
    r1 = " ".join(s1["replies"])
    # Must acknowledge wardrobe save (intro-strip must not eat it)
    ack_ok = ("ארון" in r1) and ("רשמ" in r1 or "רשמתי" in r1 or "רשמנו" in r1 or "סבבה" in r1 or "קיבל" in r1)
    # Should not be ONLY the photo question with zero acknowledgment
    report["checks"]["opening_ack_wardrobe"] = ack_ok
    report["checks"]["opening_items_wardrobe"] = "wardrobe" in s1["items"]

    # Burst 2 — correction to 12 chairs + working + fridge question
    s2 = burst(
        "chairs-fridge",
        [
            "אין תמונה עכשיו",
            "רגע בעצם זה 12 כסאות ולא ארון חח",
            "כולם תקינים",
            "אתם גם לוקחים מקרר?",
        ],
    )
    r2 = " ".join(s2["replies"])
    items = s2["items"]
    # quantity 12 chairs, not collapsed set of 1
    qty12 = "|chairs|" in items and "|12|" in items
    not_set1 = "סט של 12" not in items
    # reply should not ask to re-pick items from scratch
    no_repick = "אילו פריטים" not in r2 and "לבחור עד שני" not in r2
    # should mention chairs and answer fridge
    mentions_chairs = "כיסא" in r2 or "כסא" in r2
    answers_fridge = "מקרר" in r2
    report["checks"]["chairs_quantity_12"] = qty12
    report["checks"]["not_collapsed_set"] = not_set1 and "chairs" in items
    report["checks"]["no_repick_prompt"] = no_repick
    report["checks"]["mentions_chairs"] = mentions_chairs
    report["checks"]["answers_fridge"] = answers_fridge
    report["checks"]["photo_declined"] = "אין תמונה" in s2["requests"]

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    out = "/tmp/live-conv1-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv1 retest", flush=True)


if __name__ == "__main__":
    main()
