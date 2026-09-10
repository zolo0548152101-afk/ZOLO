# הארכיטקטורה שנבחרה

התקנת היסודות המומלצת: **Modular Monolith עם pg-boss ו־OpenAI Agents SDK**, על PostgreSQL 17 ו־Node.js 24. מתחילים ב־replica אחד וב־shadow. תהליך אחד יכול להפעיל HTTP ו־workers; בעתיד אפשר להפריד את ההפעלה שלהם בלי להזיז את חוקי העסק.

אין ארכיטקטורה שמבטיחה אפס שינויים לאורך שנים. היעד כאן הוא לרכז שינויים בגבולות adapters, migrations וגרסאות כללים, ולשמור על מודל עסקי יציב.

## חלוקת אחריות

| שכבה | קבצים | אחריות |
|---|---|---|
| Domain | src/domain | סוגי פניות, פקודות, כללים, בחירת שאלות וניסוח תשובות |
| Application | commands, engine, runtime | הרשאה, רצף פעולה, transactions, הפעלת workers |
| Persistence | store, db | שאילתות פרמטריות, נעילות, migrations ואינדקסים |
| Adapters | ai, waha, media, webhook, queue | ספק AI, ערוץ, קבצים ותשתית תור |
| HTTP | http, server | validation, authentication, health, simulate/admin |

ה־domain אינו מכיר SDK של תורים, SQL או WAHA. שכבת האפליקציה משתמשת כרגע ב־Store קונקרטי; לא הוספנו container של dependency injection או repository לכל טבלה. החלפת queue עוברת דרך Queue; מעבר לאחסון אחר דרך MediaStorage; Planner ו־Channel ניתנים להחלפה. integration-port ו־integration_outbox הם גבול הרחבה בלבד: אין כרגע dispatcher ל־CRM/Sheets.

## זרימה ועמידות

1. Webhook מאומת ב־HMAC על bytes המקוריים ונבדקים session וסוג האירוע.
2. ב־transaction קצר נשמרת הודעה ייחודית ונוצרות עבודות ingest/capture. HTTP 202 רק לאחר COMMIT. בכשל DB אין acknowledgment מצליח.
3. ingest מסדר כניסה לפי seq ומאחד @lid ומספר טלפון לזהות canonical. קבוצות/status/newsletters ו־fromMe לא נכנסים לעיבוד עסקי.
4. capture מוריד מדיה בתור נפרד מיד כש־worker זמין; תור השיחה ממתין למדיה. אין הבטחה להתגבר על URL שפג בזמן השבתת השרת.
5. תור conversation בעל key של איש הקשר מסדר הודעות. נבדקת גם ההודעה הקודמת שטרם הושלמה ב־DB.
6. AI רואה snapshot מורשה והיסטוריה מוגבלת; מציע תוכנית באמצעות tool. התוכנית נשמרת לפני ביצוע עסקי.
7. transaction נועל שיחה/הודעה ופניות רלוונטיות, בודק versions והרשאות, מחיל פקודות ושומר audit, result, outbox ועבודות שליחה יחד.
8. שליחת WhatsApp מתבצעת רק מה־outbox. הרשומה שומרת את mode המקורי: הודעת shadow לעולם לא הופכת להודעת live בעקבות שינוי ENV.

לא מחזיקים נעילת DB במהלך OpenAI, IVRIT או HTTP חיצוני. מידע השתנה בזמן AI? התוכנית הישנה נפסלת ונבנית מחדש במקום לדרוס שינוי של צד אחר.

## תורים, סדר וכשל

pg-boss מנהל leasing, heartbeat, retries ותחזוקה. key_strict_fifo משמש ל־ingest/conversation/send. capture ו־ops הם standard. לכל איש קשר ניתן לעבד זרימה נפרדת; שליחה מסודרת לפי יעד. מספרי seq קובעים סדר קבלה בשרת, ולא משחזרים סדר מקור אם WAHA מסר הודעות באיחור או בסדר שונה.

הגדרות: expiration של 180 שניות, heartbeat של 30 שניות, polling של 0.5 שנייה, עד 5 retries עם backoff מבוקר. אלו הגדרות ולא מדידת latency או התחייבות לזמן התאוששות. AI נכשל פעמיים ברצף? האירוע מסתיים בהסלמה עמידה לאדם.

עבודה שנכשלה סופית חוסמת את אותו key. זה מונע עקיפה של הודעה קודמת, אך דורש טיפול דרך admin API והתראה. אין לדלג על עבודה חסומה באמצעות שינוי SQL ידני.

שליחה חיצונית היא גבול שאין בו transaction משותף עם DB. timeout, 5xx או crash אחרי sending יוצרים מצב uncertain. אין retry אוטומטי או fallback שעלולים לשלוח כפול. fallback ל־@c.us מותר רק בתשובת ספק ברורה על chat לא תקין. אדמין בודק ב־WAHA ואז מאשר sent, מבטל או מבצע redrive מפורש לאחר סיום העבודה המקורית. אין הבטחת exactly-once ל־WhatsApp.

## AI

ה־Agents SDK מנהל tool loop, Responses integration ו־timeouts. לא נבנה loop ביתי נוסף. יש שני כלים בלבד: get_context לקריאה ו־submit_plan להצעת פקודות. stop-at-tool חוסך יצירת תשובה נוספת. Zod strict מונע שדות לא מוכרים, והקוד בודק זהות, מצב פנייה, evidence ואישורים. evidence תורם לעיגון; הוא אינו הוכחה שהמודל פירש משפט נכון, ולכן נדרשות evals בעברית.

לא מועברות תמונות ל־AI. מידע לקוח, transcription ושמות הם נתונים בלתי מהימנים לצורך הוראות. פלט לקוח נבנה מתבניות עסקיות. סטטוס וברכות פשוטות עוקפים AI. status אינו יוצר או משנה פנייה.

ברירת המודל: gpt-5.6-luna, effort low. אין fallback אוטומטי למודל יקר. תחילה מודדים הצלחת תרחישים, latency ועלות. OPENAI_TRACING כבוי; trace מקומי נשאר. היסטוריה אחרונה נשמרת ב־PostgreSQL, ולא ב־session בזיכרון. פרומפט סטטי מאפשר reuse של prefix; cache hit ו־breakpoints עדיין לא נבדקו מול API אמיתי.

## DB

UUID מזהה פנימי, number מזהה אנושי. טבלת counter נעולה יוצרת מספר רציף בתוך schema ב־COMMIT; אין שימוש ב־MAX+1. rollback אינו צורך מספר. מספרי shadow/simulation/live נפרדים; אין להעתיק counter ביניהם ללא תכנון יבוא.

- contacts: אדם ומספר canonical; contact_identities: זהויות ערוץ/LID.
- conversations: בחירת פנייה ומצב bot/human. אין הנחה של פנייה פעילה אחת לאדם.
- requests: מצב, version, origin, transport date והגנה על תיאום.
- request_parties: donor/receiver לכל פנייה; אותו contact יכול למלא כל אחד מהתפקידים בפניות שונות, וגם את שניהם באותה פנייה.
- שמות, כתובות ואישורים הם snapshot של צד בפנייה, ולא כתובת גלובלית משתנה של contact. approved_by חייב להיות אותו contact.
- request_items: פריטים, quantity ועובדות שנמסרו. trigger דחוי נועל parent ובודק סך עד 2. שולחן+כיסאות יחידה אחת.
- media ו־request_media: תוכן מזוהה checksum, קישור להודעה ולפנייה. אותו תוכן יכול להיות קשור לכמה הודעות בלי שגיאת uniqueness.
- searches/matches: חיפוש לפי סוג פריט ומצב הצגת תמונה/עניין. claim של מקבל תחת נעילת פנייה.
- messages/command_results/request_events: dedupe, מצב עיבוד, תוכנית, result ו־audit.
- outbox: שליחה ייחודית, mode קבוע, provider id ותוצאה לא ודאית.
- transport_runs: שלישי בלבד; נעילת שורת run לפני בדיקת capacity. כרגע capacity נמדד בפניות, לא במשקל/נפח.
- service_locations: allowed/outside/review ו־aliases. הרשימה הראשונית חלקית וחייבת אישור לפני live.
- app_settings/integrations/integration_outbox: הגדרות וגבול הרחבה.

יש FK, unique constraints, check constraints, אינדקסי FK ואינדקסים להודעות/פניות/שליחות ממתינות. גרסת פנייה ונעילות מונעות lost updates. Audit אינו WORM ואינו חסין לשינוי מצד בעל הרשאות DB. ביטול וסגירה שומרים היסטוריה; אין API מחיקה שרירותי.

אין כרגע יבוא מ־Sheets/V3. פניות legacy נשארות במערכת הישנה עד לתכנון migration עסקי נפרד.

## מדיה, תצפית והתרחבות

נבחר persistent volume מקומי: פחות שירותים ועלות תפעול נמוכה, עם fsync, rename אטומי ו־checksum. נתיבי הקבצים נוצרים פנימית; אין שימוש בשם קובץ לקוח. הורדה מוגבלת ב־גודל/זמן/MIME, ללא redirects, ועם allowlist של origins; מפתח WAHA נשלח רק ל־origin שלו. ה־volume דורש גיבוי נפרד מה־DB.

replica אחד באותו host הוא מודל ההתקנה הראשון. PostgreSQL ו־pg-boss תומכים בהרחבת workers, אבל לפני כמה hosts נדרש S3-compatible/shared storage ובדיקת עומס. MinIO על אותו שרת מוסיף שירות ואינו נותן כשלעצמו שרידות מחוץ לשרת. אין צורך בו כעת.

לוגי JSON עם trace_id ו־stage; אין הדפסת גופי הודעות או מפתחות. ה־DB/admin API מכילים מידע לקוחות ולכן admin token, TLS והרשאות רשת נדרשים. metrics כוללים גיל inbox, outbox uncertain, key חסום ו־AI p95. כרגע אין Grafana, התראה חיצונית בלתי תלויה ב־WAHA, ניהול retention מלא או rate limiter אפליקטיבי; אלו משימות המשך ממוקדות.
