# בדיקה ארכיטקטונית מסכמת — חיים יחד V5

תאריך המחקר: 10 בספטמבר 2026. ההכרעה מתייחסת לבוט קהילתי קטן, שרת EasyPanel קיים, PostgreSQL 17 פעיל ו־WAHA קיים. אין נתוני עומס ייצור חדשים או מדידות latency מהשרת שלך. הטענות על יכולות מוצרים מבוססות על מקורות ראשוניים המקושרים כאן; ההמלצה והערכת התאמה הן שיקול הנדסי לפרויקט הזה.

## ההחלטה

**זה ה־stack שאני ממליץ להתקין כיסודות ב־shadow: Node.js 24, TypeScript strict, Fastify 5, Zod 4, PostgreSQL 17, pg-boss, OpenAI Agents SDK עם Responses API, ומדיה על persistent volume מקומי.**

לא מוסיפים כרגע Redis, Temporal, LangGraph, MinIO, מערכת event bus נפרדת או platform לבניית בוטים. PostgreSQL נשאר מקור האמת. Node-RED נשאר פעיל עד לסיום אימות וניתוק מבוקר בעתיד. המסקנה תומכת בכיוון ה־Modular Monolith הקודם, אבל מחליפה את תשתית ה־jobs הביתית ואינה מאשרת את V3 כפי שהוא.

נבדקו במלואם שני מסמכי V4 שהועלו, חבילת V3 FOUNDATION ו־flow של Node-RED. קובץ קוד ZIP של V4 לא היה בין הקבצים הזמינים, ולכן אין כאן טענה שהקוד של V4 נבדק. ה־flow מכיל 205 nodes, 132 Function nodes וכ־12,075 שורות JavaScript.

## ממצאים מהקיים

ב־V3 נמצא דפוס מסוכן: הודעה נרשמה ככפילות לפני שהעיבוד העסקי הושלם; אחרי כשל retry עלול לדלג על עבודה שלא בוצעה. תור ה־SKIP LOCKED לא סיפק מסלול reclaim מלא לעבודה שנשארה processing אחרי crash. חסרו outbox עמיד, הורדת מדיה שלמה, הקשחת webhook והרשאות מספקת ותיאום קיבולת אטומי. בדיקות V3 היו מצומצמות ולא אימתו מסלול כשל מקצה לקצה.

ב־flow הישן acknowledgment מוקדם, dedupe/batching בזיכרון וריבוי מסלולי Sheets יצרו חלונות אובדן וחוסר ודאות. נשמרו ממנו חוקי העסק, דפוס קישור הצדדים, IVRIT, נרמול LID והצורך להוריד מדיה מיד. לא הועתקו 12 אלף שורות לתוך שירות חדש.

נמצאה גם כתובת מנהל legacy שונה; ב־V5 גוברת ההנחיה העדכנית: canonical 584152101. כל פרטי הלקוחות מה־flow נשארו מחוץ לחבילה.

## השוואת תורים ותזמור

| אפשרות | אמינות, retries, ordering ו־crash | תפעול, גדילה ותלות | מסקנה אצלנו |
|---|---|---|---|
| תור Postgres ביתי | SKIP LOCKED פותר תחרות על claim, אך אינו פותר לבדו leases, reclaim, backoff, כשל סופי או סדר שיחה | מעט קוד התחלתי; אחריות תחזוקה ומבחני כשל גדלה לאורך שנים | לא ממשיכים לבנות מנוע תור |
| **pg-boss** | עסקאות Postgres; heartbeat, retry ותחזוקה; key_strict_fifo חוסם יורשים לפי key גם בכשל | אותו DB, Node/Docker, workers נוספים בלי Redis; API של הספרייה מאחורי wrapper | **נבחר** |
| Graphile Worker | מערכת Postgres ותיקה; queueName מספק serialization; ב־OSS התאוששות hard-crash יכולה להמתין כ־4 שעות ותחזוקה, בניגוד ל־Pro recovery | פשוט להוסיף לשרת; יתרון SQL-first; Pro הוא שיקול עלות לצורך התאוששות מהירה | מועמד טוב, פחות מתאים לדרישת recovery כאן |
| BullMQ + Redis | retries/locks/stalled recovery; FIFO של התחלה אינו מבטיח סדר סיום עם concurrency | בשלות גבוהה; Redis דורש persistence/גיבוי/ניטור, ו־DB outbox עדיין נדרש | לשקול רק אם עומס או צורך Redis ממשי מצדיקים |
| Temporal | durable workflow replay ו־activity retry; פעולות חיצוניות עדיין חייבות idempotency | מתאים לתהליכים ארוכים וריבוי שירותים, אך דורש תפעול ופיתוח ייעודיים או Cloud | תוספת מורכבות גדולה לבוט הזה |
| Trigger.dev | runs, retries, observability ו־durability; self-host אינו זהה לכל יכולות cloud | webapp/runners וסביבת הפעלה נוספת; self-host כולל PG/Redis ורכיבים נלווים בהתאם לתצורה | לא נחוץ למסלול הודעה קצר |
| Inngest | durable functions/steps ואירועים, retries ותצפית | self-host יכול להיות binary יחיד; production ו־Redis תלויים בתצורה, לצד אפשרות managed | לא לפסול כמפלצת, אך עדיין מנוע נוסף בלי צורך מספיק |
| Hatchet | orchestration, queues ו־workers עם durable PostgreSQL | self-host אפשרי; RabbitMQ אינו חובה בכל תצורה עדכנית | אפשרות עתידית לתזמור רחב, לא נדרשת כעת |

מקורות: [pg-boss repository](https://github.com/timgit/pg-boss), [queue policies](https://pgboss.io/api/queues), [workers](https://pgboss.io/api/workers), [jobs/transaction adapter](https://pgboss.io/api/jobs), [Graphile error handling](https://worker.graphile.org/docs/error-handling), [Graphile Pro recovery](https://worker.graphile.org/docs/pro/recovery), [Graphile job keys](https://worker.graphile.org/docs/job-key), [BullMQ FIFO](https://docs.bullmq.io/guide/jobs/fifo), [Temporal self-host](https://docs.temporal.io/self-hosted-guide), [Trigger self-host](https://trigger.dev/docs/self-hosting/overview), [Inngest self-host](https://www.inngest.com/docs/self-hosting), [Hatchet self-host](https://docs.hatchet.run/self-hosting).

### למה pg-boss ולא 300 שורות משלנו

היתרון הוא העברת האחריות על leasing, retries ותחזוקת התור לספרייה מתוחזקת, תוך יכולת לשמור שינוי עסקי ו־job באותה עסקת PostgreSQL באמצעות db.executeSql. זה חוסך מערכת נפרדת וחלון בין COMMIT עסקי לבין enqueue.

key_strict_fifo בגרסה הנעולה אינו קיצור דרך שמחליף מודל שיחה. עבודות עם startAfter/dependencies עשויות לשנות את קבוצת העבודות הזכאיות, ולכן כאן משתמשים ב־key יציב, עדיפות אחידה, enqueue מיידי ובדיקת seq נוספת. עבודה שנכשלה סופית חוסמת אותו key עד טיפול. זה trade-off מפורש: שומרים על סדר במחיר צורך בהתראה וטיפול בכשל.

הבחירה בגרסה נעולה אינה הוכחה שה־policy עבר אצלנו שנים בייצור. נדרשים מבחני native PostgreSQL, crash ו־upgrade לפני live. בדיקות WASM עוברות אך לא מחליפות אותם.

Latency: notification מצמצם המתנה לעבודה חדשה; polling משמש fallback ולמצבים שלא מפיקים notification. אין כאן benchmark המוכיח ש־pg-boss מהיר מ־Redis. בעומס שלנו latency של מודל/רשת צפוי להיות גורם מרכזי — זו השערה שצריך למדוד.

עלות: self-host pg-boss אינו דורש שירות מנוהל או Redis בתשלום; עלות CPU, אחסון וגיבוי בשרת הקיים אינה אפס. אין טבלת מחירים של שירותי cloud כי לא נבחר להשתמש בהם.

## מנוע השיחה וה־Agent

| אפשרות | מה מקבלים | ההתאמה לחיים יחד |
|---|---|---|
| Responses ישירות + loop משלנו | שליטה מלאה, מעט dependencies | מחייב לתחזק parsing, tool loop, מגבלת turns, tracing ו־timeouts |
| **OpenAI Agents SDK** | חיבור Responses, כלים, loop, tracing, הגבלות ריצה | **נבחר** כ־Planner adapter קטן; DB ומדיניות עסקית נשארים שלנו |
| LangGraph / LangChain JS | graph state, checkpoint, interrupt/resume וזרימות agents מורכבות | תשתית מועילה כאשר צריך graph עמיד אמיתי; כרגע עוד ייצוג מצב לצד requests/jobs |
| Mastra | agents, workflows, snapshots ו־suspend/resume | רחב יותר מהצורך; לא מוסיפים platform עבור שני tools |
| Vercel AI SDK | כלים, providers וזרימות שיחה/streaming | מתאים לממשקי AI ומגוון ספקים; יתרונות ה־UI אינם מרכזיים ב־WAHA |
| Botpress | פלטפורמה לבניית שיחה ואינטגרציות | גרסאות self-host v12 sunset; הכיוון הנוכחי אינו בסיס self-host חדש לפרויקט הזה |

מקורות: [OpenAI Agents](https://developers.openai.com/api/docs/guides/agents), [Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents), [Function calling](https://developers.openai.com/api/docs/guides/function-calling), [SDK TypeScript](https://openai.github.io/openai-agents-js/), [LangGraph JS](https://docs.langchain.com/oss/javascript/langgraph/overview), [Mastra workflows](https://mastra.ai/docs/workflows/overview), [Vercel Agents](https://ai-sdk.dev/docs/agents/overview), [Botpress v12 lifecycle](https://botpress.com/docs/studio/guides/advanced/v12/).

ה־SDK אינו durable job engine, ו־session שלו אינו מקור אמת עסקי. אצלנו PostgreSQL מחזיק inbox, מצב שיחה, snapshot versions, plan ותוצאות. pg-boss מפעיל את הריצה. SDK מציע פקודות בלבד. לכן לא מוסיפים שני מנועי תזמור שחופפים באחריות.

Structured outputs: תוכנית strict עם פקודות מוגדרות; אין endpoint כללי update(field,value). State management: נתונים יחסיים ושיחה עם selected_request_id; כמה פניות פעילות נתמכות. Context: snapshot מורשה והיסטוריה אחרונה; הגבלת תקציב context לפי מספר פניות היא משימת המשך. Tracing: local trace_id תמיד, tracing לספק opt-in ללא sensitive data. Evals: goldens דטרמיניסטיים ועוד כלי opt-in לארבע בדיקות מודל בתשלום. Human escalation היא מצב עמיד בקוד, לא רק ניסוח בפרומפט.

Fallback: שגיאת מודל לאחר retry מבוקר עוברת לאדם. אין החלפה אוטומטית למודל אחר שעלולה לשנות עלות והתנהגות בלי eval. Deadlines מוגדרים גם ל־OpenAI, גם ל־WAHA, גם ל־media/IVRIT.

### מודל ו־prompt caching

ברירת המחדל נשארת **gpt-5.6-luna / low**, כי זו נקודת פתיחה חסכונית למשימות חילוץ קצרות. זו אינה טענה שניצח benchmark עברית שלנו: לא בוצעו קריאות מודל אמיתיות בסביבה הזאת. ברכות פשוטות וסטטוס עוקפים את המודל. לפני הרחבה משווים low מול none לפי הצלחת תרחישים, לא לפי תחושה.

דף המודל שנבדק מציג תמיכה ב־effort low. מודל הוא ENV וניתן להחליפו אחרי eval, בלי schema migration. מחירי API משתנים ולכן יש לבדוק בדף הרשמי בעת הפעלת המפתח.

Prompt caching תלוי prefix תואם, גודל מינימלי והתנהגות cache של משפחת המודל. פרומפט סטטי הוא תנאי מועיל, אך אינו הוכחה ל־cache hit. V5 רושם usage; לא הוטמעו עדיין cache breakpoints מפורשים או benchmark caching. אין להבטיח הנחת cache בחישוב העלות הראשוני.

מקורות: [דף המודל](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [מודלים](https://developers.openai.com/api/docs/models), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## פרויקטים קיימים שנבדקו

- [BuilderBot](https://github.com/codigoencasa/builderbot): בסיס TypeScript עם providers ו־flows. שימושי ללימוד גבולות ערוץ ושיחה; אינו מחליף את מודל הפנייה מרובת הצדדים והעסקאות שלנו.
- [builderbot-openai-assistants](https://github.com/leifermendez/builderbot-openai-assistants): דוגמת חיבור, אך מבוססת API/מסלול ישן ביחס ל־Responses שנבחר.
- [whatsapp-ai-bot](https://github.com/huseynovvusal/whatsapp-ai-bot): דוגמת Baileys ו־AI; אין הצדקה להחליף WAHA קיים כדי לקבל חיבור מודל בסיסי.
- [whatsapp-ai-agent](https://github.com/shahbaz-dev1/whatsapp-ai-agent): דוגמת bot ישנה, לא הוכחה ל־production handling של multi-party, outbox ו־crash.
- [WAHA JavaScript integration](https://waha.devlike.pro/docs/integrations/javascript/): reference מתאים למבנה webhook, אבל דוגמת echo אינה מערכת עסקית עמידה.
- [n8n queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/): Redis, workers וניהול binary data דורשים תכנון; לא מחזירים את המנוע העסקי לגרף ויזואלי גדול.
- [Medusa event modules](https://docs.medusajs.com/resources/infrastructure-modules/event): pattern של event boundary שימושי; אין צורך להכניס framework מסחר כדי ליישם אותו.

לא נמצא בבדיקה בסיס שמחבר את כל חוקי חיים יחד באופן שנכון לקחת ולהתקין ללא התאמה. אין זו טענה שאין בעולם פרויקט מתאים; זו תוצאת החיפוש והבדיקה של המועמדים שנבדקו.

## דפוסים שאומצו וקוד שנכתב

| נושא | מקור תשתית מוכחת | מה נשאר שלנו |
|---|---|---|
| HTTP, validation | Fastify, Zod | routes והרשאות |
| Durable queue | pg-boss | queue adapter, key strategy וניטור business mailbox |
| AI tool execution | OpenAI Agents SDK | prompt, schemas, authorization ויישום פקודות |
| DB upgrades | node-pg-migrate | SQL, constraints, checksum gate |
| Atomic effects | PostgreSQL transactions + outbox pattern | messages, command_results, outbox dedupe keys |
| Channel/media | WAHA contract, Node APIs | safe adapter, LID, storage port, אי־ודאות שליחה |
| Domain | דרישות המשתמש וה־flow הקיים | donor/receiver, matching, photo first, capacity, status |

לא הועתקו קטעי קוד מפרויקטי chatbot חיצוניים. הספריות משולבות כחבילות עם lockfile; הרישיונות המצורפים מתייחסים אליהן. תבניות ארכיטקטוניות יושמו מחדש בהתאם למערכת.

## DB, concurrency ואינטגרציות

הישויות המוצעות היו בסיס נכון; נדרשו גם identities, searches/matches, command_results, outbox וקישורי request_media. Role הוא תכונה של קשר אדם־פנייה, לא של האדם. פרטי איסוף/יעד נשמרים בפנייה כדי ששינוי כתובת של אדם בעתיד לא ישנה היסטוריה.

PostgreSQL sequences יכולים להכיל פערים; לכן מספר הפנייה האנושי משתמש ב־counter transactional, בהתחשב בקצב הקטן. seq של הודעות אינו חייב להיות gapless. constraints לא יכולים לבדוק סכום שורות באמצעות CHECK רגיל; הקוד מוסיף trigger ונעילת parent. קיבולת דורשת נעילת transport_run לפני count/reserve, ולא count ואז update ללא lock.

מקורות: [Sequence semantics](https://www.postgresql.org/docs/17/functions-sequence.html), [Constraints](https://www.postgresql.org/docs/17/ddl-constraints.html), [Locking](https://www.postgresql.org/docs/17/explicit-locking.html), [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html).

אינטגרציה עתידית תקבל אירוע versioned עם event_id/idempotency_key דרך adapter. אין להוסיף כתיבת Sheets בתוך transaction עסקי. V5 מספק port וטבלה בלבד; dispatcher, mapping, conflict policy ו־replay ייכתבו כשיש יעד אמיתי. כך לא בונים תשתית חיבורים ריקה מדי עכשיו.

## מדיה ו־WAHA

WAHA מתעד HMAC-SHA512 על webhook ו־media storage עם retention תלוי תצורה. ל־URL זמני אין שרידות של אחסון עסקי. V5 מוריד מיד דרך worker נפרד, שומר checksum ואת הקובץ, ואחר כך משתמש ב־reference מקומי. יש להשוות את ה־payload, החתימה, LID, פורמט voice ו־media URL מול גרסת WAHA המותקנת.

לא נמצא בתיעוד send שנבדק חוזה idempotency המספיק להבטחת שליחה חיצונית exactly-once. לכן הסקנו שכשל רשת לאחר שליחה מחייב מצב uncertain ובירור; לא קבענו שגרסה עתידית או engine אחר לעולם לא יוכלו להציע idempotency.

מקורות: [WAHA events/HMAC](https://waha.devlike.pro/docs/how-to/events/), [Media storage](https://waha.devlike.pro/docs/how-to/storages/), [Send messages](https://waha.devlike.pro/docs/how-to/send-messages/).

אחסון מקומי הוא ההחלטה עכשיו: volume מגובה, replica אחד. S3-compatible ייכנס לפני כמה hosts או דרישת שרידות off-host. MinIO על אותו שרת אינו תחליף לגיבוי. אין שינוי storage/retention/webhook ב־WAHA במסגרת העבודה הזאת.

## observability, תחזוקה ואימות

נמדוד זמן ingress→processed, גיל תור, retry/failed/uncertain, זמן ו־usage של AI, media failures ושיעור הסלמות. worker heartbeat ו־readiness לא מוכיחים שהספקים החיצוניים זמינים. נדרש בהמשך ניטור חיצוני שלא תלוי באותה שליחת WhatsApp שנכשלה.

חבילות נעולות ב־package-lock. שדרוגים דרך build, tests ומבחן migration; אין latest אוטומטי ל־queue. הנתונים נשארים PostgreSQL וקבצים; תלות OpenAI מוגבלת ל־Planner ו־WAHA ל־Channel. החלפה עדיין דורשת בדיקות חוזה — adapter אינו מבטל את עבודת ההתאמה.

התוצר הנוכחי הוא חבילת יסודות ל־shadow. 22 בדיקות יחידה ו־27 אינטגרציה עברו על PGlite/PostgreSQL 18 WASM; SQL migrations נבדקו בנפרד גם על PostgreSQL 17 WASM. שתי בדיקות concurrency/crash native, Docker, EasyPanel, OpenAI ו־WAHA אמיתיים טרם אומתו. הפירוט המחייב הוא TESTING.md.

מקורות סביבת בדיקה והתקנה: [PGlite](https://pglite.dev/docs/about), [PGlite socket limitations](https://pglite.dev/docs/pglite-socket), [EasyPanel App source upload](https://easypanel.io/docs/services/app), [EasyPanel builders](https://easypanel.io/docs/builders).
