# מפת המערכת החדשה

## ארכיטקטורה בפועל

המערכת היא שירות Node.js 24 / TypeScript / Fastify עם PostgreSQL 17 ו־pg-boss. היא מפרידה בין domain, application, infrastructure, HTTP ו־migrations. מקור הראיות הוא הקוד ב־`src`, שבעת קובצי migration והבדיקות במאגר ב־commit `0f59e10`.

```text
WAHA webhook
  -> אימות HMAC וסינון payload
  -> messages (inbox עמיד + unique external id)
  -> pg-boss ingest/capture/conversation
  -> identity + conversation FIFO
  -> context מהמסד
  -> rulePlan + OpenAI managed prompt
  -> commands עם הרשאות domain
  -> transaction: request/events/outbox
  -> pg-boss send FIFO לפי מספר טלפון
  -> WAHA
```

## רכיבים ותחומי אחריות

| רכיב | אחריות | גבול חשוב |
|---|---|---|
| `src/http.ts` | webhook, admin, simulation, readiness | מכיל גם UI ופעולות DB ישירות ולכן עמוס |
| `application/runtime.ts` | workers, recovery, heartbeat, jobs תפעוליים | בודק ספירת migrations מינימלית 5 אף שקיימות 7 |
| `application/engine.ts` | תזמור הודעה, AI, commands, notices, outbox | מבצע קריאות AI לניסוח מתוך transaction |
| `application/rule-planner.ts` | זיהוי דטרמיניסטי של מסירה/פרטים/אימות | regex מוגבל ועלול לפרש כתובת כשם |
| `application/commands.ts` | כתיבות עסקיות והרשאות actor | תרגום פעולות AI אינו מכסה את כל החוזה |
| `domain/policies.ts` | שאלות הבאות, readiness, אזור/פריט/זמן | `photoGate` קיים אך אינו מקור יחיד לכל המסלולים |
| `infrastructure/store.ts` | persistence, locks, outbox, matching, capacity | מודל יחסי חזק; location עדיין מבודד מה־Request |
| `infrastructure/ai.ts` | Responses API, prompt ID+version, schema | אפשר להוכיח בניית בקשה, לא הצלחה מרוחקת בביקורת offline |
| `infrastructure/waha.ts` | שליחה, ambiguity policy, media | timeout/5xx מסומן uncertain כדי למנוע כפילות |

## מודל נתונים

המערכת החדשה מפרידה contacts, identities, conversations, requests, parties, items, media, request_media, request_locations, searches, matches, transport_runs, messages, command_results, request_events, outbox ו־integration_outbox. קיימים constraints, foreign keys, מספר פנייה רציף, optimistic versioning ו־locks לקיבולת.

זהו שיפור מהותי לעומת שורת Google Sheets, אך קיימים פערי שימוש:

- `request_locations` נטען ל־Request ומופיע בדוח סטטוס כקישור מפה מורשה לפי תפקיד; בדיקת WAHA חיה עדיין נדרשת.
- admin DB מציג רק חמש תצוגות ומאפשר עריכה של חלק קטן מהשדות.
- `integrations` ו־`integration_outbox` כוללים dispatcher idempotent; adapter חיצוני עדיין אינו מופעל כברירת מחדל.
- boolean יחיד `verification_contacted` מייצג יותר מדי מצבים שונים.

## התנהגות שיחה ו־AI

- טקסט עובר תחילה תכנון דטרמיניסטי ובכל זאת מתבצעת קריאת managed prompt. אם יש כלל דטרמיניסטי, הפקודות שלו גוברות.
- metadata שומר prompt ID, version ותשובת ניסוח.
- תשובה דטרמיניסטית מסומנת `action_source=deterministic_flow` ומוגנת מהחלפת הטקסט ב־managed reply. לכן הפרומפט נקרא אך אינו מנסח בפועל חלק גדול מהשיחות.
- notices לצד השני עוברים דרך `phraseNotice` אחרי commit, עם `format_state=pending` שמונע שליחה לפני ניסוח או fallback.
- batch של text/contact/location/image נשמר תחת `conversation_turns` עם quiet window ו־generation supersession; stress מול ספק חי עדיין דורש בדיקה.

## מצבי הפעלה

- `shadow`: כל המסלול העסקי מופעל אך outbox אינו נשלח לספק.
- `simulation`: schema/Runtime נפרד, API לניסוי.
- `live`: שליחה אמיתית, עם inbound `bot_access` ו־outbound `LIVE_ALLOWLIST` נפרדים.

ההפרדה טובה לבטיחות, אך שני מנגנוני הרשאה נפרדים עלולים ליצור ציפייה שגויה: מספר מורשה להיכנס אינו בהכרח מורשה לקבל הודעה יוצאת.

## תפעול

קיימים `/health`, `/ready`, heartbeat, admin metrics, failed jobs, resolve ל־outbox uncertain, reset/resume, קיבולת, תיאום ידני וניקוי נתוני בדיקות. קיימים delivery receipts ו־dispatcher לאינטגרציות, אך בדיקת readiness אמיתית ל־WAHA/OpenAI, metrics סטנדרטיים וגיבוי/שחזור חי עדיין דורשים שער תפעולי. Docker בודק `/health` בלבד.
