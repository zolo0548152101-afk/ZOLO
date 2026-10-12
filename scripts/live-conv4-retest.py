#!/usr/bin/env python3
"""Rerun Israel's conversation #4 — Beit Shean pickup + Afula destination.

Original (~23:42–23:44 Israel):
  1) Long message: Hashikma 7 floor 2 — wardrobe (disassemble), table+6 chairs,
     damaged sofa; all going to cousin in Afula.
  2) Want a real person + then «טוב עזוב», cousin will pick up at friend
     Yehuda Halevi 3 in Beit Shean.

Bugs: opening next-only lost all pickup facts; table_set got needs_disassembly;
customer_request escalate only noted without human status / false handoff claim.
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

OPENING = (
    "אז ככה תקשיבי אני מנסה להסביר אממ יש לנו פה בבית שאן ברחוב השקמה 7 קומה 2 "
    "כזה ארון שלוש דלתות שצריך לפרק אותו כי הוא לא עובר בדלת וגם יש שולחן אוכל "
    "עם שישה כיסאות ואה כן הספה אבל הספה האמת קצת קרועה בצד והכלב שלנו נשך אותה "
    "אבל עוד אפשר לשבת עליה בקיצור הכל הולך לבן דוד שלי בעפולה"
)

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
    print(f">>> {text[:80]}{'…' if len(text) > 80 else ''}", flush=True)
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
        "SELECT number,status,origin,coalesce(human_reason,''),needs_distance_check::text "
        "FROM requests ORDER BY number"
    )
    items = db(
        "SELECT r.number,i.position,i.kind,i.description,i.quantity,"
        "coalesce(i.working::text,''),coalesce(i.needs_disassembly::text,'') "
        "FROM request_items i JOIN requests r ON r.id=i.request_id "
        "ORDER BY r.number,i.position"
    )
    step = {
        "label": label,
        "replies": replies,
        "parties": parties,
        "requests": reqs,
        "items": items,
    }
    report["steps"].append(step)
    print(f"DB [{label}] parties={parties}", flush=True)
    print(f"  requests={reqs}", flush=True)
    print(f"  items={items}", flush=True)
    return step


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
    send_text(OPENING)
    r1 = wait_replies(since, seen, min_count=1)
    s1 = snapshot("opening-afula", r1)
    reply1 = " ".join(r1)

    # Must refuse Afula but KEEP Beit Shean pickup facts
    report["checks"]["mentions_afula_refuse"] = "עפולה" in reply1
    report["checks"]["has_request"] = bool(s1["requests"])
    report["checks"]["settlement_beit_shean"] = "בית שאן" in s1["parties"]
    report["checks"]["address_hashikma"] = "שקמה" in s1["parties"]
    report["checks"]["floor_2"] = "|2" in s1["parties"] or s1["parties"].endswith("|2")
    report["checks"]["has_wardrobe"] = "wardrobe" in s1["items"]
    report["checks"]["has_table_set"] = "table_set" in s1["items"]
    report["checks"]["no_sofa_item"] = "sofa" not in s1["items"]
    # fields: number|pos|kind|desc|qty|working|needs_disassembly
    wardrobe_line = next((ln for ln in s1["items"].splitlines() if "|wardrobe|" in ln), "")
    table_line = next((ln for ln in s1["items"].splitlines() if "|table_set|" in ln), "")
    w_parts = wardrobe_line.split("|")
    t_parts = table_line.split("|")
    report["checks"]["wardrobe_disassemble"] = len(w_parts) > 6 and w_parts[6] == "true"
    report["checks"]["table_not_disassemble"] = (not table_line) or (
        len(t_parts) > 6 and t_parts[6] != "true"
    )

    since2 = time.time()
    seen2 = {str(m.get("id") or "") for m in chat_messages(40)}
    send_text("אוף אני רוצה לדבר עם בן אדם אמיתי")
    time.sleep(0.4)
    send_text("טוב עזוב, הבן דוד יבוא לקחת אצל חבר שלו בבית שאן, רחוב יהודה הלוי 3")
    r2 = wait_replies(since2, seen2, min_count=1)
    s2 = snapshot("yehuda-halevi", r2)
    reply2 = " ".join(r2)

    # After עזוב — should NOT be stuck in human; should update address
    status = s2["requests"].split("|")[1] if s2["requests"] else ""
    report["checks"]["not_human_after_azov"] = status != "human"
    report["checks"]["address_yehuda"] = "יהודה" in s2["parties"] or "הלוי" in s2["parties"]
    report["checks"]["still_beit_shean"] = "בית שאן" in s2["parties"]
    report["checks"]["items_still_two"] = (
        "wardrobe" in s2["items"] and "table_set" in s2["items"] and "sofa" not in s2["items"]
    )
    # table_set still must not have needs_disassembly true after item_facts
    t2 = next((ln for ln in s2["items"].splitlines() if "|table_set|" in ln), "")
    t2p = t2.split("|")
    report["checks"]["table_still_not_disassemble"] = len(t2p) <= 6 or t2p[6] != "true"
    report["checks"]["no_false_human_claim"] = not (
        status != "human" and ("נציג" in reply2 and "העבר" in reply2 and "אדם אמיתי" in reply2)
    )

    report["ok"] = all(report["checks"].values())
    report["finished_at"] = datetime.now(TZ).isoformat()
    out = "/tmp/live-conv4-retest-report.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["ok"]:
        failed = [k for k, v in report["checks"].items() if not v]
        raise SystemExit(f"FAIL checks: {failed}")
    print("PASS conv4 retest", flush=True)


if __name__ == "__main__":
    main()
