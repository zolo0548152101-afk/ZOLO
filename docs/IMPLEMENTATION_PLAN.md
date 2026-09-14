# תוכנית יישום תלוית־תלויות

## כללי ביצוע

- אין שינוי production, webhook או allowlist כחלק מהתוכנית עד שערי ה־release.
- כל משימה מסתיימת בבדיקה אוטומטית ובתיעוד evidence.
- PostgreSQL נשאר מקור האמת. prompt אינו כותב state ואינו מדווח side effect.
- סדר עדיפויות: אמת תפעולית ואמינות לפני שיפור ניסוח.

## שלב 0 — נעילת המפרט והראיות

### T01 — מפרט שיחה קנוני

- **מטרה:** להפוך את כללי V48 וההחלטות האחרונות לטבלת תרחישים מחייבת.
- **תלויות:** אין.
- **קבצים/מודולים:** `docs/`, fixture חדש תחת `tests/spec/`.
- **DB:** אין.
- **שינוי התנהגות:** אין; audit בלבד.
- **בדיקות:** validator שכל scenario מכיל origin, actor, input, state-before, expected-actions, expected-message-intent.
- **קבלה:** אין סתירה בין PHOTO-FIRST למסירה פתוחה לבין תמונה אופציונלית בהעברה ישירה; מוכרעת שאלת פירוק במיטה ישירה.
- **rollout:** merge docs+fixtures בלבד.
- **rollback:** revert commit.
- **סיכון:** בינוני — מפרט שגוי יקבע התנהגות שגויה.

### T02 — להפוך את 12 probes ל־regression tests

- **מטרה:** לקבע את כל הבאגים ששוחזרו offline.
- **תלויות:** T01.
- **קבצים/מודולים:** `tests/unit.test.ts`, `tests/integration.test.ts`, `scripts/audit-offline-probes.mjs`.
- **DB:** אין שינוי schema.
- **שינוי התנהגות:** אין לפני התיקונים; בדיקות אדומות במ branch ייעודי.
- **בדיקות:** 12 הממצאים ב־`TEST_GAP_ANALYSIS.md`.
- **קבלה:** כל probe מיוצג בטסט בשם ברור; אין טסטים סותרים.
- **rollout:** test-only.
- **rollback:** revert test commit בלבד.
- **סיכון:** נמוך.

### T03 — סביבת integration שחוזרת על עצמה

- **מטרה:** להפעיל PostgreSQL 17 + pg-boss מקומית/CI באופן דטרמיניסטי.
- **תלויות:** T02.
- **קבצים/מודולים:** compose test, CI workflow, `TESTING.md`.
- **DB:** schema זמני לכל run.
- **שינוי התנהגות:** אין.
- **בדיקות:** `npm run test:integration`, migration twice, teardown.
- **קבלה:** כל הבדיקות עוברות פעמיים ברצף; אין תלות בנתוני production.
- **rollout:** CI required check.
- **rollback:** disable required check, לא לשנות production.
- **סיכון:** נמוך־בינוני.

## שלב 1 — אמת עסקית וחוזה פעולות

### T04 — exhaustiveness לחוזה AI→commands

- **מטרה:** כל action ב־schema מתורגם לפקודה או נדחה במפורש; אין silent `next`.
- **תלויות:** T01–T03.
- **קבצים/מודולים:** `domain/types.ts`, `application/rule-planner.ts`, `infrastructure/ai.ts`.
- **DB:** אין.
- **שינוי התנהגות:** verification, interest, self_move ו־notify מקבלים mapping ברור.
- **בדיקות:** compile-time exhaustive switch + table-driven לכל action.
- **קבלה:** הוספת action חדש שוברת build עד שממופה; P08/P10/P11 ירוקים.
- **rollout:** shadow בלבד.
- **rollback:** feature flag ל־translator החדש.
- **סיכון:** גבוה — עלול להפעיל side effects שלא הופעלו קודם.

### T05 — Outcome ו־Message Intent במקום reply חופשי

- **מטרה:** להפריד state changes, notices ו־wording.
- **תלויות:** T04.
- **קבצים/מודולים:** `application/commands.ts`, `application/engine.ts`, טיפוסים חדשים.
- **DB:** event payload version חדש.
- **שינוי התנהגות:** כל command מחזיר intent+facts; אין claim ישירות מה־AI.
- **בדיקות:** לכל outcome snapshot עובדתי; forbidden-claim validator.
- **קבלה:** אי אפשר להחזיר “שלחתי” בלי notice/outbox שנוצר.
- **rollout:** dual-log ישן/חדש ב־shadow והשוואה.
- **rollback:** חזרה ל־renderer הישן דרך flag.
- **סיכון:** גבוה.

### T06 — state machine לאימות צד שני

- **מטרה:** להחליף `verification_contacted` במצבים מפורשים.
- **תלויות:** T05.
- **קבצים/מודולים:** migrations, types, policies, commands, status/admin.
- **DB:** `verification_state` כגון `not_offered/offered/declined/consented/queued/provider_accepted/delivered/approved/failed/uncertain`, timestamps ו־outbox ref; backfill.
- **שינוי התנהגות:** סירוב אינו “נשלחה”; consent יוצר notice פעם אחת; אישור משויך לצד הנכון.
- **בדיקות:** transitions, authorization, idempotency, retry, P07/P12.
- **קבלה:** status נגזר מהמצב; Tal/כל צד מקבל הודעה רק אחרי consent מפורש.
- **rollout:** expand migration, dual-write, backfill, read-new, remove-old מאוחר יותר.
- **rollback:** read-old זמני; אין drop column באותו release.
- **סיכון:** גבוה.

### T07 — requirements לפי origin/role/item

- **מטרה:** מקור יחיד לשאלה הבאה ול־readiness.
- **תלויות:** T01, T05.
- **קבצים/מודולים:** `domain/policies.ts`, service חדש `requirements.ts`.
- **DB:** אין.
- **שינוי התנהגות:** direct לא דורש תמונה/תקינות; אם פירוק אינו נשאל הוא אינו חוסם; open donation PHOTO-FIRST.
- **בדיקות:** matrix לכל kind×origin×role; P01/P06.
- **קבלה:** אין מצב שבו `nextQuestion` מפסיק לשאול אך `readyToCoordinate` עדיין false מאותו שדה.
- **rollout:** shadow diff של requirement sets.
- **rollback:** flag למנוע requirements הישן.
- **סיכון:** גבוה.

### T08 — בחירת פנייה ופתיחה חוזרת

- **מטרה:** למנוע פתיחת duplicate ולשמור תמיכה אמיתית בכמה פניות.
- **תלויות:** T05, T07.
- **קבצים/מודולים:** planner, target selection, conversation service.
- **DB:** optional `conversation_turns.target_request_id`; אין שינוי request.
- **שינוי התנהגות:** מסירה חדשה מפורשת מבקשת אישור/הבחנה אם התוכן זהה לפנייה פתוחה; מספר פנייה גובר.
- **בדיקות:** repeated donation, multiple active, explicit request number; P04.
- **קבלה:** אין duplicate אוטומטי; אין בחירה שקטה בפנייה הלא נכונה.
- **rollout:** shadow, metric `duplicate_candidate`.
- **rollback:** disable duplicate guard.
- **סיכון:** בינוני.

## שלב 2 — תורים, batching ואמינות

### T09 — Durable multimodal turns

- **מטרה:** לאגד text, vCard, location, image ו־voice לפני תשובה אחת.
- **תלויות:** T03, T05.
- **קבצים/מודולים:** migrations, ingest, engine, queue.
- **DB:** `conversation_turns`, `turn_messages`, generation/status/deadline.
- **שינוי התנהגות:** quiet window נפתח מחדש עם הודעה נוספת; turn אחד מפיק response אחד.
- **בדיקות:** 2–3 texts, text+vCard, text+location, image during AI, restart mid-turn.
- **קבלה:** אין תשובה ביניים; כל ההודעות נראות ל־interpreter; no lost media.
- **rollout:** shadow dual aggregation.
- **rollback:** stop new worker וחזרה ל־message processing; טבלאות נשארות.
- **סיכון:** גבוה.

### T10 — supersession אחרי AI

- **מטרה:** למנוע commit של תשובה שהתיישנה עקב הודעה חדשה.
- **תלויות:** T09.
- **קבצים/מודולים:** engine/turn service.
- **DB:** compare turn generation/version under lock.
- **שינוי התנהגות:** response ישן נזרק וה־turn החדש מתוכנן מחדש.
- **בדיקות:** delayed fake AI + second message; crash/retry.
- **קבלה:** outbox מכיל רק תשובת generation האחרון.
- **rollout:** shadow metric `turn_superseded`.
- **rollback:** flag; אין data loss.
- **סיכון:** בינוני־גבוה.

### T11 — recovery מלא ל־inbox

- **מטרה:** לשחזר הודעות שנפלו לפני identity association.
- **תלויות:** T03.
- **קבצים/מודולים:** `application/runtime.ts`, queue/store.
- **DB:** index ל־messages pending ללא contact אם נדרש.
- **שינוי התנהגות:** startup משחזר ingest וגם conversation.
- **בדיקות:** crash בכל checkpoint, כולל contact_id null.
- **קבלה:** כל accepted message היא processed או dead-letter גלוי.
- **rollout:** shadow; cap/replay counters.
- **rollback:** disable recovery loop.
- **סיכון:** בינוני; replay חייב להיות idempotent.

### T12 — outbox receipts ופתרון FIFO

- **מטרה:** להבחין queued/accepted/delivered/read/failed/uncertain ולהפעיל unblock מבוקר.
- **תלויות:** T03, T06.
- **קבצים/מודולים:** WAHA adapter/webhook, store, admin, migrations.
- **DB:** provider_message_id, delivery_state/timestamps, resolution audit.
- **שינוי התנהגות:** status truthful; blocker alert; אין resend עיוור.
- **בדיקות:** duplicate receipts, out-of-order receipts, timeout reconciliation, manual resolve.
- **קבלה:** “נשלחה” רק אחרי provider acceptance; “נמסרה” רק אחרי receipt.
- **rollout:** collect receipts shadow, אחר כך read path.
- **rollback:** ignore receipt projection, preserve rows.
- **סיכון:** גבוה ותלוי יכולת WAHA.

### T13 — הוצאת AI מתוך transaction

- **מטרה:** למנוע locks בזמן network call.
- **תלויות:** T05, T09.
- **קבצים/מודולים:** engine, formatter worker, outbox.
- **DB:** optional `message_intents`/format state.
- **שינוי התנהגות:** facts committed, formatting idempotent, fallback deadline.
- **בדיקות:** OpenAI timeout בזמן concurrency; no duplicate notices.
- **קבלה:** אין await לרשת בתוך DB transaction עסקית.
- **rollout:** shadow timing comparison.
- **rollback:** template formatter בלבד.
- **סיכון:** בינוני־גבוה.

## שלב 3 — מיקום, מדיה ו־UX

### T14 — מאגר יישובים ורחובות versioned

- **מטרה:** תמיכה בכל רחובות בית שאן וב־aliases/שכונות.
- **תלויות:** T03.
- **קבצים/מודולים:** importer, normalization service, admin dataset status.
- **DB:** `location_datasets`, `streets`, aliases, normalized indexes.
- **שינוי התנהגות:** “שיכון א”, “רחוב העלייה” ונקודות ציון מתקבלים ככתובת בבית שאן.
- **בדיקות:** full dataset integrity, fuzzy typo, Tirat Zvi ambiguity, boundary/outside.
- **קבלה:** P02/P03 ירוקים; אין דרישת מספר בית.
- **rollout:** load snapshot, shadow compare, activate version.
- **rollback:** switch active dataset version.
- **סיכון:** בינוני; איכות מקור הנתונים.

### T15 — Location projection ו־Waze

- **מטרה:** לאפשר קבלת location חזרה ולשלבה בדוחות/תיאום.
- **תלויות:** T14.
- **קבצים/מודולים:** request loader, status, admin, formatter.
- **DB:** להוסיף metadata/label אם נדרש; `request_locations` נשאר מקור.
- **שינוי התנהגות:** status/admin מציג נקודה וקישור; authorization לפי party.
- **בדיקות:** donor/receiver location, replacement, retrieval, privacy.
- **קבלה:** נקודה שנשלחה ניתנת לצפייה/forward לאחר restart.
- **rollout:** read-only projection תחילה.
- **rollback:** hide projection.
- **סיכון:** בינוני/פרטיות.

### T16 — Media retrieval, backup ו־retention

- **מטרה:** להוכיח שתמונה נשמרת וניתנת להחזרה בבטחה.
- **תלויות:** T03.
- **קבצים/מודולים:** media storage, admin, backup scripts/runbook.
- **DB:** retention state/audit optional.
- **שינוי התנהגות:** forward/download מאושר בלבד; אין URL גולמי.
- **בדיקות:** store→restart→get→send fixture, missing object, restore backup.
- **קבלה:** checksum זהה מקצה לקצה; restore drill עבר.
- **rollout:** shadow media canary.
- **rollback:** disable retrieval endpoint.
- **סיכון:** גבוה/פרטיות ואחסון.

### T17 — סטטוס ופקודת מנהל

- **מטרה:** `#פניות`, `#פניות חיים יחד` ו־`#פניות לחיים יחד` מחזירים תמונת מצב אמינה.
- **תלויות:** T06, T12, T15.
- **קבצים/מודולים:** policies/engine/status projection.
- **DB:** view/query projection בלבד.
- **שינוי התנהגות:** כל הפניות וכל הפרטים, כולל verification truth, media/location links לפי הרשאה.
- **בדיקות:** כל phrasings כולל P05; כמה פניות; read-only proof.
- **קבלה:** command אינו משנה state ואינו עובר AI.
- **rollout:** shadow/admin allowlist.
- **rollback:** route הישן.
- **סיכון:** נמוך־בינוני.

## שלב 4 — ניהול, אינטגרציות ומעבר

### T18 — Admin בטוח במקום generic DB edit

- **מטרה:** CRUD עסקי דרך commands עם invariants ו־RBAC.
- **תלויות:** T05–T07.
- **קבצים/מודולים:** HTTP/admin services/UI.
- **DB:** admin users/roles/audit אם אין identity provider.
- **שינוי התנהגות:** עריכת party/item/status מפורשת; export לפני clear-all.
- **בדיקות:** authz, CSRF/rate, invalid transitions, destructive confirmation.
- **קבלה:** אין `UPDATE ${table}` generic לשדות עסקיים; clear-all test-only בלבד.
- **rollout:** read-only first, role gates.
- **rollback:** admin read-only.
- **סיכון:** גבוה.

### T19 — Integration outbox dispatcher

- **מטרה:** להפוך placeholder למסירה אמיתית ואידמפוטנטית.
- **תלויות:** T03, T05.
- **קבצים/מודולים:** worker/adapters/admin.
- **DB:** attempts, last_error, delivered_at, dedupe provider key.
- **שינוי התנהגות:** events נשלחים ליעדים enabled; failures נראים.
- **בדיקות:** retry/dead-letter/replay/order/schema version.
- **קבלה:** אין pending קבוע בלי alert; consumer duplicate-safe.
- **rollout:** adapter noop ואז יעד אחד shadow.
- **rollback:** disable integration row.
- **סיכון:** בינוני־גבוה.

### T20 — Import ו־reconciliation מ־Google Sheets

- **מטרה:** להעביר 28 עמודות בלי לאבד מידע.
- **תלויות:** T01, T03, T14–T16.
- **קבצים/מודולים:** importer חד־פעמי, mapping report.
- **DB:** staging tables + source row/hash.
- **שינוי התנהגות:** אין בשלב dry-run.
- **בדיקות:** fixture אנונימי, duplicates, multiple active, media/location refs, rerun.
- **קבלה:** ספירות ושדות מתיישבים; exceptions מופקות לדוח ולא נבלעות.
- **rollout:** dry-run→freeze window→final import→reconcile.
- **rollback:** delete by migration batch id או restore snapshot.
- **סיכון:** גבוה.

### T21 — Observability ו־SLO

- **מטרה:** לזהות “תקוע” בלי לפתוח WhatsApp ידנית.
- **תלויות:** T09, T12, T19.
- **קבצים/מודולים:** metrics/logger/admin/runbooks.
- **DB:** operational counters/views לפי צורך.
- **שינוי התנהגות:** alerts על inbox/outbox age, FIFO blockers, prompt failures.
- **בדיקות:** synthetic fault injection.
- **קבלה:** כל failure class במסמך reliability מייצר signal ו־runbook.
- **rollout:** observe-only.
- **rollback:** disable exporters/alerts.
- **סיכון:** נמוך.

### T22 — hardening ו־backup/restore

- **מטרה:** סודות, הרשאות, retention ושחזור.
- **תלויות:** T16, T18, T21.
- **קבצים/מודולים:** config/deploy/runbooks.
- **DB:** least-privilege roles, backup policy.
- **שינוי התנהגות:** admin token חזק, rate limits, log redaction.
- **בדיקות:** restore drill, secret rotation, access denial, media restore.
- **קבלה:** RPO/RTO מוסכמים ונבדקו; אין credentials בקוד/לוג.
- **rollout:** rotate one secret at a time.
- **rollback:** previous secret overlap window בלבד.
- **סיכון:** בינוני.

## שלב 5 — שערי release

### T23 — Prompt remote eval pinned

- **מטרה:** לוודא שה־prompt המרוחק שנבחר אכן זמין ומתאים לחוזה.
- **תלויות:** T01, T04, T05, T13.
- **קבצים/מודולים:** `scripts/ai-eval.mjs`, golden cases, release report.
- **DB:** שמירת eval run metadata בלבד.
- **שינוי התנהגות:** אין עד promotion.
- **בדיקות:** Hebrew variants, multi-message, no duplicate, no forbidden claims, notices.
- **קבלה:** threshold מוסכם ו־0 forbidden operational claims.
- **rollout:** pin version שנבדקה.
- **rollback:** pin לגרסה קודמת שעברה.
- **סיכון:** בינוני/עלות ושונות מודל.

### T24 — ארבעה E2E מלאים ב־shadow

- **מטרה:** להשלים ארבעה תיאומים ללא תקיעה וכפילות.
- **תלויות:** T02–T17, T21, T23.
- **קבצים/מודולים:** harness ודוח evidence.
- **DB:** נתוני test namespaced ומחיקה מבוקרת אחרי export.
- **שינוי התנהגות:** shadow בלבד, אין שליחה אמיתית.
- **בדיקות:** ארבעת התרחישים ב־TEST_GAP_ANALYSIS, כולל restart/failure אחד.
- **קבלה:** trace שלם לכל flow; שני הצדדים מאשרים; coordinated event; zero unexplained pending.
- **rollout:** shadow.
- **rollback:** reset test schema בלבד.
- **סיכון:** נמוך לפרודקשן.

### T25 — Canary allowlist ו־cutover מדורג

- **מטרה:** מעבר מבוקר למספרי בדיקה מאושרים בלבד.
- **תלויות:** כל הקודמות, במיוחד T12/T20/T22/T24.
- **קבצים/מודולים:** deploy config, checklist, rollback runbook.
- **DB:** snapshot לפני מעבר, migration batch tagged.
- **שינוי התנהגות:** live רק allowlist סגור; הרחבה ידנית לפי evidence.
- **בדיקות:** smoke inbound/outbound, verification delivery, status, rollback drill.
- **קבלה:** 4 canary flows רצופים, SLO ירוק, reconciliation אפס פערים.
- **rollout:** 1–2 מספרים→קבוצה קטנה→live, עם pause gates.
- **rollback:** החזרת webhook למערכת הישנה, עצירת send workers, שמירת inbox/outbox לבדיקה; אין מחיקת נתונים.
- **סיכון:** גבוה.

## סדר עשר המשימות הראשונות

T01 → T02 → T03 → T04 → T05 → T06/T07 → T08 → T09 → T10. T06 ו־T07 יכולות להתבצע במקביל לאחר T05; שאר השרשרת אינה צריכה לעקוף אותן כאשר היא נוגעת לאימות או readiness.

