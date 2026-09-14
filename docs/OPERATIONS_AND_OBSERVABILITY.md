# תפעול ונראות

## מה קיים

- `trace_id` בהודעות, אירועים ו־outbox.
- `/health` לתהליך ו־`/ready` ל־runtime, DB, storage ו־worker heartbeat.
- admin metrics, רשימת failed jobs, outbox inspection ו־resolve ל־uncertain.
- reset/resume לשיחה ולפנייה, שינוי קיבולת ואישור same-day.
- מצב shadow/simulation/live והפרדת schema לסימולציה.
- התראת human עם מספר פנייה, מסלול, הודעה אחרונה וסיבה.
- מסך DB לחמש תצוגות וכפתור clear-all עם ביטוי אישור.

## פערים

1. Docker HEALTHCHECK משתמש ב־`/health`, ולכן container יכול להיראות בריא כאשר migrations/workers/storage אינם ready.
2. readiness אינו בודק WAHA או זמינות prompt/OpenAI.
3. אין `/metrics` בפורמט Prometheus, dashboards, SLO או alert rules.
4. אין receipt states delivered/read; “sent” אינו מספיק למדידת הצלחה.
5. alert מנהל נשלח באותו outbox; חסימה לאותו יעד עלולה להסתיר את התקלה.
6. `integration_outbox` נצרך על ידי dispatcher פנימי; adapter חיצוני אינו מופעל כברירת מחדל ולכן אירוע ללא adapter נכשל באופן durable.
7. אין תהליך גיבוי/שחזור מוכח למסד ול־media volume.
8. retention של תוכן לקוחות ומדיה אינו מוגדר.
9. admin DB מאפשר שינוי ישיר של status/outbox state, שעלול לעקוף invariants.
10. destructive clear-all מוגן בטוקן ובביטוי בלבד; אין audit actor חזק, second factor או export לפני מחיקה.

## מדדים נדרשים

| מדד | יעד ראשוני |
|---|---|
| webhook accepted -> processed p95 | פחות מ־5 שניות ללא AI, פחות מ־15 עם AI |
| pending inbox oldest age | alert מעל 2 דקות |
| pending outbox oldest age | alert מעל 2 דקות |
| uncertain/failed outbox | alert מיידי עם recipient+trace, ללא PII בתוויות |
| AI schema failure | פחות מ־1% בחלון 15 דקות |
| human escalation | מגמה וסיבה, לא יעד הצלחה אפס |
| duplicate webhook | נספר אך ללא אפקט עסקי כפול |
| verification queued/delivered/approved | funnel מלא |
| coordinated requests | מול capacity ולפי Tuesday run |
| media capture failure | לפי provider/mime/size, בלי URL רגיש |

## runbooks מינימליים

- הודעה נכנסה ואין תשובה: trace inbox -> job -> command_result -> outbox -> provider receipt.
- outbox uncertain: לבדוק אצל WAHA לפי idempotency/provider id לפני resolve.
- FIFO blocked: לזהות head, לא לדלג אוטומטית, לפתור או לבטל במפורש.
- AI unavailable: fallback בטוח, rate/circuit breaker והעברה לאדם אחרי סף.
- DB migration failed: stop rollout; checksum והחזרת image קודם.
- media missing: verify checksum/object/DB link; אין למחוק רשומה לפני export.

## אבטחה ופרטיות

HMAC, zod, canonical phones והגנות SSRF הם בסיס טוב. לפני live נדרשים rotation לסודות, admin token ארוך, rate limiting, least privilege DB, redaction ללוגים, retention policy, הצפנת backups וסקירת הרשאות API. טוקן קצר כגון `2101` אינו מתאים לפרודקשן.
