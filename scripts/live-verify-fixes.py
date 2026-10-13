#!/usr/bin/env python3
"""Live verify: contact-order, no invented אפנה, outside-area reuse. From 0584152101."""
from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

ENV = {}
for line in open("/root/haim-bot.env"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    ENV[k] = v.strip().strip('"')

WAHA_KEY = ENV["WAHA_API_KEY"]
HMAC_KEY = ENV["WAHA_WEBHOOK_HMAC_KEY"]
ADMIN = ENV["HAIM_ADMIN_TOKEN"]
BOT = "http://127.0.0.1:3010"
ISRAEL = "584152101"
SESSION = "HAIM_YAHAD"

report = {
    "at": datetime.now(timezone.utc).isoformat(),
    "health": None,
    "commit": None,
    "flows": [],
    "checks": [],
    "ok": True,
}


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


def check(name: str, cond: bool, detail=None):
    report["checks"].append({"check": name, "ok": bool(cond), "detail": detail})
    if not cond:
        report["ok"] = False
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" :: {detail}" if detail is not None else ""), flush=True)


def admin_clear():
    body = json.dumps({"confirm": "מחק הכל"}).encode()
    req = urllib.request.Request(
        f"{BOT}/admin/database/clear-all",
        data=body,
        headers={"Content-Type": "application/json", "x-admin-token": ADMIN},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def send(text: str):
    payload = {
        "event": "message",
        "session": SESSION,
        "payload": {
            "id": f"live-{uuid.uuid4()}",
            "from": f"972{ISRAEL}@c.us",
            "fromMe": False,
            "body": text,
            "type": "chat",
            "timestamp": int(time.time()),
        },
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    sig = hmac.new(HMAC_KEY.encode(), raw, hashlib.sha512).hexdigest()
    req = urllib.request.Request(
        f"{BOT}/webhooks/waha",
        data=raw,
        headers={"Content-Type": "application/json", "x-webhook-hmac": sig},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def now_db() -> str:
    return db("SELECT now()::text")


def wait_reply(since: str, timeout=55) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = db(
            "SELECT replace(replace(o.text,E'\\n',' '), '|','/') "
            "FROM outbox o WHERE o.phone LIKE '%584152101' "
            f"AND o.created_at > timestamptz '{since}' "
            "ORDER BY o.created_at DESC LIMIT 1"
        )
        if rows and rows.strip():
            return rows
        row = db(
            "SELECT replace(replace(coalesce(m.reply,''),E'\\n',' '), '|','/') "
            "FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id "
            "WHERE (c.phone LIKE '%584152101' OR m.chat_id LIKE '%584152101%') "
            f"AND m.received_at > timestamptz '{since}' "
            "AND coalesce(m.reply,'')<>'' ORDER BY m.seq DESC LIMIT 1"
        )
        if row and row.strip():
            return row
        time.sleep(1.2)
    return None


def step(text: str) -> str | None:
    before = now_db()
    print(f">>> {text}", flush=True)
    send(text)
    reply = wait_reply(before)
    print(f"<<< {reply}", flush=True)
    time.sleep(1.5)
    return reply


def requests_table() -> str:
    return db("SELECT number||':'||status||':'||origin FROM requests ORDER BY number")


def latest_request():
    row = db(
        "SELECT number,status,origin,verification_contacted::text "
        "FROM requests ORDER BY number DESC LIMIT 1"
    )
    if not row:
        return None
    n, s, o, vc = row.split("|")
    return {
        "number": int(n),
        "status": s,
        "origin": o,
        "verification_contacted": vc.lower() in ("t", "true", "1"),
    }


def donor_fields():
    row = db(
        "SELECT coalesce(p.name,''),coalesce(p.settlement,''),coalesce(p.address,'') "
        "FROM request_parties p JOIN contacts c ON c.id=p.contact_id "
        "JOIN requests r ON r.id=p.request_id "
        "WHERE c.phone LIKE '%584152101' AND p.role='donor' "
        "ORDER BY r.number DESC LIMIT 1"
    )
    if not row:
        return None
    name, settlement, address = row.split("|")
    return {"name": name, "settlement": settlement, "address": address}


# ---------- bootstrap ----------
report["health"] = json.loads(urllib.request.urlopen(f"{BOT}/health").read().decode())
report["commit"] = subprocess.check_output(
    ["git", "-C", "/etc/easypanel/projects/whatsapp/haim-bot-core/code", "rev-parse", "--short", "HEAD"],
    text=True,
).strip()
print("health", report["health"], "commit", report["commit"], flush=True)
print("CLEAR", admin_clear(), flush=True)
time.sleep(1)

# ---------- FLOW A: contact only after own details ----------
print("\n===== A contact-after-details =====", flush=True)
flow_a = {"name": "contact_after_details", "steps": []}
r = step("יש לי מיטה תקינה למסירה לטל 0536662043")
flow_a["steps"].append({"in": "open+tal", "out": r})
check("A1 no early contact ask", r is not None and "האם תרצה שנפנה" not in r, r)
check("A1 no invented אפנה", r is not None and "אפנה" not in r, r)
check("A1 asks donor detail or continues", r is not None and any(x in r for x in ("יישוב", "שם", "כתובת", "תודה", "בשמחה")), r)

r = step("בית שאן")
flow_a["steps"].append({"in": "settlement", "out": r})
check("A2 still no contact ask", r is not None and "האם תרצה שנפנה" not in r, r)

r = step("ישראל רחוב אילת 4")
flow_a["steps"].append({"in": "name+address", "out": r})
donor = donor_fields()
flow_a["donor"] = donor
check("A3 donor saved", bool(donor and donor["name"] and donor["settlement"] and donor["address"]), donor)
check("A3 now may ask contact", r is not None and ("האם תרצה שנפנה" in r or "נפנה" in r or "פרטים נשמרו" in r), r)
check("A3 never אפנה without consent path", "אפנה" not in (r or ""), r)
req = latest_request()
check("A3 not verification_contacted yet", req and req["verification_contacted"] is False, req)
report["flows"].append(flow_a)

# ---------- FLOW B: screenshot path — named handoff then details ----------
print("\n===== B named handoff no אפנה =====", flush=True)
print("CLEAR", admin_clear(), flush=True)
time.sleep(1)
flow_b = {"name": "named_handoff_no_afna", "steps": []}
r = step("יש לי כיסא למסירה")
flow_b["steps"].append({"in": "open", "out": r})
r = step("מוסר למשה הוא מאשר")
flow_b["steps"].append({"in": "moshe", "out": r})
check("B1 after משה: no אפנה", r is not None and "אפנה" not in r, r)
check("B1 after משה: no contact-now claim", r is not None and "נפנה לצד השני עכשיו" not in r, r)
check("B1 asks missing donor field", r is not None and any(x in r for x in ("יישוב", "שם", "כתובת", "טלפון", "איש קשר")), r)
r = step("0536662043")
flow_b["steps"].append({"in": "phone", "out": r})
check("B2 after phone: no אפנה", r is not None and "אפנה" not in r, r)
r = step("כן")
flow_b["steps"].append({"in": "yes", "out": r})
check("B3 after כן: no אפנה", r is not None and "אפנה" not in r, r)
check("B3 continues donor details", r is not None and any(x in r for x in ("יישוב", "שם", "כתובת", "קישרתי", "תודה")), r)
report["flows"].append(flow_b)

# ---------- FLOW C: outside-area reopen same request ----------
print("\n===== C outside-area reuse =====", flush=True)
print("CLEAR", admin_clear(), flush=True)
time.sleep(1)
flow_c = {"name": "outside_area_reuse", "steps": []}
r = step("יש לי ספה למסירה לטל 0536662043")
flow_c["steps"].append({"in": "open", "out": r})
n1 = latest_request()["number"]
flow_c["n1"] = n1
r = step("טבריה רחוב הגליל 1")
flow_c["steps"].append({"in": "tiberias", "out": r})
check("C1 outside reply", r is not None and ("לא נוכל" in r or "בית שאן" in r), r)
check("C1 status rejected", latest_request() and latest_request()["status"] == "rejected", latest_request())
check("C1 same number after reject", latest_request()["number"] == n1, requests_table())
# restate donation (AI-style new donate) with allowed town
r = step("אני רוצה למסור את הספה בבית שאן רחוב אילת 4, השם ישראל")
flow_c["steps"].append({"in": "correct", "out": r})
flow_c["after"] = requests_table()
open_n = db("SELECT count(*) FROM requests WHERE status NOT IN ('rejected','cancelled','closed')")
check("C2 one open request", open_n == "1", open_n)
check("C2 same number reopened", latest_request()["number"] == n1 and latest_request()["status"] == "collecting", latest_request())
check("C2 no twin request", db("SELECT count(*) FROM requests") == "1", requests_table())
report["flows"].append(flow_c)

# ---------- FLOW D: open donation still photo-first ----------
print("\n===== D open donation photo =====", flush=True)
print("CLEAR", admin_clear(), flush=True)
time.sleep(1)
flow_d = {"name": "open_donation_photo", "steps": []}
r = step("יש לי מיטה זוגית תקינה למסירה בבית שאן")
flow_d["steps"].append({"in": "open", "out": r})
check("D1 photo gate", r is not None and "תמונה" in r, r)
check("D1 origin donation", latest_request() and latest_request()["origin"] == "donation", latest_request())
report["flows"].append(flow_d)

print("\n===== SUMMARY =====", flush=True)
passed = sum(1 for c in report["checks"] if c["ok"])
failed = sum(1 for c in report["checks"] if not c["ok"])
print(f"passed={passed} failed={failed} ok={report['ok']}", flush=True)
out = "/tmp/live-verify-fixes-report.json"
with open(out, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("wrote", out, flush=True)
raise SystemExit(0 if report["ok"] else 1)
