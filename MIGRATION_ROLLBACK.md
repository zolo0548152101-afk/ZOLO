# Migration ו־rollback

V5 אינו ממיר אוטומטית נתוני V3, Google Sheets או Node-RED. הוא יוצר schemas חדשים באותו DB. מצב shadow ו־simulation אינם תרגול על פניות חיות.

## לפני התקנה

1. שמור release/image, ENV והגדרות mounts של השירות הקודם.
2. גבה את ה־DB הקיים בכלי הגיבוי של EasyPanel, וודא שיש דרך לשחזר ל־DB נפרד.
3. גבה volume מדיה בנפרד. dump PostgreSQL אינו כולל תמונות.
4. אל תעלה dump או ENV לצ׳אט: הם עשויים לכלול סודות ופרטי לקוחות.

במחשב/שירות עם PostgreSQL client וכל המשתנים מוגדרים אפשר לגבות:

```sh
pg_dump --format=custom --file=haim-before-v5.dump "$DATABASE_URL"
pg_restore --list haim-before-v5.dump
```

ה־image של הבוט אינו כולל pg_dump. רשימת dump היא בדיקת תקינות בסיסית בלבד; נדרש restore ל־DB בדיקה כדי להוכיח שחזור.

## Migrations

```sh
node dist/db/migrate-cli.js
```

node-pg-migrate מפעיל SQL בסדר קבוע ותחת lock. checksum מונע שינוי migration שכבר הוחל. הקוד והסכמה צריכים להתעדכן יחד; שינויים עתידיים מוסיפים migration חדש. count המigrations הנתמך כרגע הוא 2.

pg-boss מנהל schema תורים משלו. Runtime מוגדר migrate=false; התקנה/שדרוג התור רק דרך CLI מבוקר. גרסת הספרייה נעולה. schema חדש לכל mode מפריד תור ונתונים.

## Rollback ב־shadow, עכשיו

מאחר ש־webhook לא שונה והישן נשאר פעיל, אפשר לעצור את שירות הניסוי או לשחזר את ה־release הקודם של haim-bot-core. אין צורך לנתב WAHA מחדש. שמור את schemas החדשים ואת ה־volume לצורך בדיקה; אין להריץ DROP או down migration.

Down migrations נחסמים בכוונה כדי למנוע מחיקת audit/נתונים. ה־rollback הראשוני הוא עצירת/החלפת image, לא היפוך SQL.

## Rollback אחרי live, בעתיד

1. הפסק ingress חדש למסלול החדש בתיאום עם בעל המערכת. שינוי WAHA רק באישור.
2. עצור workers חדשים כדי שלא ימשיכו לשלוח. ודא שלא קיימים שני מנועי reply פעילים.
3. בדוק outbox sending/uncertain מול היסטוריית WAHA לפני כל redrive.
4. השבת את המערכת הישנה רק לפי תוכנית ניתוב מאושרת.
5. יצא וסגור פערי פניות שנוצרו ב־V5 במהלך ה־live; הן אינן קיימות אוטומטית ב־Sheets.
6. אם נדרש restore, שחזר ל־DB נפרד, אמת אותו ורק אז החלף חיבור. restore לאחור לא מבטל הודעות WhatsApp שכבר נשלחו.

לפני שדרוג pg-boss עתידי יש לבדוק תאימות schema/image. אין להניח שהחזרת binary ישן מתאימה ל־schema שכבר שודרג. הגדר RPO/RTO לאחר מדידת גיבוי ושחזור על השרת.
