# ניתוח פערי בדיקות

## מה הורץ בביקורת

| בדיקה | תוצאה |
|---|---|
| TypeScript build: `tsc -p tsconfig.json` | עבר |
| TypeScript tests build: `tsc -p tsconfig.tests.json` | עבר |
| unit: `node --test dist-tests/tests/unit.test.js` | 32/32 עברו |
| probes: `node scripts/audit-offline-probes.mjs` | 12/12 מחוברים לעוגני regression בעלי שם; הוולידטור אינו מפעיל שירות חיצוני |
| integration PostgreSQL | 40/40 עברו ב־Docker PostgreSQL disposable |
| OpenAI managed prompt מרוחק | לא הורץ — audit offline בלבד |
| WAHA send/media/receipt | לא הורץ — לא נשלחו הודעות |
| production E2E | לא הורץ |

## ממצאי probes

1. direct bed אינו נשאל על פירוק אך אינו `readyToCoordinate` ללא ערך פירוק.
2. “בית שאן שיכון א למירב” מאבד כתובת/שם בתכנון הדטרמיניסטי.
3. “שיכון א” עלול להישמר כשם כאשר name חסר.
4. מסירה מפורשת חוזרת יוצרת command לפתיחת מסירה נוספת גם כשיש selected request.
5. “מה מצב הפנייה?” ו־“זה כבר מתואם?” אינם מזוהים כסטטוס.
6. “מיטה שבורה לטל” מסווגת direct עם `working=true`.
7. סירוב לאימות יוצר zero notices אך status אומר שנשלחה פנייה.
8. managed action של notify receiver אינו מתורגם ל־dispatch.
9. בקשת OpenAI כוללת prompt ID+version; אין בכך הוכחת remote success.
10. managed interest/acceptance אינו מתורגם לפקודת interest.
11. self_move חדש מתורגם ל־`next` בלבד.
12. name+phone לצד השני עלולים להחיל details בשם actor לא מורשה לפני counterparty.

ה־probes הם artifact של audit, לא regression tests מאושרים. אחרי תיקון יש להפוך כל אחד מהם לבדיקה מצפה־הצלחה.

## סתירות בסוויטה הקיימת

- unit בשם “donor without receiver can continue without photo” עומד מול integration בשם “PHOTO FIRST”. צריך להכריע specification אחד ולמחוק את הסתירה.
- integration “core donation conversation completes without calling AI” אינו מתיישב לכאורה עם `processNext`, שקורא ל־AI לכל text לפני `finish`. בלי הרצת integration אין לקבוע מה באמת קורה.
- קיום test source אינו `PRESENT`; PostgreSQL, pg-boss ו־transaction semantics לא נבדקו בסביבה הנוכחית.

## מטריצת בדיקות חסרה

| שכבה | חובה לפני live |
|---|---|
| domain | table-driven לכל intent×origin×role×item×location |
| prompt | golden/eval בעברית, multi-message, typos, forbidden claims |
| translator | כל action ב־schema חייב mapping או rejection מפורש |
| DB | migration up/down/checksum, constraints, concurrency, crash points |
| queue | retry, restart, stalled ingest, FIFO block/resolve |
| WAHA contract | webhook variants, LID, media, provider IDs, receipts |
| media | restart/restore, forward back, missing object, retention |
| location | כל רחובות בית שאן, שכונות, aliases, boundary/outside |
| admin | auth, RBAC, safe edits, export, destructive confirmation |
| E2E | ארבעה flows מלאים רצופים ב־shadow, canary allowlist בלבד |

## ארבעת תרחישי ה־release הראשונים

1. העברה ישירה עם שם+טלפון: הצעת אימות, consent, הודעה לצד השני, אישור שני הצדדים ותיאום.
2. העברה ישירה ללא תמונה וללא שאלת תקינות; מיטה אינה נתקעת על פירוק שלא נשאל.
3. מסירה פתוחה PHOTO-FIRST, matching, תמונה חוזרת למקבל ו־exclusive claim.
4. רצף 3 הודעות מהיר הכולל text+vCard/location: תשובה אחת, כל הנתונים נשמרים ואין תשובה מיושנת.
