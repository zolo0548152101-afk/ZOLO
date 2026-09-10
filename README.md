# חיים יחד — V5 Foundation

תשתית המשך לפרויקט הקיים, מוכנה להעלאה לניסוי **shadow** ב־EasyPanel. גרסה 0.5.0, תאריך 2026-09-10.

הבחירה: **Node.js 24 + TypeScript strict + Fastify 5 + PostgreSQL 17 + pg-boss + OpenAI Agents SDK / Responses API**. שירות Bot Core אחד לצד PostgreSQL ו־WAHA הקיימים. מדיה על persistent volume. אין צורך להקים Redis, MinIO או מנוע workflow נוסף בשלב הזה.

זו חבילת יסודות עובדת עם קוד, migrations, tests ותיעוד. היא **אינה אישור למעבר ל־live**. בהתאם לבקשה האחרונה, בדיקות שרת, Docker, חיבורי הספקים והשלמת תרחישי שיחה יתבצעו יחד בהמשך. תוצאות הבדיקות והפערים כתובים ב־TESTING.md וב־NEXT_STEPS_HE.md.

## מה לקרוא

1. EASY_PANEL_INSTALL_HE.md — המסך הבא והתקנה ב־shadow.
2. ARCHITECTURE.md — גבולות המערכת והחלטות היישום.
3. RESEARCH_HE.md — המחקר, ההשוואות והסיבה לבחירה.
4. TESTING.md — מה עבר בפועל ומה עוד לא הורץ.
5. MIGRATION_ROLLBACK.md — schemas נפרדים, גיבוי ונסיגה.
6. NEXT_STEPS_HE.md — מסמך להעברה לצ׳אט הבא, כולל מגבלות ידועות.
7. ENV.example — כל משתני הסביבה.
8. ATTRIBUTIONS.md — חבילות, גרסאות ורישיונות.

## התחלה מקומית

נדרש Node.js 24. אין לשים סיסמאות בקוד.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

לאחר הגדרת משתני ENV.example דרך סביבת ההרצה:

```sh
npm start
# בחלון נוסף, רק מול DB היעד של shadow:
npm run migrate
npm run smoke
```

אין טעינה אוטומטית של קובץ ENV.example. בסביבת פיתוח ניתן להשתמש ב־Node:
`node --env-file=.env dist/server.js`; לצורך migrations:
`node --env-file=.env dist/db/migrate-cli.js`.

השרת עולה עם /health גם לפני migrations. /ready יחזיר 503 עד להשלמתן. אין להתייחס ל־health כבדיקת זמינות WAHA/OpenAI.

## מה קיים בקוד

- inbox עמיד, deduplication לפי channel/session/message-id, journal של פקודות ו־outbox אטומי עם עבודות pg-boss.
- סדר הודעות לפי מספר קבלה פנימי, נרמול LID, הרשאות צד, הגנת פנייה מתואמת, כמה פניות לאותו contact.
- חוקי photo first, אזור, ציוד, אישורים, matching, שלישי וקיבולת בקוד.
- AI מוגבל להצעת פקודות מאומתות. אין כלי SQL, שליחה או עדכון שדות שרירותי.
- הורדת מדיה, checksum ושמירה עמידה; voice דרך adapter של IVRIT.
- APIs מוגנים לניהול, סימולציה ב־schema נפרד, לוגים עם trace_id, readiness וכיבוי מסודר.
- עצירה לבירור כשהתוצאה של שליחת WhatsApp אינה ודאית, כדי לא לשלוח שוב בעיוורון.

לא נכללו credentials, נתוני לקוחות מה־flow או העתק של מערכת Node-RED הישנה. לא שונה webhook ולא בוצע deploy לשרת שלך.
