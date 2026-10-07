#!/usr/bin/env python3
"""Quick live baseline: second different-item donate behavior."""
from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ENV = {}
for line in open("/root/haim-bot.env"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    ENV[k] = v.strip().strip('"')

WAHA = "http://127.0.0.1:3001"
BOT = "http://127.0.0.1:3010"
API = ENV["WAHA_API_KEY"]
ADMIN = ENV["HAIM_ADMIN_TOKEN"]
LID = "229716460097752@lid"


def http(method, url, body=None, headers=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    hdrs = dict(headers or {})
    if data is not None:
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read()
            return r.status, json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw) if raw else raw
        except Exception:
            return e.code, raw


def admin_prep():
    for path, body in [
        ("/admin/requests/cancel-phone", {"phone": "584152101", "confirm": "בטל פניות"}),
        ("/admin/conversations/584152101/reset", None),
        ("/admin/database/clear-all", {"confirm": "מחק הכל"}),
    ]:
        code, b = http("POST", BOT + path, body, {"x-admin-token": ADMIN})
        print(path, code, b)


def send(t):
    before = time.time()
    code, b = http(
        "POST",
        f"{WAHA}/api/sendText",
        {"session": "default", "chatId": "972543414386@c.us", "text": t},
        {"X-Api-Key": API},
    )
    print("send", code, t)
    if code >= 300:
        print(b)
        raise SystemExit(1)
    q = urllib.parse.quote(LID, safe="@")
    for _ in range(45):
        code, msgs = http(
            "GET",
            f"{WAHA}/api/default/chats/{q}/messages?limit=25",
            headers={"X-Api-Key": API},
        )
        for m in sorted(msgs or [], key=lambda x: x.get("timestamp") or 0):
            if m.get("fromMe"):
                continue
            if float(m.get("timestamp") or 0) >= before - 2 and (m.get("body") or "").strip():
                print("bot:", (m.get("body") or "")[:300])
                return
        time.sleep(2)
    print("NO REPLY")


def db(sql):
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
            "-c",
            sql,
        ],
        text=True,
    )


admin_prep()
send("אני רוצה למסור מיטה")
print(db("SELECT number,status,origin FROM requests; SELECT r.number,i.kind FROM request_items i JOIN requests r ON r.id=i.request_id;"))
send("אני רוצה למסור ספה")
print(db("SELECT number,status,origin FROM requests ORDER BY number; SELECT r.number,i.kind,i.description FROM request_items i JOIN requests r ON r.id=i.request_id ORDER BY r.number;"))
