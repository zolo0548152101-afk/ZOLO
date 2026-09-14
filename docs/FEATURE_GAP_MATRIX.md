# מטריצת פערי יכולות

## מקרא

`PRESENT` דורש הוכחה בקוד ובבדיקה שעברה. `PRESENT_NOT_VERIFIED` קיים בקוד אך לא הורץ בביקורת. שאר הסטטוסים הם בדיוק טקסונומיית הביקורת שנדרשה.

| # | יכולת | Legacy | חדש | סטטוס | ראיה/פער |
|---:|---|---|---|---|---|
| 1 | מסירה פתוחה | כן | כן | `PRESENT` | PHOTO-FIRST מכוסה ב־unit וב־PostgreSQL integration |
| 2 | העברה ישירה ללא חובת תמונה | כן | כן | `PRESENT` | unit: direct recipient does not require photo |
| 3 | דילוג על שאלת תקינות בהעברה ישירה | כן | כן | `PRESENT` | unit + PostgreSQL integration עברו |
| 4 | הצעת אימות לצד השני | כן | כן | `PARTIAL` | מופיע ב־nextQuestion; זיהוי consent תלוי בנוסח קודם מדויק |
| 5 | שליחת אימות בפועל | כן | כן | `PRESENT_NOT_VERIFIED` | role-specific verification state + outbox קיימים; provider delivery לא הורץ |
| 6 | כל צד מאשר את עצמו | כן | כן | `PRESENT` | unit 212; constraints ב־request_parties |
| 7 | מספר נייד שנמסר נשמר | כן | כן | `PARTIAL` | persistence קיים; probe P12 חשף סדר/הרשאה בעייתיים בשם+טלפון |
| 8 | איחוד הודעות מהירות | כן | כן | `PARTIAL` | טקסט בלבד; multimodal אינו מאוחד ומוגן באותה רמה |
| 9 | ביטול תשובה מיושנת | generation token | durable turn supersession | `PRESENT` | delayed-AI integration עבר |
| 10 | תמונה ניתנת להחזרה | כן | storage+outbox | `PRESENT_NOT_VERIFIED` | checksum/FK נבדקו unit; retrieval/provider E2E לא |
| 11 | מיקום ניתן להחזרה | Waze/Sheet | נשמר + map projection | `PRESENT_NOT_VERIFIED` | build/integration עברו; provider E2E לא הורץ |
| 12 | רחובות רשמיים | data.gov | אין | `LEGACY_CAPABILITY_NOT_IN_MASTER` / `MISSING` | רק service_locations |
| 13 | שיכון/אזור בבית שאן מספיק | כן | חלקי | `PARTIAL` | nextQuestion מאפשר address; extractor טועה ב־P02/P03 |
| 14 | רדיוס שירות מדויק | כן | seed יישובים | `PARTIAL` | unknown עובר human; אין מאגר רחובות/גיאוגרפיה מלאה |
| 15 | hard stop מחוץ לאזור | כן | כן | `PRESENT` | PostgreSQL integration עבר |
| 16 | עד שני פריטים | כן | כן | `PRESENT` | unit + DB trigger |
| 17 | שולחן וכיסאות כיחידה | כן | כן | `PRESENT` | unit |
| 18 | ארון ללא פירוק | כן | כן | `PRESENT` | unit + PostgreSQL integration עברו |
| 19 | מקרר/מכשיר בלי שאלת פירוק | כן | כן | `PRESENT` | unit |
| 20 | תנור: סוג חובה | כן | כן | `PRESENT` | unit |
| 21 | matching-first למבקש | כן | כן | `PARTIAL` | command קיים; managed action translation חסר ב־P10 |
| 22 | כמה מתעניינים ממתינים לתמונה | כן | כן | `PRESENT` | PostgreSQL integration עבר עם כמה ממתינים |
| 23 | claim בלעדי | בסיסי | transaction/locks | `PRESENT` | PostgreSQL integration עבר עם claim בלעדי |
| 24 | כמה פניות לאותו טלפון | חלקי/חדשה ביותר | selection מפורש | `DIFFERENT_BUT_BETTER` | status מציג כולן; target דורש מספר כשעמום |
| 25 | `#פניות לחיים יחד` | `#פניות` | כל שלוש הווריאציות | `PRESENT` | admin integration test מחזיר את כל הפניות ללא AI וללא שינוי state |
| 26 | כל פרטי הפנייה בסטטוס | Sheet עשיר | projection חלקי | `PARTIAL` | חסרים media/location/events וחיווי אימות מדויק |
| 27 | שלישי 16–20 | כן | כן | `PRESENT` | unit timezone/cutoff |
| 28 | קיבולת אטומית | lock Apps Script | row lock PostgreSQL | `PRESENT` | native PostgreSQL concurrency test עבר |
| 29 | אישור same-day מנהל | כן | כן | `PRESENT` | PostgreSQL integration עבר |
| 30 | ביטול/אישור שבוע הבא | כן | כן | `PARTIAL` | commands קיימים; אין E2E חי |
| 31 | voice/IVRIT | כן | כן | `PRESENT_NOT_VERIFIED` | adapter קיים, provider לא נבדק |
| 32 | callback אנושי | כן | כן | `PRESENT_NOT_VERIFIED` | alert durable, אין E2E שליחה |
| 33 | prompt ID+version | ID בלבד | ID+version | `DIFFERENT_BUT_BETTER` | בקשת SDK offline הוכיחה בנייה בלבד |
| 34 | prompt מנסח כל הודעה | רוב המסלול | לא | `ARCHITECTURAL_GAP` | deterministic replies מוגנות מה־managed reply |
| 35 | הודעות מערכת דרך prompt | חלקן בקוד | `phraseNotice` post-commit | `PRESENT_NOT_VERIFIED` | קיים עם fallback וחסימת send בזמן pending; remote prompt E2E לא הורץ |
| 36 | durable inbox dedupe | לא | כן | `PRESENT` | unique constraint + PostgreSQL integration עברו |
| 37 | durable outbox | לא | כן | `PRESENT` | schema + Docker PostgreSQL integration עברו |
| 38 | delivery receipt | לא | כן | `PRESENT_NOT_VERIFIED` | receipt projection + monotonic admin endpoint; WAHA reconciliation לא הורץ |
| 39 | integrations delivery | Sheets פעיל | durable dispatcher | `PRESENT_NOT_VERIFIED` | dispatcher/idempotency נבדקו; adapter חיצוני לא מופעל כברירת מחדל |
| 40 | מסד ניתן לצפייה/עריכה | Sheet | admin 5 views | `PARTIAL` | child tables חסרות; generic edits מסוכנים |
| 41 | ניקוי כל נתוני הבדיקה | ידני | כפתור+endpoint | `PRESENT_NOT_VERIFIED` | לא הופעל בביקורת מטעמי בטיחות |
| 42 | simulation מבודד | לא | כן | `PRESENT` | local HTTP shadow E2E עבר 4/4 עם outbox simulation בלבד |
| 43 | allowlist | flow | inbound+outbound נפרדים | `PARTIAL` | שני מקורות הרשאה עלולים לסטות |
| 44 | migration מגיליון | לא רלוונטי | אין | `MISSING` | אין import/reconciliation/cutover |
