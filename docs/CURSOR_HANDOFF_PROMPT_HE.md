# Prompt למסירה ל-Cursor

הדבק את הטקסט הבא בשיחת Cursor מקומית, אחרי שפתחת את התיקייה `C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION`:

```text
אתה מקבל אחריות על מעבר מבוקר של שירותי HAIM משרת Docker Swarm/EasyPanel קיים לשרת חדש.

קרא קודם את docs/SERVER_CURSOR_MIGRATION_HANDOVER_HE.md ואת המסמכים שהוא מפנה אליהם. מקור הקוד הוא GitHub zolo0548152101-afk/ZOLO, ענף qa-build. אל תניח ש-main הוא המקור הפעיל.

כללים:
1. אל תדפיס, תשמור ב-Git או תדביק בצ'אט API keys, tokens, DATABASE_URL עם סיסמה, WAHA session, cookies או SSH private keys.
2. הסודות עוברים רק דרך secret store חדש ומוגן. צור inventory של שמות המשתנים בלבד.
3. אל תבצע deployment, DNS cutover, שינוי WAHA, הודעת WhatsApp אמיתית או מחיקת נתונים לפני שתציג ותאמת: manifest, backup/restore drill, תוכנית cutover ותוכנית rollback.
4. אל תעתיק את whatsapp_waha_sessions ל-Git. ברירת המחדל היא WAHA QR re-auth על השרת החדש, לא העתקת session עיוורת.
5. HAIM, Node-RED, Facebook Intel ו-EasyPanel הם רכיבים נפרדים. קודם שאל/אמת אילו מהם באמת צריכים לעבור.
6. שמור את השרת הישן זמין ל-rollback עד סוף חלון היציבות. אל תבצע reset או מחיקה על השרת הישן.

שלב ראשון מבוקש: בצע read-only inventory של הקוד ושל שרת המקור, וכתוב MIGRATION_MANIFEST.md הכולל שירותים, images, volumes, networks, domains, DBs, שמות secrets בלבד, תלות, נתיב גיבוי, owner ופעולת rollback. לאחר מכן עצור ובקש אישור לתוכנית המעבר. אל תבצע שינוי תשתית בשלב זה.
```

המסמך המלא הוא מקור האמת למסירה; ה-prompt הזה נועד רק להתחלה בטוחה.
