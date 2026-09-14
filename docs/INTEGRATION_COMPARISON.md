# השוואת אינטגרציות

| אינטגרציה | Legacy | חדש | סטטוס | סיכון |
|---|---|---|---|---|
| WAHA inbound | webhook + filters + LID | HMAC raw-body + schema + LID | `DIFFERENT_BUT_BETTER` | נדרש E2E מול גרסת WAHA בפועל |
| WAHA outbound | שליחה ישירה | durable outbox + ambiguity policy + receipt projection | `DIFFERENT_BUT_BETTER` | contract/E2E מול WAHA בפועל עדיין לא הורץ |
| OpenAI Responses | managed prompt ID ללא version pinned | prompt ID+version, schema, metadata | `DIFFERENT_BUT_BETTER` | remote prompt paid-eval לא הורץ; ניסוח הודעות מערכת עובר post-commit formatter |
| Google Sheets | מקור אמת דרך Apps Script | אין adapter | `DIFFERENT_BUT_BETTER` כמקור אמת, `MISSING` לצורכי export | אין migration/דו־קיום/דוח reconciliation |
| Apps Script | CRUD, matching, capacity | הוחלף ב־Store/commands | `DIFFERENT_BUT_BETTER` | יש לוודא parity לפני cutover |
| data.gov.il | רחובות/יישובים עם cache | אין | `MISSING` | פוגע בכתובות בית שאן ובתיקון שגיאות |
| IVRIT | route פעיל | adapter עם fallback | `PRESENT_NOT_VERIFIED` | secrets/provider/network לא נבדקו |
| אחסון מדיה | `/data` + ref בגיליון | volume, checksum, MIME/size/SSRF guards | `DIFFERENT_BUT_BETTER` | חסרים backup, retention ו־retrieval user flow |
| Waze/location | normalize והחזרת קישור | נקודה נשמרת + projection לקישור מפה לפי תפקיד | `PRESENT_NOT_VERIFIED` | נדרש E2E עם מיקום חי ו־UI ניהול |
| אינטגרציות עתידיות | branches ייעודיים | `integrations` + `integration_outbox` + dispatcher idempotent | `PRESENT_NOT_VERIFIED` | adapter חיצוני, retries/dead-letter ו־replay עדיין דורשים יעד מאושר |

## חוזי אינטגרציה מומלצים

1. WAHA: adapter versioned, contract tests ל־webhook/send/media/receipt, ומיפוי מפורש accepted/delivered/read/failed.
2. OpenAI: eval קבוע ל־prompt ID+version; release gate שמוודא שהגרסה המרוחקת זמינה ומחזירה schema תקין.
3. Locations: snapshot versioned של רחובות ויישובים, לא fetch אקראי בכל הודעה; fallback אנושי כאשר confidence נמוך.
4. Media: API מאושר להורדה/forward לפי request+role, retention ו־backup test.
5. Integrations: consumer idempotent ל־integration_outbox עם retries, dead-letter ו־replay מבוקר.
6. Sheets: importer חד־כיווני וכלי reconciliation בלבד בתקופת מעבר; אין להחזירו כמקור אמת מקביל.
