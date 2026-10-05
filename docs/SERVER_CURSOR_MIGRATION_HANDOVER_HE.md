# מסמך מסירה: מעבר שרת והעברת המשך העבודה ל-Cursor

עדכון אחרון: 2026-10-05
מטרת המסמך: לתת למי שממשיך ב-Cursor תמונה מלאה ומעשית של הקוד, השרת, הנתונים, הסודות ותהליך המעבר לשרת חדש — בלי להכניס סודות למאגר או למסמך.

> כלל בטיחות: המסמך מתעד **שמות משתנים, מיקומים ורכיבים**, לא ערכי API, סיסמאות, טוקנים, מפתחות SSH או סשני WhatsApp. אין להדביק ערכים כאלה ל-GitHub, ל-Cursor chat, למסמך זה או ל-`.env.example`.

## 1. תמונת מצב קצרה

| נושא | המצב הידוע |
| --- | --- |
| שרת נוכחי | VPS בשם `hal-server-858371`, מנוהל ב-Docker Swarm עם EasyPanel ו-Traefik |
| דרך גישת תפעול קיימת | WSL Ubuntu מקומי → SSH כ-`root` אל השרת; אין להעתיק את המפתח הפרטי ל-Cursor |
| אפליקציית HAIM | שירות `whatsapp_haim-bot-core`, PostgreSQL, WAHA ו-Node-RED |
| קוד HAIM | `C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION` |
| מאגר HAIM | `https://github.com/zolo0548152101-afk/ZOLO.git`, ענף עבודה `qa-build` |
| גרסת קוד מקומית מתועדת | `b84ce5e19a79d7827d3386512e0eddc0d6a97f94` בענף `qa-build`; יש לאמת מול `origin/qa-build` לפני כל מעבר |
| מצב HAIM | שירות ה-QA פרוס ובריא; T24/T25 עברו כשערי shadow/canary ללא תעבורת WhatsApp חיה. אין לטעון שבוצעה הסמכת 8/8 חיה. |
| יישום נוסף | `C:\פרוייקטים\KNEYOT` — אפליקציית קניות Next.js, מקומית, ללא Git במצב שנבדק |
| פרויקט סקירה נפרד | `C:\פרוייקטים\review-codex-bridge`, מאגר `zolo0548152101-afk/review-codex-bridge` |

## 2. מה עובר ב-Git ומה לא

### עובר ב-Git / אפשר לתת ל-Cursor

- קוד המקור, migrations, בדיקות, תיעוד, קובצי Docker ו-scripts מתוך מאגר `ZOLO`.
- היסטוריית `qa-build`, כולל ראיות QA שאינן מכילות נתוני ריצה או סודות.
- פרויקט הקניות בתיקיית `KNEYOT`, לאחר יצירת מאגר Git מסודר עבורו או העתקה מבוקרת.

### לא עובר ב-Git

- `.env`, `.env.local`, כל מפתח API, URL עם סיסמה, token, cookie או private key.
- נפחי Docker, בסיסי נתונים, גיבויי SQL, קבצי מדיה שהתקבלו, לוגים, `node_modules` וסשני WAHA.
- תיקיית העבודה הזמנית `C:\Users\זולו\Documents\Codex\2026-09-10\fnv`; זו תיקיית עזר מקומית בלבד, לא מקור אמת.

## 3. פרויקטים ותיקיות מקומיות

| מיקום | תפקיד | מקור אמת / הערות |
| --- | --- | --- |
| `C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION` | קוד HAIM החדש: בוט, API ניהול, DB migrations, בדיקות ו-runbooks | מקור הקוד הפעיל. GitHub `ZOLO`, ענף `qa-build`. |
| `C:\פרוייקטים\HAIM_YAHAD_DEPLOY_ARCHIVE` | חומר פריסה/ארכיון קודם | לשמר לקריאה והשוואה בלבד עד אימות מלא של המעבר; לא להניח שהוא משקף את ה-image הפעיל. |
| `C:\פרוייקטים\review-codex-bridge` | פרויקט/מאגר תיאום סקירה נפרד | מיועד למנגנון ביקורת, לא לשירות HAIM בפרודקשן. |
| `C:\פרוייקטים\KNEYOT` | אפליקציית קניות בעברית | Next.js 16, Drizzle, Neon/Postgres או PGlite מקומי. כרגע יש `.env.example` בלבד; לא זוהה `.env.local`. |
| `C:\Users\זולו\Documents\Codex\2026-09-10\fnv` | סקריפטי עזר זמניים: probes/WAHA | לא לפרוס ולא להעתיק אוטומטית לשרת החדש. יש להעביר רק סקריפט שעבר סקירה ומקבל בית מסודר במאגר. |

## 4. HAIM: ארכיטקטורת הקוד והזרימה

הטכנולוגיה: Node.js 24, TypeScript strict, Fastify 5, PostgreSQL 17, `pg-boss`, OpenAI Responses/Agents SDK, ו-WAHA.

```text
WAHA webhook
  -> אימות HMAC + Durable Inbox + deduplication
  -> Turn aggregator (טקסט/מדיה/מיקום באותו תור)
  -> חוקים דטרמיניסטיים + AI לחילוץ/ניסוח מוגבלים
  -> Domain state machine
  -> transaction: facts / requests / events / transactional outbox
  -> pg-boss workers
  -> WAHA sender + provider receipt/reconciliation
```

מבנה הקוד העיקרי:

- `src/domain/` — מודל עסקי, מדיניות ומכונת מצבים.
- `src/application/` — engine, workers, commands, runtime, security ו-backup logic.
- `src/infrastructure/` — PostgreSQL store, WAHA adapter ו-OpenAI adapter.
- `src/http.ts` — webhook, admin API/UI, simulation, readiness.
- `src/db/migrations/` — migrations; יש לבדוק checksum ומצב migrations לפני מעבר.
- `tests/`, `scripts/`, `artifacts/qa/`, `docs/qa/` — בדיקות, gates, ראיות ותיעוד תפעולי.

מסמכי חובה למפעיל החדש:

1. `docs/ARCHITECTURE_RECOMMENDATION.md`
2. `docs/NEW_SYSTEM_MAP.md`
3. `docs/RELEASE_RUNBOOK.md`
4. `docs/qa/MASTER_PROGRESS.md`
5. `artifacts/qa/CODEX_LATEST_HANDOFF.md`
6. `docs/qa/CODEX_EXECUTION_POLICY.md`

פקודות קוד חשובות:

```powershell
npm ci --ignore-scripts
npm run build
npm test
npm run test:integration
npm run test:regressions
npm run test:golden
npm run test:t21-t22
npm run test:t24-shadow
npm run test:t25-canary
```

אין להפעיל `migrate`, `release-gate`, סקריפטי restore או פעולות WAHA נגד שרת חדש/ישן בלי לבחור במפורש סביבת יעד ולקרוא את ה-runbook.

## 5. מצב השרת הקיים

השרת הנוכחי מריץ Docker Swarm. השירותים שנצפו:

| שירות | image/תפקיד | נתונים שיש לשמר |
| --- | --- | --- |
| `whatsapp_haim-bot-core` | HAIM Node/TypeScript API + workers | קונפיגורציית סביבה, image/tag שנבדק, קובץ מדיה דרך volume |
| `whatsapp_haim-db` | PostgreSQL 17 ל-HAIM | dump עקבי של בסיס הנתונים, roles/credentials, schemas ומigrations |
| `whatsapp_waha` | WAHA | קונפיגורציה וסשני WhatsApp; עדיף לרוב התחברות QR מחדש במקום העתקת session עיוורת |
| `whatsapp_nodered` | Node-RED | volume של flows/credentials; נדרש backup מוצפן ומוגן |
| `easypanel` + `easypanel-traefik` | ניהול אפליקציות ו-proxy/SSL | הגדרות פרויקטים, domains, routing ותעודות/ACME מחדש או לפי דרך הגירה מאושרת |
| `facebookintel_app`, `facebookintel_worker`, `facebookintel_db` | שירות Facebook Intel נפרד | DB ו-config שלו |
| `facebookintel_chromium`, `facebookintel_cdp-proxy` | דפדפן/Proxy של Facebook Intel | Chromium config/session — מידע רגיש; לגבות רק אם ממשיכים שירות זה |

נפחי Docker בולטים שנצפו:

- `whatsapp_haim-bot-core_haim-yahad-media` — המדיה של HAIM.
- `whatsapp_waha_sessions` — session/authentication של WAHA, רגיש ביותר.
- `whatsapp_nodered_data` — נתוני Node-RED, עשויים לכלול credentials מוצפנים.
- `facebookintel_facebook_intel_pgdata` — PostgreSQL של Facebook Intel.
- `facebookintel_facebook_intel_chromium_config` ו-`..._session2/3/4` — נתוני דפדפן/session.
- `facebookintel_facebook_intel_worker_data` — נתוני worker.

רשתות בולטות: `easypanel`, `easypanel-whatsapp`, `facebookintel_facebook_intel`. יש לשחזר הפרדה זו או להחליט על design חלופי לפני העלאה.

הכתובת הציבורית שנצפתה עבור HAIM היא:

`https://whatsapp-haim-bot-core.cdpvmq.easypanel.host/haim-admin`

זו אינה התחייבות שזו כתובת הקבע הרצויה. לפני cutover יש להכין domain, DNS, TLS, webhook target ו-rollback ברורים.

## 6. נתונים ומקורם

| סוג נתון | מקום נוכחי | שיטת מעבר מומלצת |
| --- | --- | --- |
| נתוני HAIM | PostgreSQL בשירות `whatsapp_haim-db`; DB `haim_yahad`, schema live `haim_core` | dump עקבי, בדיקת restore לשרת החדש, `foreign_key_check`/migrations/checksums לפני חשיפה. |
| מדיית HAIM | Docker volume `whatsapp_haim-bot-core_haim-yahad-media` | archive עם manifest, checksum, ומבחן שחזור מול `storage_key` מה-DB. |
| סשני WAHA | `whatsapp_waha_sessions` | לשמור כגיבוי מוצפן בלבד. ברירת מחדל עדיפה: QR re-auth על השרת החדש לאחר תוכנית cutover. |
| Node-RED | `whatsapp_nodered_data` | export/backup מוצפן; לא לשים ב-Git. יש לבדוק תלות בקובץ credential secret. |
| Facebook Intel | DB + Chromium/config/worker volumes | להעביר רק אם השירות נדרש. להפריד מגיבוי HAIM ולא לחשוף cookies/session. |
| גיבויי QA קודמים | בשרת תחת `/var/backups/haim-qa/` | לשמר עד לאחר rollback window. הם server-only ואינם artifact של Git. |

## 7. מסירת סודות ו-API keys — בלי להדליף ערכים

### עיקרון

Cursor צריך לקבל **גישה מבוקרת למערכת סודות**, לא רשימת ערכים בתוך prompt. מומלץ להשתמש במנהל סודות של ספק השרת החדש, EasyPanel secrets, Docker Swarm secrets, 1Password/Vaultwarden/Bitwarden או channel פרטי אחר שהבעלים שולט בו.

### מקומות הבדיקה הנוכחיים

1. **HAIM service environment**: בקונפיגורציה של Docker Swarm/EasyPanel לשירות `whatsapp_haim-bot-core`.
2. **PostgreSQL service environment**: לשירות `whatsapp_haim-db` (credentials/DB bootstrap).
3. **WAHA service environment וה-volume**: `whatsapp_waha` ו-`whatsapp_waha_sessions`.
4. **Node-RED volume/config**: `whatsapp_nodered_data`.
5. **SSH**: מפתח התפעול הנוכחי נמצא בסביבת WSL של המחשב, תחת `/home/zolo/.ssh/`; אין להעביר את private key ל-Git, ל-Cursor או לצ׳אט. יש ליצור deploy key חדש למעבר ולהחליף/לבטל את הישן לאחר cutover.
6. **GitHub/Cursor**: חיבור GitHub מנוהל ב-Cursor Dashboard → Integrations. הוא אינו תחליף ל-secret store של האפליקציה.

### שמות משתנים ש-Cursor צריך למפות ב-secret store

הרשימה נגזרת מ-`src/config.ts`; לא כל משתנה חייב להיות מוגדר בפועל. יש לקרוא את *השמות בלבד* מקונפיגורציית השירות הנוכחי וליצור mapping חדש:

| תחום | משתנים צפויים |
| --- | --- |
| Database | `DATABASE_URL`, `DB_POOL_MAX`, `DB_SCHEMA` |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PROMPT_ID`, `OPENAI_PROMPT_VERSION`, `OPENAI_REASONING_EFFORT`, `OPENAI_TIMEOUT_MS`, `OPENAI_TRACING` |
| WAHA | `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION`, `WAHA_WEBHOOK_HMAC_KEY`, `WAHA_TIMEOUT_MS`, `WAHA_MEDIA_ORIGINS` |
| Admin | `HAIM_ADMIN_TOKEN`, `HAIM_ADMIN_READONLY_TOKEN`, `HAIM_ADMIN_DESTRUCTIVE_TOKEN`, `HAIM_ALLOW_ADMIN_CLEAR_ALL`, `ADMIN_PHONE` |
| Media/voice | `MEDIA_ROOT`, `MEDIA_MAX_BYTES`, `MEDIA_TIMEOUT_MS`, `IVRIT_API_TOKEN`, `IVRIT_URL`, `IVRIT_TIMEOUT_MS`, `OPENAI_TRANSCRIBE_MODEL` |
| Runtime/safety | `NODE_ENV`, `PORT`, `BOT_MODE`, `AI_ENABLED`, `AGENT_MAX_TURNS`, `WORKER_CONCURRENCY`, `LIVE_ALLOWLIST`, `LIVE_DEPENDENCIES_VERIFIED`, `MEDIA_VOLUME_CONFIRMED`, `ENABLE_SIMULATE` |

### חובה לפני העברת סודות

- להוציא inventory של **שמות בלבד**, בלי `docker inspect` שמדפיס ערכים ללוג/טרמינל מצולם.
- להכניס כל ערך למערכת הסודות החדשה, לתת לו שם ורוטציה מתועדת.
- להחליף לפחות: `OPENAI_API_KEY`, admin tokens, `WAHA_WEBHOOK_HMAC_KEY`, סיסמת Postgres, וכל API key שסופק בעבר לצוות/כלי אחר.
- לוודא של-Cursor יש רק הרשאה לקרוא/להזריק סודות הנדרשים לסביבה, ולא permission לייצא אותם.
- לא לשתף את הערכים במסמך זה, בהודעת Cursor, issue, PR או screenshot.

## 8. תוכנית מעבר מומלצת לשרת חדש

### שלב א — Inventory והחלטות (ללא שינוי)

1. לבחור שרת יעד, אזור, גיבוי, מערכת הפעלה, כתובות IP ו-owner של DNS.
2. לאשר אילו שירותים עוברים: HAIM בלבד או גם Facebook Intel, Node-RED ו-EasyPanel.
3. להחליט: Docker Swarm + EasyPanel מחדש, או Docker Compose/פלטפורמה אחרת. אין לערבב בלי מסמך target architecture.
4. להוציא manifest של images, services, volumes, networks, domains ומשתני סביבה בשמות בלבד.
5. לצלם baseline קריא: migrations, DB row counts, media manifest, health, WAHA session status. לא לבצע send.

### שלב ב — הקמת יעד מבודד

1. להקשיח גישה: משתמש deploy ייעודי, SSH key חדש, firewall, עדכוני מערכת וגיבוי מוצפן.
2. להתקין Docker וה-control plane שנבחר; ליצור networks ונפחים בשם מתועד.
3. ליצור secret store ולהזין ערכים חדשים/מסובבים מחוץ למאגר.
4. למשוך/לבנות image מה-SHA המאומת של `qa-build`; אין להשתמש ב-`latest` בלתי מתועד.
5. להעלות PostgreSQL, להריץ migration באופן מבוקר ולהשוות checksums לפני טעינת נתונים.

### שלב ג — גיבוי ושחזור מאומתים

1. ליצור dump עקבי ל-HAIM DB ול-Facebook Intel DB אם השירות עובר.
2. ליצור archive של המדיה עם manifest (שם, גודל, SHA-256, `storage_key`).
3. ליצור backup מוגן ל-Node-RED; לסשן WAHA להעדיף re-auth ולא restore רגיל.
4. לשחזר תחילה אל סביבת יעד לא ציבורית.
5. לבדוק: migrations, foreign keys, row counts, outbox/jobs, media checksum וכן שהקובץ קיים בנתיב שמצביע אליו `storage_key`.

### שלב ד — אימות ללא cutover

1. להריץ `/health` ו-`/ready`.
2. לוודא DB schema נכון (live דורש `haim_core`), media volume מחובר ומוגדר, ו-workers עולים.
3. לבדוק webhook path/חתימה באופן שאינו שולח הודעה אמיתית.
4. לבצע WAHA QR login רק כשהחלטת cutover מאפשרת זאת; לא לשלוח WhatsApp אמיתי בלי אישור מפורש.
5. לבדוק admin UI עם token חדש דרך channel פרטי ולא לתעד אותו בדפדפן/צ׳אט.

### שלב ה — Cutover ו-rollback

1. לקבוע חלון שינוי והקפאת כתיבה/ingress או תוכנית deduplication ברורה.
2. להכין DNS/TLS/Traefik ו-webhook target חדש מראש.
3. להעביר תעבורה פעם אחת, לנטר health/ready, DB, outbox ו-provider receipts.
4. להשאיר את השרת הישן ללא כתיבה או זמין ל-rollback במשך חלון מוגדר.
5. אם יש כשל: להחזיר DNS/webhook לישן, לא לשחזר dump שני מעל נתונים חדשים בלי reconciliation.
6. רק לאחר חלון יציבות: לבטל מפתחות/סשנים ישנים, למחוק snapshots לפי מדיניות ולתעד final state.

## 9. דגשים ספציפיים ל-HAIM

- מצב `shadow` אינו שולח outbox לספק; `live` דורש `DB_SCHEMA=haim_core`, allowlist, תלות WAHA, media volume וגדרות release נוספות.
- release gate דורש אישור מפורש. הקוד וה-health הירוק אינם הוכחת readiness ל-WAHA או ל-OpenAI.
- זהויות בדיקה מורשות שהוגדרו ל-QA: `0584152101`, `0536662043`, `0543414386`. אין להשתמש במספרים אחרים ללא החלטת בעלים מפורשת.
- בוצע בעבר reset של נתוני QA בלבד. אין להתייחס למצב DB נקי כהוכחת שיחות חיות שבוצעו.
- `HAIM_ALLOW_ADMIN_CLEAR_ALL=true` קיים על השירות הנוכחי בעקבות החלטת בעלים. גם במצב זה token + same-origin + אישור טקסטואלי נדרשים. לפני מעבר צריך להחליט אם לשמר את הדגל; לא להסיר אימות לחלוטין.

## 10. העברה ל-Cursor: דרך עבודה מומלצת

1. לפתוח Cursor Desktop במחשב עם גישה מקומית לתיקייה, לא Cloud Agent ללא machine מחובר.
2. לשכפל/לעדכן את HAIM:

```powershell
git clone --branch qa-build https://github.com/zolo0548152101-afk/ZOLO.git C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION
# אם כבר קיים checkout:
git -C C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION fetch origin
git -C C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION checkout qa-build
git -C C:\פרוייקטים\HAIM_YAHAD_BOT_CORE_V5_FOUNDATION pull --ff-only origin qa-build
```

3. למסור ל-Cursor את `docs/CURSOR_HANDOFF_PROMPT_HE.md`, ואז מסמך זה.
4. לתת ל-Cursor גישה למאגר GitHub ול-secret store החדש בלבד לפי least privilege. אין צורך בגישת Windows בלתי מוגבלת או במפתח SSH הישן.
5. להעביר את פרויקט `KNEYOT` למאגר נפרד לפני שמבצעים עבודה רבה עליו. זה מונע ערבוב בין HAIM לקניות.
6. לאפשר ל-Cursor לעבוד על תשתית רק לאחר שהוא מציג תוכנית migration, manifest, backup/restore drill ו-rollback plan.

## 11. החלטות שהבעלים צריך לקבל לפני מעבר בפועל

1. כתובת/ספק/אזור של השרת החדש ומי מורשה לנהל אותו.
2. האם עוברים גם Facebook Intel, Node-RED ו-EasyPanel או רק HAIM.
3. domain(s) ו-DNS records שיועברו, ומי מחזיק בגישה ל-DNS.
4. האם לבצע WAHA re-auth חדש (מומלץ) או להעביר session volume; האפשרות השנייה רגישה ושבירה יותר.
5. מדיניות גיבוי ושמירת data, במיוחד האם נתוני HAIM הישנים הם disposable QA או נדרשים לשימור.
6. חלון cutover, owner לבדיקת rollback, ומתי מסובבים/מבטלים credentials ישנים.

## 12. בדיקות מסירה סופיות

- [ ] מקור הקוד ב-GitHub נגיש ו-`qa-build` מסונכרן ל-SHA שאושר.
- [ ] כל secret נמצא ב-secret store חדש בלבד, עם owner ורוטציה.
- [ ] restore drill עבר על DB ומדיה בסביבת יעד לא ציבורית.
- [ ] WAHA מוגדר לפי החלטה מתועדת; אין session/token ב-Git.
- [ ] health/ready, migrations, DB checksums ו-media manifest עברו ביעד.
- [ ] DNS/webhook/SSL ו-rollback נבדקו בלי לשלוח הודעה אמיתית.
- [ ] לאחר cutover: ניטור outbox, jobs, provider receipts ושגיאות; השרת הישן נשמר עד סוף חלון החזרה.
