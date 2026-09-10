# Verification — V5 Foundation

תאריך: 2026-09-10. זהו רישום של מה שבוצע בפועל, ולא רשימת בדיקות שמסומנות כעברו רק משום שנכתב קוד עבורן.

| בדיקה | תוצאה |
|---|---|
| npm install, lockfile וקימפול TypeScript strict | עבר |
| Unit suite | 22/22 עברו |
| Integration suite על PostgreSQL 18.3 WASM / PGlite 0.5.8 | 27 עברו, 2 דולגו, 0 נכשלו |
| SQL migrations על PostgreSQL 17.5 WASM / PGlite 0.3.15 | עבר smoke נפרד |
| הרצת כל ה־suite על PGlite 17 דרך socket adapter | לא הושלמה: אי־תאימות/ניתוק adapter; אינה תוצאת אישור PG17 מלא |
| תחרות על capacity בשרת PostgreSQL 17 רגיל | נכתב מבחן, טרם הורץ |
| הריגת worker עם SIGKILL ו־lease recovery בשרת PostgreSQL רגיל | נכתב מבחן, טרם הורץ |
| Docker build/run | לא הורץ כאן: Docker אינו זמין |
| OpenAI, WAHA, IVRIT ו־EasyPanel אמיתיים | לא נבדקו ולא שונו |
| Hebrew model eval, prompt injection ו־caching מול API | דורשים המשך |

הלוגים המצליחים נמצאים בתיקיית verification. סביבת PGlite שימשה רק לבדיקה מקומית ואינה dependency של המוצר. מבחני PGlite אינם הוכחה ל־concurrency בין backend connections או התאוששות process אמיתית.

## פקודות

```sh
npm ci --ignore-scripts
npm run build
npm test
```

בדיקות integration מלאות, רק מול DB זמני ונפרד:

```sh
docker compose -f compose.test.yml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yml down
```

Compose יוצר PostgreSQL 17 זמני עם סיסמת fixture שאינה secret. אין קישור לשירותי המשתמש. נתוני הבדיקה זמניים. בהרצה עם DB אחר: הגדר TEST_DATABASE_URL ו־npm run test:integration. אל תגדיר TEST_BACKEND=pglite בשרת PostgreSQL רגיל. הסוויטה דורשת schema בדיקה ריק ולא מוחקת נתונים כדי להשיג זאת.

לבדיקת image הסופי:

```sh
docker build -t haim-yahad:v5-foundation .
```

בתוך image סופי לאחר migrations:

```sh
node --test dist-tests/tests/unit.test.js
node scripts/smoke.mjs
```

כלי AI בתשלום, opt-in, לאחר build:

```sh
RUN_PAID_AI_EVAL=true npm run test:ai
```

נדרש OPENAI_API_KEY. הוא מריץ ארבע דוגמאות סינתטיות מול המודל בלבד, ללא DB או WAHA. אין לראות בו golden suite מלא או מבחן עמידות לפרומפטים זדוניים.

## מפת Golden Scenarios

בדיקות unit בוחנות מדיניות ו־adapters. בדיקות integration משתמשות ב־PostgreSQL ובתור pg-boss אמיתיים, אבל ב־FakePlanner ו־FakeChannel: הן בודקות ביצוע פקודות עסקיות, לא את הבנת העברית של המודל.

| תרחישים שנדרשו | כיסוי קיים |
|---|---|
| שלום | ללא AI, ללא פנייה, outbox shadow, אפס send |
| מוסר מיטה ללא מקבל | photo first, השמטת שם/כתובת מוקדמים |
| תמונת מוסר | checksum וקישור לפנייה, תשובה ניטרלית |
| מחולה בכניסה; קומה במחולה | כתובת מספקת, קומה נשמרת 0 ולא נשאלת |
| מחוץ לאזור; גבולי | outside עוצר בלי אדמין; unknown מסלים |
| ארון לפירוק; ארון קטן שלם | rejection/acceptance לאחר תמונה |
| מקרר; מעל שני פריטים | אין שאלת פירוק; quantity מוגבל |
| מבקש פריט; match עם/בלי תמונה | חיפוש לפני פרטים, photo presentation לפני interest |
| donor/receiver approvals | אישורים נפרדים, אישור חוזר אינו משנה timestamp |
| duplicate webhook/tool | inbox/result/השפעה עסקית יחידים |
| שתי הודעות מהירות | ניסיון עיבוד הפוך נחסם; נשמר סדר קבלה |
| retry/transaction failure | rollback אטומי ושחזור; FIFO נשמר ב־retry |
| WAHA timeout/failure | uncertain ללא שליחה חוזרת; fallback רק chat invalid |
| human escalation | context נדרש, שיחה אינה חוזרת לבוט מעצמה |
| סטטוס; כמה פניות; מתואמת+חדשה | קריאה בלבד, שמירת פנייה מתואמת |
| Tuesday capacity | מגבלת קיבולת וסייג תיאום באותו יום; תחרות native ממתינה |
| group; malformed; auth | ignore/400/401 לפי המקרה |
| @lid | canonical זהה וניהול שיחה משותפת |
| OpenAI timeout | retry מוגבל ואז escalation, ללא הצלחה מדומה |
| tool forbidden change | דחייה לפי זהות/סכמה, audit והסלמה |

חיפוש ללא תוצאה נבחן עם מדיח כדי למנוע זיהום בין fixtures; כללי מקרר נבחנים בנפרד. בדיקת wording מלאה של "מבקש מקרר" מול מודל אמיתי עדיין נדרשת.

## שערים לפני live

- להריץ Docker Compose על PostgreSQL 17 רגיל ולתקן כל כשל, כולל שני המבחנים שדולגו כאן.
- לבדוק kill/restart בזמן ingress, שמירת plan, commit עסקי ושליחה לא ודאית; מבחן SIGKILL הקיים ממוקד ב־queue lease.
- לאמת HMAC raw body, retry payload, message id, LID, vCard, location, voice ו־media URL מול WAHA המותקן.
- לבדוק קובץ אמיתי וספק IVRIT; fixture תמונה נועד לשמירת bytes ואינו צילום תקין מלא.
- להריץ goldens בעברית דרך simulate עם AI אמיתי, כולל ניסוח שלילי, שני תפקידים לאדם, ריבוי פניות ו־prompt injection.
- לאמת רשימת אזור וקיבולת; לבדוק volume אחרי redeploy וגיבוי/שחזור.
- להוסיף בדיקת עומס מדודה והתראה חיצונית; רק אז לחבר webhook shadow באישור.

אין לסמן את הדגל LIVE_DEPENDENCIES_VERIFIED=true רק כדי לעקוף כשל בדיקה.
