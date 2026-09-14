# ניתוח פערי אמינות

## דירוג כללי

הליבה החדשה חזקה מהישנה ב־inbox, transactions, idempotency ו־outbox, אך עדיין אינה מוכנה ל־live ללא סגירת פערי recovery, delivery truth ו־turn ordering. מצב מומלץ: **shadow בלבד**.

| ציר | מצב | ממצא |
|---|---|---|
| קליטה כפולה | `PRESENT` | unique על `(channel,session,external_id)` ו־Docker integration עבר |
| אפקט עסקי כפול | `PRESENT` | `command_results` + transaction; Docker integration עבר |
| שליחה כפולה | `PARTIAL` | dedupe_key ו־uncertain safety טובים; אין receipt reconciliation |
| סדר הודעות | `PRESENT_NOT_VERIFIED` | durable turns, quiet-window coalescing ו־supersession נבדקו; multimodal stress עדיין חסר |
| concurrency | `PRESENT_NOT_VERIFIED` | row locks/versioning; stress/concurrency native עדיין לא הורץ |
| crash recovery | `PRESENT_NOT_VERIFIED` | startup recovery כולל גם `contact_id IS NULL`; live restart drill עדיין לא הורץ |
| queue failure | `PARTIAL` | enqueue באותה transaction; head במצב failed/uncertain חוסם את כל ההודעות המאוחרות |
| provider ambiguity | `DIFFERENT_BUT_BETTER` | timeout/5xx לא נשלח שוב בעיוורון |
| delivery truth | `PRESENT_NOT_VERIFIED` | receipt states ו־monotonic admin projection קיימים; reconciliation מול WAHA לא הורץ |
| AI failure | `PARTIAL` | retry/fallback/human; אין circuit breaker או budget controls |
| DB migration | `PARTIAL` | checksums/idempotency קיימים; runtime דורש רק 5 migrations ומבצע DDL אד־הוק |
| readiness | `PARTIAL` | DB/storage/heartbeat; לא WAHA/OpenAI; Docker בודק `/health` |
| media durability | `PARTIAL` | checksum ו־volume; אין backup/restore/retention proof |
| integrations | `PRESENT_NOT_VERIFIED` | dispatcher idempotent קיים; adapter חיצוני ו־dead-letter/replay עדיין דורשים יעד מאושר |

## כשלים קריטיים

### R1 — אמת שגויה על אימות

סירוב לפנות לצד השני יכול להציב `verification_contacted=true`; `statusText` מציג “נשלחה פנייה”. יש להחליף boolean ב־state machine ולגזור טקסט רק ממצב outbox/receipt מוכח.

### R2 — פעולה שה־AI ביקש אינה מתבצעת

חוזה ה־Plan מאפשר פעולות כגון verification/interest, אך translator אינו מכסה כל action. המערכת עלולה להציג managed reply שמצהיר על פעולה בעוד שלא נוצר side effect תואם. כל reply עם claim תפעולי חייב להיווצר מ־Outcome לאחר commit, לא ישירות מה־AI.

### R3 — הודעה חדשה בזמן AI

הגרסה הנשמרת מגינה מפני שינוי Request, לא מפני turn חדש ללא שינוי Request. תשובה להודעה הראשונה עשויה לצאת אף שהגיעה הודעה שנייה שמשנה את המשמעות. נדרש durable turn/batch id ובדיקת superseded לפני commit.

### R4 — recovery חלקי

Runtime משחזר `messages` לא מעובדות רק דרך JOIN ל־contacts. הודעה שנקלטה ונפלה לפני identity association אינה משוחזרת לשלב ingest. נדרש recovery נפרד ל־contact_id IS NULL.

### R5 — חסימת FIFO

המדיניות שומרת סדר, אך `failed` ו־`uncertain` נשארים blockers. זו בחירה בטוחה מול כפילות, אבל מחייבת alert, SLA ו־resolve מבוקר. אחרת שיחה שלמה נראית “תקועה”.

### R6 — רשת בתוך transaction (טופל)

`managedNotice` כבר אינו קורא ל־OpenAI בתוך transaction שמחזיקה locks עסקיים: facts/outbox נכתבים ב־transaction, והניסוח מתבצע post-commit עם `format_state=pending` ו־fallback. עדיין נדרש remote prompt E2E כדי לאמת את ספק ה־AI בפועל.

## יעד אמינות

- אין claim “נשלח/תואם” בלי event תפעולי מתאים.
- כל webhook accepted מתקדם או מופיע ב־dead-letter נראה לעין בתוך SLA.
- crash בכל נקודה ניתן להפעלה חוזרת ללא כפילות עסקית.
- ארבעה תרחישים מלאים רצופים ב־shadow, ואז canary allowlist, עם trace מלא.
- live נשאר allowlist סגור עד שה־delivery reconciliation וה־E2E עוברים.
