#!/usr/bin/env python3
"""Live matrix: 4 conversation types + forbidden behaviors + DB recording review."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
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
WAHA = "http://127.0.0.1:3001"
BOT = "http://127.0.0.1:3010"
BOT_CHAT = "972543414386@c.us"
TAL = "972536662043@c.us"
ISRAEL = "584152101"
SESSION = "HAIM_YAHAD"
PHOTO_WORDS = ("תמונה", "צלם", "צילום", "שלח תמונה", "מצרף תמונה", "photo")
# Past-tense / assertive claims only. "האם תרצה שנפנה…" is a consent ASK, not a claim.
CONSENT_CLAIM = ("פנינו", "יצרנו קשר", "שולחים הודעה", "נשלח הודעה", "נפנה לצד השני עכשיו")


def invents_contact_before_consent(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    # Permission questions are the allowed consent prompt.
    if re.search(r"(?:האם|תרצ[הי]|רוצה|אפשר).{0,30}נפנה", t):
        return False
    return contains_any(t, CONSENT_CLAIM)


def db(sql: str) -> str:
    url = ENV["DATABASE_URL"]
    u = urllib.parse.urlparse(url)
    cid = (
        subprocess.check_output(["docker", "ps", "-qf", "name=whatsapp_haim-db"], text=True)
        .strip()
        .split("\n")[0]
    )
    out = subprocess.check_output(
        [
            "docker",
            "exec",
            "-e",
            f"PGPASSWORD={u.password}",
            "-e",
            "PGOPTIONS=-c search_path=haim_core",
            cid,
            "psql",
            "-U",
            u.username,
            "-d",
            u.path.lstrip("/"),
            "-At",
            "-F",
            "|",
            "-c",
            sql,
        ],
        text=True,
    )
    return out.strip()


def admin_clear():
    """Reset disposable test DB between flows (authorized clear-all)."""
    body = json.dumps({"confirm": "מחק הכל"}).encode()
    req = urllib.request.Request(
        f"{BOT}/admin/database/clear-all",
        data=body,
        headers={"Content-Type": "application/json", "x-admin-token": ADMIN},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def clear_phone(phone: str):
    """Best-effort single-phone wipe; falls back to cancel-phone if clear-phone fails."""
    try:
        body = json.dumps({"phone": phone, "confirm": "מחק מספר"}).encode()
        req = urllib.request.Request(
            f"{BOT}/admin/database/clear-phone",
            data=body,
            headers={"Content-Type": "application/json", "x-admin-token": ADMIN},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except Exception:
        body = json.dumps({"phone": phone, "confirm": "בטל פניות"}).encode()
        req = urllib.request.Request(
            f"{BOT}/admin/requests/cancel-phone",
            data=body,
            headers={"Content-Type": "application/json", "x-admin-token": ADMIN},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)


def waha_send(text: str):
    body = json.dumps({"session": "default", "chatId": BOT_CHAT, "text": text}).encode()
    req = urllib.request.Request(
        f"{WAHA}/api/sendText",
        data=body,
        headers={"Content-Type": "application/json", "X-Api-Key": WAHA_KEY},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def signed_webhook(phone_chat: str, text: str, session: str = SESSION):
    payload = {
        "event": "message",
        "session": session,
        "payload": {
            "id": f"live-{uuid.uuid4()}",
            "from": phone_chat,
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
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, json.load(r)


def pg_bool(value: str | None) -> bool:
    """Postgres bool::text is 'true'/'false'; some casts still yield 't'/'f'."""
    return (value or "").strip().lower() in ("t", "true", "1", "yes")


def latest_request():
    row = db(
        "SELECT number,status,origin,verification_contacted::text,"
        "represents_both_parties::text,COALESCE(proposed_run_date::text,''),"
        "COALESCE(run_date::text,'') FROM requests ORDER BY number DESC LIMIT 1"
    )
    if not row:
        return None
    num, status, origin, vc, both, proposed, run_date = row.split("|")
    return {
        "number": int(num),
        "status": status,
        "origin": origin,
        "verification_contacted": pg_bool(vc),
        "represents_both_parties": pg_bool(both),
        "proposed": proposed or None,
        "run_date": run_date or None,
    }


def parties(n: int):
    rows = db(
        f"SELECT p.role,c.phone,COALESCE(p.name,''),COALESCE(p.settlement,''),"
        f"COALESCE(p.address,''),COALESCE(p.floor::text,''),"
        f"(p.approved_at IS NOT NULL)::text,p.schedule_approved::text "
        f"FROM request_parties p JOIN contacts c ON c.id=p.contact_id "
        f"JOIN requests r ON r.id=p.request_id WHERE r.number={int(n)} ORDER BY p.role"
    )
    out = []
    for line in rows.splitlines():
        if not line:
            continue
        role, phone, name, sett, addr, floor, appr, sched = line.split("|")
        out.append(
            {
                "role": role,
                "phone": phone,
                "name": name or None,
                "settlement": sett or None,
                "address": addr or None,
                "floor": int(floor) if floor.isdigit() else (None if floor == "" else floor),
                "approved": pg_bool(appr),
                "schedule_approved": pg_bool(sched),
            }
        )
    return out


def items(n: int):
    rows = db(
        f"SELECT COALESCE(kind,''),COALESCE(description,''),COALESCE(quantity::text,'') "
        f"FROM request_items i JOIN requests r ON r.id=i.request_id WHERE r.number={int(n)}"
    )
    out = []
    for line in rows.splitlines():
        if not line:
            continue
        kind, desc, qty = line.split("|")
        out.append({"kind": kind or None, "description": desc or None, "quantity": qty or None})
    return out


def searches():
    rows = db(
        "SELECT s.kind,s.state,c.phone,s.updated_at::text "
        "FROM searches s JOIN contacts c ON c.id=s.contact_id "
        "ORDER BY s.updated_at DESC LIMIT 5"
    )
    out = []
    for line in rows.splitlines():
        if not line:
            continue
        kind, state, phone, updated = line.split("|")
        out.append({"kind": kind or None, "state": state or None, "phone": phone or None, "updated_at": updated})
    return out


def outbox_for(phone_suffix: str, limit=3):
    rows = db(
        f"SELECT replace(replace(left(text,280), E'\\n', ' '), '|', '/'),"
        f"state,COALESCE(request_id::text,''),created_at::text "
        f"FROM outbox WHERE phone LIKE '%{phone_suffix}' ORDER BY created_at DESC LIMIT {limit}"
    )
    out = []
    for line in rows.splitlines():
        if not line or "|" not in line:
            continue
        text, status, rid, created = line.split("|", 3)
        out.append({"text": text, "status": status, "request_id": rid or None, "created_at": created})
    return out


def last_ai():
    row = db(
        "SELECT replace(replace(left(COALESCE(m.text,''),80), E'\\n', ' '), '|', '/'),"
        "replace(replace(left(COALESCE(m.ai_plan::text,''),400), E'\\n', ' '), '|', '/') "
        "FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id "
        "WHERE c.phone LIKE '%584152101' OR m.chat_id LIKE '%584152101%' "
        "ORDER BY m.seq DESC LIMIT 1"
    )
    if not row or "|" not in row:
        return None
    text, plan = row.split("|", 1)
    return {"text": text, "ai_plan": plan}


def conversation_mode():
    row = db(
        "SELECT conv.mode,COALESCE(conv.selected_request_id::text,''),"
        "COALESCE(conv.pending_counterparty_name,''),COALESCE(conv.pending_counterparty_phone,'') "
        "FROM conversations conv JOIN contacts c ON c.id=conv.contact_id "
        "WHERE c.phone LIKE '%584152101' LIMIT 1"
    )
    if not row:
        return None
    mode, sel, pending, pending_phone = row.split("|", 3)
    return {
        "mode": mode,
        "selected_request_id": sel or None,
        "pending_name": pending or None,
        "pending_phone": pending_phone or None,
    }


def wait_reply(phone_suffix: str, since_iso: str | None, timeout=45):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = outbox_for(phone_suffix, limit=5)
        for row in rows:
            if since_iso and row["created_at"] <= since_iso:
                continue
            return row
        time.sleep(1.5)
    return None


def now_db():
    return db("SELECT now()::text")


def contains_any(text: str, words) -> bool:
    t = (text or "").lower()
    return any(w.lower() in t for w in words)


def check(name: str, cond: bool, detail=None):
    entry = {"check": name, "ok": bool(cond), "detail": detail}
    report["checks"].append(entry)
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {name}" + (f" :: {detail}" if detail is not None else ""), flush=True)
    return cond


def snapshot(label: str):
    req = latest_request()
    snap = {
        "label": label,
        "request": req,
        "parties": parties(req["number"]) if req else [],
        "items": items(req["number"]) if req else [],
        "searches": searches(),
        "israel_outbox": outbox_for(ISRAEL, 2),
        "tal_outbox": outbox_for("536662043", 2),
        "ai": last_ai(),
        "conversation": conversation_mode(),
    }
    report["snapshots"].append(snap)
    print(json.dumps({"snap": label, "request": req, "parties": snap["parties"], "items": snap["items"],
                      "searches": snap["searches"][:2], "reply": (snap["israel_outbox"][0]["text"] if snap["israel_outbox"] else None)},
                     ensure_ascii=False), flush=True)
    return snap


def wait_processed(marker_substr: str, timeout=50):
    """Wait until the inbound message is processed (and ideally has a reply)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        row = db(
            "SELECT id::text, coalesce(reply,''), coalesce(error_code,''), "
            "(processed_at is not null)::text "
            f"FROM messages WHERE text LIKE '%{marker_substr.replace('|','')}%' "
            "ORDER BY seq DESC LIMIT 1"
        )
        if row and "|" in row:
            mid, reply, err, processed = row.split("|", 3)
            if pg_bool(processed):
                return {"id": mid, "reply": reply or None, "error": err or None}
        time.sleep(1.2)
    return None


def send_and_wait(text: str, wait=8):
    before = now_db()
    print(f"\n>>> SEND: {text}", flush=True)
    res = waha_send(text)
    # Prefer durable DB processing over outbox timing — reply-manager can lag.
    marker = text[-40:] if len(text) > 40 else text
    processed = wait_processed(marker, timeout=55)
    reply = wait_reply(ISRAEL, before, timeout=20)
    if not reply and processed and processed.get("reply"):
        reply = {"text": processed["reply"], "status": "db", "request_id": None, "created_at": now_db()}
    print(f"<<< REPLY: {(reply or {}).get('text')}", flush=True)
    if processed and processed.get("error"):
        print(f"<<< ERROR_CODE: {processed['error']}", flush=True)
    # small settle for request rows after commit
    time.sleep(wait)
    return res, reply


report = {
    "at": datetime.now(timezone.utc).isoformat(),
    "commit": subprocess.check_output(
        ["git", "-C", "/etc/easypanel/projects/whatsapp/haim-bot-core/code", "rev-parse", "--short", "HEAD"],
        text=True,
    ).strip(),
    "flows": {},
    "checks": [],
    "snapshots": [],
    "recording_review": {},
}

# ---------- FLOW 1: direct_handoff ----------
print("\n========== FLOW 1 direct_handoff ==========", flush=True)
admin_clear()
time.sleep(1)
flow = {"name": "direct_handoff", "steps": []}

_, reply1 = send_and_wait(
    "יש לי מנורה שולחנית תקינה למסירה ישירות לטל 0536662043. אני מבית שאן.",
    wait=18,
)
snap1 = snapshot("direct_after_open")
flow["steps"].append({"inbound": "open", "reply": (reply1 or {}).get("text"), "snap": "direct_after_open"})

check("direct: request created", snap1["request"] is not None)
if snap1["request"]:
    check("direct: origin=direct", snap1["request"]["origin"] == "direct", snap1["request"]["origin"])
    check(
        "direct: phone alone does NOT set verification_contacted",
        snap1["request"]["verification_contacted"] is False,
        snap1["request"]["verification_contacted"],
    )
check(
    "direct: no photo gate",
    reply1 is not None and not contains_any(reply1.get("text") or "", PHOTO_WORDS),
    (reply1 or {}).get("text"),
)
check(
    "direct: does not invent contact/send before consent",
    reply1 is not None and not invents_contact_before_consent(reply1.get("text") or ""),
    (reply1 or {}).get("text"),
)
recv = next((p for p in snap1["parties"] if p["role"] == "receiver"), None)
check("direct: recipient linked by phone", bool(recv and "536662043" in (recv.get("phone") or "")), recv)

_, reply1b = send_and_wait(
    "איסוף העלייה 5 דירה 2 מסירה העלייה 8 דירה 1",
    wait=18,
)
snap1b = snapshot("direct_after_dira")
flow["steps"].append({"inbound": "dira addresses", "reply": (reply1b or {}).get("text"), "snap": "direct_after_dira"})
donor = next((p for p in snap1b["parties"] if p["role"] == "donor"), None)
recv = next((p for p in snap1b["parties"] if p["role"] == "receiver"), None)
check("forbidden דירה≠floor: donor.floor is null", donor is not None and donor.get("floor") is None, donor)
check("forbidden דירה≠floor: receiver.floor is null", recv is not None and recv.get("floor") is None, recv)
check(
    "direct: addresses retained from דירה message",
    bool(donor and donor.get("address") and recv and recv.get("address")),
    {"donor": donor, "receiver": recv},
)
check(
    "direct: still no verification without consent",
    snap1b["request"] and snap1b["request"]["verification_contacted"] is False,
    snap1b["request"],
)

_, reply1c = send_and_wait("מאשר ליצור קשר", wait=20)
snap1c = snapshot("direct_after_consent")
flow["steps"].append({"inbound": "consent", "reply": (reply1c or {}).get("text"), "snap": "direct_after_consent"})
# poll briefly for verification outbox
for _ in range(12):
    if snap1c["request"] and snap1c["request"]["verification_contacted"]:
        break
    if outbox_for("536662043"):
        break
    time.sleep(2)
    snap1c = snapshot("direct_after_consent_poll")
check(
    "direct: consent enables verification_contacted or tal outbox",
    bool(
        (snap1c["request"] and snap1c["request"]["verification_contacted"])
        or snap1c["tal_outbox"]
    ),
    {"request": snap1c["request"], "tal_outbox": snap1c["tal_outbox"][:1]},
)
report["flows"]["direct_handoff"] = flow

# ---------- FLOW 2: open_donation ----------
print("\n========== FLOW 2 open_donation ==========", flush=True)
admin_clear()
time.sleep(1)
flow = {"name": "open_donation", "steps": []}

_, reply2 = send_and_wait(
    "יש לי מיטה זוגית תקינה למסירה בבית שאן רחוב העלייה קומה 2",
    wait=18,
)
snap2 = snapshot("donate_open")
flow["steps"].append({"inbound": "open", "reply": (reply2 or {}).get("text"), "snap": "donate_open"})
check("donate: request created", snap2["request"] is not None)
if snap2["request"]:
    check(
        "donate: origin=donation (open)",
        snap2["request"]["origin"] == "donation",
        snap2["request"]["origin"],
    )
check(
    "donate: PHOTO-FIRST gate",
    reply2 is not None and contains_any(reply2.get("text") or "", PHOTO_WORDS),
    (reply2 or {}).get("text"),
)
check(
    "donate: does not ask name before photo",
    reply2 is not None and "שם" not in (reply2.get("text") or ""),
    (reply2 or {}).get("text"),
)
donor = next((p for p in snap2["parties"] if p["role"] == "donor"), None)
check(
    "donate: opening facts retained (settlement/floor)",
    bool(donor and donor.get("settlement") == "בית שאן" and donor.get("floor") == 2),
    donor,
)
check(
    "donate: no invented recipient",
    not any(p.get("role") == "receiver" and p.get("phone") for p in snap2["parties"]),
    snap2["parties"],
)
report["flows"]["open_donation"] = flow

# ---------- FLOW 3: self_transfer ----------
print("\n========== FLOW 3 self_transfer ==========", flush=True)
admin_clear()
time.sleep(1)
flow = {"name": "self_transfer", "steps": []}

_, reply3 = send_and_wait(
    "אני רוצה להעביר לעצמי שולחן מבית שאן רחוב העלייה קומה 1 לבית שאן רחוב העלייה קומה 2",
    wait=20,
)
snap3 = snapshot("self_open")
flow["steps"].append({"inbound": "open", "reply": (reply3 or {}).get("text"), "snap": "self_open"})
check("self: request created", snap3["request"] is not None)
if snap3["request"]:
    check(
        "self: represents_both_parties",
        snap3["request"]["represents_both_parties"] is True,
        snap3["request"],
    )
roles = {p["role"]: p for p in snap3["parties"]}
check("self: has donor and receiver roles", "donor" in roles and "receiver" in roles, roles)
if "donor" in roles and "receiver" in roles:
    check(
        "self: same person both roles",
        roles["donor"]["phone"] == roles["receiver"]["phone"],
        {"donor": roles["donor"]["phone"], "receiver": roles["receiver"]["phone"]},
    )
    check(
        "self: distinct floors (1 vs 2)",
        roles["donor"].get("floor") == 1 and roles["receiver"].get("floor") == 2,
        {"donor_floor": roles["donor"].get("floor"), "receiver_floor": roles["receiver"].get("floor")},
    )
    check(
        "forbidden merge_addresses: endpoints not identical",
        not (
            roles["donor"].get("address") == roles["receiver"].get("address")
            and roles["donor"].get("floor") == roles["receiver"].get("floor")
            and roles["donor"].get("settlement") == roles["receiver"].get("settlement")
        ),
        roles,
    )
check(
    "self: no photo gate",
    reply3 is not None and not contains_any(reply3.get("text") or "", PHOTO_WORDS),
    (reply3 or {}).get("text"),
)
report["flows"]["self_transfer"] = flow

# ---------- FLOW 4: open_request ----------
print("\n========== FLOW 4 open_request ==========", flush=True)
admin_clear()
time.sleep(1)
flow = {"name": "open_request", "steps": []}

_, reply4 = send_and_wait("אני מחפש לקבל מיטה זוגית בבית שאן", wait=18)
snap4 = snapshot("request_open")
flow["steps"].append({"inbound": "open", "reply": (reply4 or {}).get("text"), "snap": "request_open"})
check(
    "request: seeker path (search and/or no donor request)",
    bool(snap4["searches"]) or (snap4["request"] is None) or (
        snap4["request"] and snap4["request"]["origin"] not in ("direct",)
        and not any(p.get("role") == "donor" and p.get("phone") == ISRAEL for p in snap4["parties"])
    ),
    {"searches": snap4["searches"][:2], "request": snap4["request"], "parties": snap4["parties"]},
)
check(
    "request: no photo gate",
    reply4 is not None and not contains_any(reply4.get("text") or "", PHOTO_WORDS),
    (reply4 or {}).get("text"),
)
# If a request was opened as donation by mistake, fail donor_flow
mistaken_donor = (
    snap4["request"]
    and snap4["request"]["origin"] in ("general", "open", "donation")
    and any(p.get("role") == "donor" and ISRAEL in (p.get("phone") or "") for p in snap4["parties"])
    and not snap4["searches"]
)
check("forbidden: seeker not treated as donor-only", not mistaken_donor, snap4)

_, reply4b = send_and_wait("עדיף רחוב העלייה קומה 2", wait=16)
snap4b = snapshot("request_details")
flow["steps"].append({"inbound": "address", "reply": (reply4b or {}).get("text"), "snap": "request_details"})
check(
    "request: still no photo after details",
    reply4b is not None and not contains_any(reply4b.get("text") or "", PHOTO_WORDS),
    (reply4b or {}).get("text"),
)
check(
    "request: seek follow-up does not escalate to human/fault",
    (snap4b.get("conversation") or {}).get("mode") == "bot"
    and not contains_any(reply4b.get("text") or "", ("תקלה זמנית", "טיפול אנושי"))
    and not (snap4b.get("ai") or {}).get("error"),
    {"mode": (snap4b.get("conversation") or {}).get("mode"), "reply": (reply4b or {}).get("text")},
)
# Also inspect last processed error for this marker
err4 = db(
    "SELECT coalesce(error_code,'') FROM messages "
    "WHERE text LIKE '%עדיף רחוב העלייה%' ORDER BY seq DESC LIMIT 1"
)
check(
    "request: seek follow-up has no openai_failure_escalated",
    "openai_failure" not in (err4 or ""),
    err4,
)
report["flows"]["open_request"] = flow

# ---------- Recording review ----------
print("\n========== RECORDING REVIEW ==========", flush=True)
# Reconstruct from snapshots what was recorded across flows
def snap_by(label: str):
    for s in report["snapshots"]:
        if s["label"] == label:
            return s
    return None


def last_snap_prefix(prefix: str):
    for s in reversed(report["snapshots"]):
        if s["label"].startswith(prefix):
            return s
    return None


direct_final = last_snap_prefix("direct_")
donate = snap_by("donate_open")
self_s = snap_by("self_open")
req_s = snap_by("request_open")

def req_field(snap, field):
    if not snap or not snap.get("request"):
        return None
    return snap["request"].get(field)

recording = {
    "direct_handoff": {
        "origin": req_field(direct_final, "origin"),
        "verification_contacted": req_field(direct_final, "verification_contacted"),
        "parties_sample": (direct_final or {}).get("parties") or [],
        "items_sample": (direct_final or {}).get("items") or [],
        "verification_path": "phone alone → verification_contacted=false; consent → contacted/outbox",
        "dira_floor_rule": "דירה N must not write floor",
        "outbox": "israel replies + optional tal verification",
    },
    "open_donation": {
        "origin": req_field(donate, "origin"),
        "parties_sample": (donate or {}).get("parties") or [],
        "items_sample": (donate or {}).get("items") or [],
        "photo_gate": True,
        "notes": "opening settlement/address/floor retained before photo",
    },
    "self_transfer": {
        "represents_both": req_field(self_s, "represents_both_parties"),
        "parties_sample": (self_s or {}).get("parties") or [],
        "notes": "donor floor≠receiver floor; same phone both roles",
    },
    "open_request": {
        "searches": (req_s or {}).get("searches") or [],
        "request": (req_s or {}).get("request"),
        "notes": "seeker should create search; must not open photo-gated donation",
    },
}
report["recording_review"] = recording

passed = sum(1 for c in report["checks"] if c["ok"])
failed = [c for c in report["checks"] if not c["ok"]]
report["summary"] = {"passed": passed, "failed": len(failed), "total": len(report["checks"]), "ok": len(failed) == 0}
report["failures"] = failed

out_path = f"/tmp/live-four-flows-report-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
json.dump(report, open(out_path, "w"), ensure_ascii=False, indent=2)
# also refresh the stable alias used by operators
json.dump(report, open("/tmp/live-four-flows-report.json", "w"), ensure_ascii=False, indent=2)
print("\nSUMMARY", json.dumps(report["summary"], ensure_ascii=False), flush=True)
for f in failed:
    print("FAIL", f["check"], f.get("detail"), flush=True)
print("WROTE", out_path, flush=True)
raise SystemExit(0 if report["summary"]["ok"] else 2)
