# Migration manifest

Read-only inventory taken 2026-10-05 from `hal-server-858371`. No server setting was changed. This file lists secret names only. It does not contain secret values.

Owner: Israel. Source of HAIM code: `C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION`, GitHub `zolo0548152101-afk/ZOLO`, branch `qa-build`. Local HEAD when inventoried: `b84ce5e`. The running HAIM image was built from `7335b3c`, the commit immediately before that docs commit.

## Do not move yet

No destination server, DNS owner, or cutover window has been chosen. Node-RED WhatsApp and Tadabase flows are working production paths and stay as they are until a separate cutover is approved. WAHA sessions stay on this server. Default for a future move is a new QR login, not a blind copy of `whatsapp_waha_sessions`.

## Services

| Service | Image | Replicas | Role |
| --- | --- | --- | --- |
| `whatsapp_haim-bot-core` | `haim-bot-core:clear-override-7335b3c` | 1/1 | HAIM API, workers, admin |
| `whatsapp_haim-db` | `postgres:17` | 1/1 | HAIM database `haim_yahad`, live schema `haim_core` |
| `whatsapp_waha` | `waha:mediafix-20260925` | 1/1 | WhatsApp gateway |
| `whatsapp_nodered` | `nodered/node-red:4.1.8-22` | 1/1 | Tadabase and Google Sheets WhatsApp flows |
| `easypanel` | `easypanel/easypanel:latest` | 1/1 | Control panel |
| `easypanel-traefik` | `traefik:3.6.7` | 1/1 | Proxy and TLS |
| `facebookintel_app` | `facebook-intel-native:v2-network-20260927-trigger-scopefix` | 1/1 | Facebook app |
| `facebookintel_worker` | same image as the app | 1/1 | Facebook worker |
| `facebookintel_db` | `postgres:17-alpine` | 1/1 | Facebook database |
| `facebookintel_chromium` | `jlesage/chromium:v26.08.3` | 1/1 | Browser |
| `facebookintel_cdp-proxy` | `nginx:1.27-alpine` | 1/1 | Browser proxy |

A one-off Postgres container `qa-haim-approval-verify-20260925t1420` is still running from 2026-09-25. It is not part of the live HAIM service.

## Volumes

| Volume | Keep |
| --- | --- |
| `whatsapp_haim-bot-core_haim-yahad-media` | HAIM media |
| `whatsapp_waha_sessions` | WAHA sessions. Sensitive. Do not put in Git. |
| `whatsapp_nodered_data` | Node-RED flows and encrypted credentials |
| `facebookintel_facebook_intel_pgdata` | Facebook database |
| `facebookintel_facebook_intel_worker_data` | Facebook worker data |
| `facebookintel_facebook_intel_chromium_config` | Browser config |
| `facebookintel_facebook_intel_chromium_session2` | Browser session |
| `facebookintel_facebook_intel_chromium_session3` | Browser session |
| `facebookintel_facebook_intel_chromium_session4` | Browser session |

`whatsapp_haim-db` did not appear as a named volume in `docker volume ls`. Its data mount must be identified and dumped before any move. One anonymous volume was present: `615e7e5638869dce34d636ddc0dd4eecd80e0ce6ba54a8e0d596ce777ee26528`.

## Networks

- `easypanel`
- `easypanel-whatsapp` — HAIM, WAHA, Node-RED, and HAIM Postgres
- `facebookintel_facebook_intel` — Facebook services, kept separate

## Public hosts

All of these answered through Traefik on 2026-10-05. They are EasyPanel hostnames, not a final custom domain.

- `https://whatsapp-haim-bot-core.cdpvmq.easypanel.host`
- `https://whatsapp-nodered.cdpvmq.easypanel.host`
- `https://whatsapp-waha.cdpvmq.easypanel.host`
- `https://facebook-intel-app.cdpvmq.easypanel.host`
- `https://cdpvmq.easypanel.host`

## Databases

| Database | Service | Backup |
| --- | --- | --- |
| `haim_yahad` / `haim_core` | `whatsapp_haim-db` | Consistent `pg_dump` before any restore test |
| Facebook Intel | `facebookintel_db` | Separate dump, only if that service moves |

Older QA dumps already on the server under `/var/backups/haim-qa/` stay there until a rollback window ends. They are not Git files.

## Secret names

Values stay on the server. They are not in Git and not in this file.

| Location | Names |
| --- | --- |
| HAIM | `DATABASE_URL`, `WAHA_API_KEY`, `WAHA_BASE_URL`, `WAHA_WEBHOOK_HMAC_KEY`, `OPENAI_API_KEY`, `HAIM_ADMIN_TOKEN`, `IVRIT_API_TOKEN`, `IVRIT_URL`, `IVRIT_TRANSCRIBE_URL`, `TADABASE_WEBHOOK_SECRET`, `TADABASE_DATE_WEBHOOK_SECRET`, `GOOGLE_SHEETS_WEBHOOK_SECRET`, `GOOGLE_SHEETS_BOT_SECRET` |
| Node-RED | `WAHA_API_KEY`, `WAHA_BASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`, `HAIM_ADMIN_TOKEN`, `IVRIT_API_TOKEN`, `IVRIT_TRANSCRIBE_URL`, `TADABASE_WEBHOOK_SECRET`, `TADABASE_DATE_WEBHOOK_SECRET`, `GOOGLE_SHEETS_WEBHOOK_SECRET`, `GOOGLE_SHEETS_BOT_SECRET` |
| WAHA | the Node-RED set, plus `WAHA_DASHBOARD_PASSWORD`, `WHATSAPP_HOOK_HMAC_KEY`, `WHATSAPP_HOOK_URL`, `WHATSAPP_SWAGGER_PASSWORD` |
| HAIM Postgres | `POSTGRES_PASSWORD` |
| Facebook app | `DATABASE_URL`, `ADMIN_PASSWORD`, `CHROMIUM_CDP_URL`, `CHROMIUM_PUBLIC_URL` |
| Facebook worker | `DATABASE_URL`, `CHROMIUM_CDP_URL` |
| Chromium | `VNC_PASSWORD`, `WEB_AUTHENTICATION_USERNAME`, `WEB_AUTHENTICATION_PASSWORD` |
| Facebook Postgres | `POSTGRES_PASSWORD` |

There is no separate Tadabase account API key on the server. Tadabase reaches Node-RED with the webhook secrets. Confirmed on 2026-10-05 without printing values: Node-RED and HAIM both reach WAHA, sessions `default`, `HAIM_YAHAD`, and `TAL_ZOLO` are `WORKING`, HAIM `/health` and `/ready` return 200 in `live` / `haim_core`, and the HAIM database accepts connections.

## Dependencies

```text
Tadabase / Google Sheets
  -> Node-RED webhook
  -> WAHA sendText
  -> WhatsApp

WhatsApp
  -> WAHA webhook
  -> HAIM inbox
  -> Postgres haim_core + media volume
  -> WAHA send
```

Node-RED and HAIM both send through the same WAHA service. Moving one without the other changes live WhatsApp behavior.

## Backup path

1. `pg_dump` of `haim_yahad`, then a restore test on a non-public database.
2. Archive `whatsapp_haim-bot-core_haim-yahad-media` with file name, size, and SHA-256.
3. Encrypted copy of `whatsapp_nodered_data`. Do not commit it.
4. Leave `whatsapp_waha_sessions` in an encrypted backup only. Plan a new QR login for a new server.
5. Facebook dumps and browser volumes only if Facebook is included.

## Rollback

Until a new server is accepted, this server remains the live one. Rollback of a future cutover is: point DNS and webhooks back here, do not restore a second dump over new messages, and do not delete Node-RED, WAHA sessions, or HAIM data. The current HAIM image to keep available is `haim-bot-core:clear-override-7335b3c`.

## Still needed before any move

1. Destination server, region, and who administers it.
2. Whether Facebook moves with HAIM. Node-RED moves only with an explicit cutover that preserves the Tadabase flows.
3. Domain and DNS access.
4. New QR login for WAHA, unless a session copy is explicitly approved.
5. A tested restore of the HAIM database and media, including the still-unlisted Postgres data mount.
