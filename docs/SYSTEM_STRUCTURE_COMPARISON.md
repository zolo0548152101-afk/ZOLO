# השוואת מבנה המערכות

## מסקנה

המערכת החדשה בנויה טוב משמעותית מבחינת גבולות קוד, עסקאות ועמידות. המערכת הישנה עשירה יותר בחלק מכללי השיחה והשטח. המעבר הנכון הוא **controlled refactor**: לשמור את ליבת הנתונים וה־outbox החדשה, ולהשלים אליה יכולות legacy באופן מדורג ומוכח. Big-bang rewrite או חזרה ל־Node-RED אינם מומלצים.

| היבט | מערכת ישנה | מערכת חדשה | פסק דין |
|---|---|---|---|
| orchestration | flow גרפי גדול וריבוי function nodes | Engine ו־commands טיפוסיים | `DIFFERENT_BUT_BETTER` |
| מקור אמת | Google Sheet שטוח | PostgreSQL יחסי | `DIFFERENT_BUT_BETTER` |
| מצב שיחה | flow-memory + sheet | conversations/messages עמידים | `DIFFERENT_BUT_BETTER` |
| batching | כל modality, generation token | 900ms לטקסט בלבד | `PARTIAL` |
| כללי עסק | Prompt + שתי שכבות JS | policies + commands + planner | `DIFFERENT_BUT_BETTER`, אך לא שלם |
| ניסוח | prompt מנוהל ואז post-processing | prompt + תשובות מוגנות/קוד | `DIFFERENT_AND_PROBLEMATIC` |
| side effects | שליחה ישירה ללא durable outbox | outbox אטומי ו־pg-boss | `DIFFERENT_BUT_BETTER` |
| התאוששות | retries נקודתיים | recovery ל־conversation/outbox | `PARTIAL`; הודעות ללא contact עלולות להיתקע |
| admin | Node-RED/dashboard + Sheet | Fastify admin מובנה | `PARTIAL` |
| אינטגרציות | Apps Script/Sheets בפועל | טבלאות placeholder בלבד | `ARCHITECTURAL_GAP` |
| media | `/data` ושדות Sheet | storage checksum + FK | `DIFFERENT_BUT_BETTER`, חסר retrieval UX מלא |
| location | רשימה רשמית + Waze | טבלת נקודות נפרדת | `DIFFERENT_AND_PROBLEMATIC` |

## מבנה בעלות מומלץ

- PostgreSQL הוא מקור האמת היחיד למצב עסקי.
- domain services הם מקור האמת היחיד לחוקי כשירות, הרשאה ומעבר מצב.
- AI מציע כוונה/פרטים ומנסח לפי facts מאושרים; הוא אינו מחליט ששליחה הצליחה.
- outbox הוא המקור היחיד ל־side effects.
- prompt ו־domain policy מקבלים גרסה ונבדקים כצמד release אחד.
- admin משתמש ב־application services, לא ב־SQL updates גנריים לשדות עסקיים.

## מוקדי צימוד שצריך לפרק

1. `engine.ts` משלב orchestration, admin command, media, location, AI formatting, transaction ותיאום.
2. readiness מפוזר בין `nextQuestion`, `readyToCoordinate`, command handlers ו־Engine.
3. verification נדחס ל־boolean במקום state machine.
4. prompt contract כולל actions שאין להן translator מלא.
5. location persistence אינו מחובר ל־status, matching או admin.

