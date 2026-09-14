# השוואת נתונים ומצב

## מה השתפר

PostgreSQL מחליף שורה שטוחה בישויות עם foreign keys ו־constraints. message id ייחודי מונע קליטה כפולה, request version מונע כתיבה על מצב ישן, command_results מונע אפקט עסקי חוזר ו־outbox מחבר commit עסקי לשליחה עתידית. מספרי פנייה וקיבולת נשמרים תחת lock במסד.

## מיפוי עקרוני מהגיליון

| שדה legacy | יעד חדש | מצב |
|---|---|---|
| מספר פנייה | `requests.number` | מלא |
| סטטוס/תאריך | `requests`, `transport_runs` | מלא |
| מוסר/מקבל | `contacts` + `request_parties` | מלא וחזק יותר |
| יישוב/כתובת/קומה | `request_parties` | מלא, אך extraction חלקי |
| פריטים/כמות/פירוק | `request_items` | מלא וחזק יותר |
| תמונה | `media` + `request_media` | חזק יותר |
| מיקום/Waze | `request_locations` | נשמר ומוקרן לקישור מפה לפי הרשאה; provider E2E עדיין חסר |
| אישורים | `request_parties.approved_*` | חזק יותר |
| היסטוריה | `messages`, `request_events`, `command_results` | חזק יותר |
| התאמות | `searches`, `matches` | חזק יותר |
| הערות/שדות תפעול | `human_reason`/events + legacy fields | 28/28 mapped; שדות עם שינוי סמנטי מסומנים ל־reconciliation |

## פערי state מהותיים

### אימות צד שני

`verification_contacted boolean` נשמר לתאימות בלבד. state machine חדש מבחין לפחות בין:

`not_offered -> offered -> declined | consented -> queued -> provider_accepted -> delivered | failed | uncertain -> approved | rejected`.

status משתמש ב־verification state החדש; provider delivery/reconciliation עדיין דורשים בדיקה מול WAHA.

### burst של הודעות

`conversation_turns` ו־`turn_messages` שומרים את חלון האיסוף עמיד, כולל text/contact/location/image; generation ו־supersession מונעים תשובת AI מיושנת. multimodal stress מול ספק חי עדיין חסר.

### מיקום ומדיה

תמונה מקושרת לפנייה וניתנת לשליחה דרך media_id. location נטען ל־aggregate ומוצג כקישור מפה לפי role; בדיקת retrieval חיה עדיין חסרה.

### פניות מרובות

המודל החדש תומך היטב בכמה פניות לאותו contact. בחירה נעשית לפי request number/selected request/יחידה פעילה. עם זאת, מסירה מפורשת חדשה תמיד יוצרת פנייה חדשה; צריך מדיניות duplicate-intent וחלון זמן, לא רק parser.

## בעלות נתונים

- מצב עסקי: PostgreSQL בלבד.
- תוכן גולמי: `messages`; אין להשתמש בו כמקור מצב.
- אמת של side effect: outbox + provider receipt עתידי.
- טקסט prompt: metadata/audit, לא מקור אמת עסקי.
- media: storage object + checksum + DB reference; שניהם נדרשים.
- location: row versioned ומקושר לפנייה; יש להוסיף projection בטוח לממשקי admin/status.

## migration נדרש

קיים staging dry-run לייצוא Sheets עם hash, כותרות, duplicates ו־staging rows בלבד. לפני cutover עדיין יש להגדיר mapping מאושר לכל 28 השדות, ניקוי טלפונים, המרת תמונות/קישורים, reconciliation counts, רשימת חריגים ו־rollback marker. אסור dual-write לא מתואם לשני מקורות אמת.
