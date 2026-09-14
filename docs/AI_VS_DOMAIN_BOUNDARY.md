# גבול בין AI ללוגיקה עסקית

## העיקרון

ה־AI צריך להבין ולנסח; הקוד צריך להחליט ולבצע. אין לאפשר ל־reply של prompt להצהיר על side effect שלא נוצר ב־domain ונרשם ב־outbox.

## חלוקת אחריות מומלצת

| AI רשאי | Domain בלבד |
|---|---|
| לזהות intent מתוך עברית טבעית | לפתוח/לבחור פנייה |
| לחלץ שם, טלפון, פריט, כתובת מועמדת | לנרמל ולאמת טלפון וזהות actor |
| להציע תיקון כתיב ליישוב/רחוב | להכריע אזור שירות לפי dataset versioned |
| לנסח שאלה אחת קצרה מתוך `message_intent` | לבחור מהו השדה הבא החסר |
| לאחד 2–3 הודעות לכוונה אחת | לקבוע turn ordering ו־supersession |
| לנסח notice לצד שני מתוך facts | ליצור outbox ולדווח אם נשלח |
| לסווג ambiguity ולבקש human | לשנות status, approvals, capacity או matching |

## המצב הנוכחי

1. `OpenAIPlanner.plan` שולח prompt ID ו־version ומבקש JSON מובנה.
2. `rulePlan` לעיתים מחליף את פעולות ה־AI בפעולות דטרמיניסטיות.
3. managed reply נשמר ב־metadata.
4. אם `action_source=deterministic_flow`, Engine מגן על טקסט הקוד ואינו משתמש בניסוח הפרומפט.
5. במסלול לא דטרמיניסטי managed reply עשוי להחליף את reply שנוצר מה־commands.

שתי ההתנהגויות יוצרות בעיה סימטרית: במסלול אחד הפרומפט אינו מעצב את ההודעה; במסלול אחר הוא עלול לעקוף טקסט שנגזר מתוצאה עסקית.

## חוזה מתוקן

ה־AI יחזיר שני חלקים בלבד:

```json
{
  "extractions": [{ "field": "receiver_phone", "value": "...", "confidence": 0.98 }],
  "style": { "tone": "warm_short", "acknowledge": ["..."], "language": "he" }
}
```

ה־domain יחזיר `Outcome` מובנה:

```json
{
  "state_changes": ["verification_consent_recorded"],
  "notices": [{ "kind": "verification_request", "recipient_role": "receiver" }],
  "next_message": { "intent": "ask_receiver_confirmation", "facts": { "request_number": 123 } }
}
```

formatter מבוסס prompt יקבל רק `next_message.intent + facts + style rules`, יחזיר טקסט, ולא יקבל הרשאה לשנות actions. validator יוודא שאין בטקסט claims אסורים כמו “שלחתי” כאשר outbox לא נוצר.

## כללי prompt שצריך לשמר

- עברית קצרה ואנושית; מטרה מרכזית אחת ועד 2–3 פרטים קשורים.
- לענות יחד על כל ההודעות שטרם נענו ולא לחזור על שאלה שכבר נענתה.
- בהעברה ישירה: תמונה אופציונלית, אין שאלת תקינות, ויש להציע פנייה לצד השני.
- במסירה פתוחה: PHOTO-FIRST לפני איסוף פרטים.
- בבית שאן רחוב/שכונה/אזור/נקודת ציון מספיקים; אין להתעקש על מספר בית.
- מחוץ לבית שאן תיאור מיקום כללי מספיק; אין לשאול קומה.
- כל צד מאשר את עצמו; אין להבטיח הודעה, תיאום או מסירה לפני outcome מוכח.
- unknown/borderline מועבר לאדם; מחוץ לאזור נעצר מיד.

## אימות prompt

בביקורת offline הוכח שה־SDK בונה בקשה עם ID+version. לא בוצעה קריאת רשת ולכן אין הוכחה שהגרסה המרוחקת קיימת, שזה תוכנה בפועל או שכל output עומד בחוזה. נדרש eval suite נגד prompt המרוחק כחלק מ־release gate.

