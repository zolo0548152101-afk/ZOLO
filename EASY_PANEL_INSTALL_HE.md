# התקנת V5 ב־EasyPanel — מתחילים ב־shadow

**המסך הבא:** בפרויקט whatsapp פתח את השירות haim-bot-core. ב־Source בחר Upload והעלה את ZIP ה־V5. ב־Build בחר Dockerfile, נתיב Dockerfile בשורש והקשר build בשורש. אין לבחור Dockerfile inline ללא העלאת הקבצים.

עדיין לא משנים webhook, לא עוצרים Node-RED ולא עוברים ל־live. לפני החלפת שירות קיים שמור את הגדרותיו ואת image/release הקודם. אם השירות הקיים משרת תעבורה אמיתית, השתמש בשירות ניסוי חדש במקום להחליף אותו.

## 1. הכנה ו־Environment

יש להשתמש ב־PostgreSQL הקיים haim-db, בלי למחוק או לאתחל אותו. העתק את DATABASE_URL הפנימי שמופיע בפועל ב־EasyPanel; אל תנחש hostname או סיסמה. משתמש ה־DB צריך הרשאות יצירת schemas וטבלאות ב־DB היעד.

העתק את משתני ENV.example ל־Environment ומלא לפחות:

| משתנה | ערך |
|---|---|
| BOT_MODE | shadow |
| DB_SCHEMA | haim_core_shadow |
| DATABASE_URL | כתובת פנימית אמיתית של ה־DB הקיים |
| HAIM_ADMIN_TOKEN | מפתח אקראי חדש, לפחות 32 תווים |
| WAHA_WEBHOOK_HMAC_KEY | מפתח אקראי אחר, לפחות 32 תווים |
| AI_ENABLED | false בתחילת הבדיקה |
| WAHA_SESSION | HAIM_YAHAD |
| WAHA_BASE_URL | http://whatsapp_waha:3000 |
| ENABLE_SIMULATE | true |
| LIVE_DEPENDENCIES_VERIFIED | false |
| MEDIA_VOLUME_CONFIRMED | false עד בדיקת volume |
| PORT | 3000 |

ליצירת כל אחד משני המפתחות, במחשב שלך:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

שמור את הערכים ב־Environment בלבד. מפתח HMAC עדיין לא מוגדר ב־WAHA; נעשה זאת רק בהמשך באישורך. OPENAI_API_KEY, WAHA_API_KEY ו־IVRIT_API_TOKEN נדרשים בשלב בדיקת החיבור המתאים, לא לבדיקת ברכת סימולציה ראשונית.

## 2. Volume ו־Deploy

ב־Mounts/Storage הוסף volume קבוע ל־/data/haim-yahad-media. התהליך רץ כ־node, UID/GID 1000; ה־volume חייב לאפשר לו כתיבה. Named volume חדש בדרך כלל יורש הרשאות מתיקיית image. Bind mount קיים מחייב התאמת בעלות על התיקייה הייעודית בלבד בשרת. אין להריץ chown על /data כללי או על נתוני שירותים אחרים.

replica אחד. אם קיימת הגדרת stop grace period, הגדר לפחות 65 שניות. אם אינה מופיעה ב־UI, נשלים בהמשך בדיקת זמן העצירה ב־EasyPanel/Docker Swarm. graceful drain של האפליקציה הוא עד 60 שניות.

הפעל Deploy. build יפעיל npm ci, TypeScript ובדיקות יחידה. Docker build לא הורץ בסביבת הכנת החבילה, ולכן זהו שער האימות הראשון שלו. שמור את שגיאת build המדויקת אם יש כשל, בלי לצרף מפתחות.

## 3. Health ואז readiness ראשוני

פתח Terminal של haim-bot-core:

```sh
node -e "fetch('http://127.0.0.1:3000/health').then(async r=>console.log(r.status,await r.text()))"
node -e "fetch('http://127.0.0.1:3000/ready').then(async r=>console.log(r.status,await r.text()))"
```

health: צפוי 200 ו־mode shadow. readiness: לפני migrations צפוי 503. זה מצב מתוכנן, לא סיבה למחוק DB. ה־healthcheck של Docker בודק /health כדי לאפשר את שלב ה־migrations.

## 4. Migrations

לאחר גיבוי DB לפי MIGRATION_ROLLBACK.md, ב־Terminal של השירות:

```sh
node dist/db/migrate-cli.js
```

הפקודה יוצרת schemas חדשים: haim_core_shadow, haim_core_shadow_jobs, haim_core_sim ו־haim_core_sim_jobs. היא אינה מייבאת נתונים מהישן ואינה משנה את schema של V3. אין migration אוטומטי בעליית השרת.

הרץ שוב את בדיקת /ready לאחר כמה שניות. צפוי 200, schema haim_core_shadow וגם simulation_ready true. אם לא, שלח את error code/לוג startup ללא credentials.

## 5. בדיקות וסימולציה

בדיקות היחידה שכבר קומפלו זמינות גם ב־image הסופי:

```sh
node --test dist-tests/tests/unit.test.js
node scripts/smoke.mjs
```

smoke בודק health/readiness ושולח "שלום" ל־API סימולציה ב־schema נפרד. הוא אינו שולח WhatsApp. מצופה isolated_greeting ok=true. אין צורך ב־AI בשביל "שלום".

אחרי שהבסיס תקין: מלא OPENAI_API_KEY, הגדר AI_ENABLED=true ובצע redeploy. כעת ניתן לבדוק תרחישי שיחה דרך simulate; קריאות המודל כרוכות בעלות. דוגמה ב־Terminal:

```sh
node -e "fetch('http://127.0.0.1:3000/admin/simulate',{method:'POST',headers:{'content-type':'application/json','x-admin-token':process.env.HAIM_ADMIN_TOKEN},body:JSON.stringify({phone:'0500000001',text:'יש לי מיטה למסירה'})}).then(r=>r.json()).then(console.log)"
```

התוצאה כוללת result_url לקריאה עם אותו x-admin-token. בדוק reply, requests ו־outbox. בתרחיש הזה התשובה צריכה לבקש תמונה לפני שם/כתובת. מספר הסימולציה אינו מקבל הודעה אמיתית.

אין להריץ integration tests מול haim-db הייצורי. TESTING.md כולל Docker Compose עם PostgreSQL זמני נפרד.

## 6. בדיקות לפני webhook

צריך לבדוק בהמשך: Docker image מלא, שני מבחני native PostgreSQL, storage persistence אחרי redeploy, כל goldens מול מודל אמיתי, LID/voice/media/send מול גרסת WAHA המותקנת, רשימת יישובים מלאה וקיבולת מוסכמת. readiness אינה בודקת את כל אלה.

חיבור webhook ב־shadow הוא שלב נפרד המחייב אישורך. endpoint הוא /webhooks/waha. הוא דורש HMAC-SHA512 בתואם תצורת WAHA. אם רוצים העתק לצד Node-RED, צריך לתכנן את fan-out בהתאם לגרסה המותקנת, בלי להחליף את הנתיב הפעיל.

אחרי החיבור המאושר: הודעות אמיתיות צריכות להופיע ב־shadow DB וב־outbox state=shadow; אין replies, גם לא התראות למנהל. השווה trace_id, הודעה, פנייה ותשובת shadow ללוגים הישנים.

## 7. מעבר עתידי ל־live — לא כעת

הסדר: בדיקות native וחוזי ספקים → תיקון פערים → pilot allowlist → אישור שלך → ניתוב אחד שמונע שתי מערכות עונות במקביל.

live משתמש ב־haim_core וב־haim_core_jobs חדשים, ולא ב־schema של shadow. צריך לתכנן רצף מספרים ונתוני legacy לפני יצירת פניות אמיתיות. לא מעתיקים outbox של shadow. רק לאחר השלמת ההכנות אפשר להגדיר LIVE_DEPENDENCIES_VERIFIED=true ו־MEDIA_VOLUME_CONFIRMED=true; הדגלים אינם מחליפים בדיקה.

אם נעצרים אחרי ההתקנה הראשונית, שמור ZIP ו־NEXT_STEPS_HE.md לצ׳אט הבא.
