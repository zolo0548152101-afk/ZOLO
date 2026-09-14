# המלצת ארכיטקטורה

## החלטה

לבצע **controlled refactor על בסיס המערכת החדשה**. לא לבצע rewrite נוסף, לא להחזיר Google Sheets כמקור אמת ולא להוסיף עוד שכבת workflow לפני שהליבה עקבית.

## ארכיטקטורת יעד

```text
Ingress -> Durable Inbox -> Durable Turn Aggregator
        -> Interpreter (rules + AI extraction)
        -> Domain State Machine
        -> Outcome + Message Intents + Events
        -> Formatter (managed prompt, no actions)
        -> Transactional Outbox
        -> WAHA adapter + delivery reconciliation
```

### 1. Durable Turn Aggregator

ישות `conversation_turns` מאגדת הודעות לפי quiet window, כולל text/contact/location/media. לכל turn יש generation/version. worker מסיים turn רק אם לא נוספה הודעה; אחרת הוא ממתין. תשובה מיושנת אינה נכנסת ל־outbox.

### 2. Interpreter

rules מטפלים בדברים חד־משמעיים בלבד: greeting, admin commands, מספר פנייה מפורש, yes/no בהקשר typed. AI מחלץ candidates. normalization מחבר רחובות, יישובים וטלפונים. אין כתיבה עסקית בשלב זה.

### 3. Domain State Machine

יש states מפורשים ל־request lifecycle, verification, matching, scheduling ו־cancellation. כל transition כולל actor authorization, preconditions ו־events. `nextQuestion` נגזר מ־missing requirements לפי origin/role.

### 4. Message Intent Formatter

ה־domain מחזיר intent כגון `offer_verification`, `ask_pickup_address`, `verification_queued`. הפרומפט מנסח אותו לפי V48, אך validator מונע שינוי עובדות ו־claims. fallback templates נשארים בטוחים וקצרים.

### 5. Outbox ו־Receipts

outbox נוצר atomically. sender שומר provider message id. webhooks מעדכנים accepted/delivered/read/failed. status מציג רק אמת מוכחת. uncertain דורש reconciliation או החלטת מנהל.

## החלטות לפי 30 צירי הביקורת

| ציר | החלטה |
|---|---|
| structure | לשמר layered TypeScript ולפצל Engine |
| features | להשלים parity לפי מטריצה, לא לפי מסכים |
| behavior | state machine ו־golden conversational specs |
| state | durable turns + explicit substates |
| data | PostgreSQL יחיד; importer ל־Sheets |
| selection | request number/selected/explicit ambiguity בלבד |
| integrations | adapters versioned + dispatcher |
| AI boundary | extraction+formatting בלבד |
| reliability | inbox/outbox + receipts + recovery |
| idempotency | keys לכל command/notice/provider send |
| concurrency | locks לפי request/run/conversation |
| ordering | turn generation + recipient FIFO |
| media | durable object+checksum+authorized retrieval |
| location | dataset versioned + geo/Waze projection |
| identity | contact identities וללא LID כטלפון |
| admin | application commands/RBAC; לא generic SQL |
| observability | metrics, traces, alerts, runbooks |
| testability | ports, fixtures, deterministic clock |
| security | long tokens, secret rotation, rate limits, redaction |
| deploy | shadow -> canary allowlist -> staged live |
| performance | AI מחוץ ל־DB locks; cache location dataset |
| cost | bypass AI אמיתי למסלולים בטוחים; token budgets |
| maintainability | generated action exhaustiveness + smaller services |
| extensibility | event consumers idempotent |
| data ownership | domain/PostgreSQL, לא prompt/Sheet |
| failure ownership | כל adapter מפרסם state+retry policy |
| UX | שאלה אחת קצרה, no duplicate, truthful claims |
| side effects | outbox בלבד |
| migration | import+reconcile+freeze/cutover |
| rollback | schema/image/version rollback עם webhook switch |

## תנאי יציאה ל־live

- כל probe הופך regression ירוק.
- כל integration test עובר על PostgreSQL 17 ו־pg-boss אמיתיים.
- prompt remote eval עובר על גרסה pinned.
- ארבעה E2E מלאים רצופים ב־shadow ואחריהם canary למספרים מורשים בלבד.
- backup+restore נבדקו.
- אין state שמצהיר “נשלח” בלי outbox/receipt.

