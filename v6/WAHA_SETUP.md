# חיבור WAHA לגרסה 6

WAHA כבר רץ. אין Docker ואין EasyPanel עבור הבוט. הסוכן לא רץ על השרת.

הכתובת הקיימת:

`https://whatsapp-waha.cdpvmq.easypanel.host`

WAHA `2026.8.1` CORE, מנוע `WEBJS`. בלי סלאש בסוף.

## אותו סשן כמו גרסה 5

אין סשן חדש. גרסה 6 משתמשת בסשן `HAIM_YAHAD`, מספר `972543414386`. זה אותו חיבור וואטסאפ של גרסה 5.

הבעלים מחליף בעצמו איזה בוט פעיל: webhook של גרסה 5, או webhook של סוכן גרסה 6. רק אחד מהם פעיל על הסשן. אין ליצור `HAIM_V6`, ואין לשנות את ה־webhook החי מתוך העבודה הזו.

מפתח ה־API של WAHA נשאר אצל הסוכן. הוא נשלח בכותרת `X-Api-Key` בקריאות יוצאות.

## Webhook אל הסוכן

במסך הסשן `HAIM_YAHAD`, הבעלים מגדיר webhook להודעה נכנסת:

- URL: כתובת ה־webhook של סוכן Grok. זו כתובת סודית.
- אירועים: `message`. אפשר גם `message.any` אם המסך מציע רק אותו. הסוכן מתעלם מכל אירוע שאינו אחד מהשניים.
- כותרת מותאמת: ל־WAHA יש תמיכה ב־custom headers. מוסיפים כותרת `Authorization` עם הערך שהסוכן מצפה לו. לא שומרים את הערך בקוד.

כדי לחזור לגרסה 5, הבעלים מחזיר את כתובת ה־webhook הקודמת על אותו סשן `HAIM_YAHAD` ומסיר או מחליף את כותרת ה־`Authorization` של גרסה 6.

אם WAHA גם חותם את הגוף (HMAC-SHA512, הכותרת `X-Webhook-Hmac` ב־hex באורך 128), והסוכן רואה את הגוף הגולמי, הוא בודק את החתימה עם סוד ה־webhook וזורק אי־התאמה. אם הסוכן לא רואה גוף גולמי, הכתובת והכותרת `Authorization` הן הסוד ואין לפרסם אותן.

## API יוצא

הסוכן קורא לאותה כתובת HTTPS. אין צורך ב־proxy חדש.

בדיקה, בלי להדפיס את המפתח לקובץ ציבורי:

```bash
curl -sS -H "X-Api-Key: $WAHA_API_KEY" \
  "$WAHA_BASE_URL/api/sessions/HAIM_YAHAD"
```

שליחת טקסט, רק אחרי שהסוכן החזיר שורת `outbound` במצב `pending`:

```bash
curl -sS -X POST "$WAHA_BASE_URL/api/sendText" \
  -H "content-type: application/json" \
  -H "X-Api-Key: $WAHA_API_KEY" \
  -d '{"session":"HAIM_YAHAD","chatId":"9725XXXXXXXX@c.us","text":"..."}'
```

`chatId` ו־`text` מגיעים משורת ה־`outbound` ש־`haim_apply_turn` החזיר. לא מרכיבים אותם מחדש מזיכרון.

## מה הסוכן צריך

- `WAHA_BASE_URL=https://whatsapp-waha.cdpvmq.easypanel.host`
- `WAHA_API_KEY`
- `WAHA_SESSION=HAIM_YAHAD`
- `DATABASE_URL` של Neon

דף הניהול לא מתחבר ל־WAHA ולא מציג QR.
