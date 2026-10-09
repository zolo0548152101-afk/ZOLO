# מפת נתונים

מסמך זה נוצר מ-src/domain/field-map.ts. אין לערוך אותו ידנית.

## מה נשמר ואיפה

כל עובדה שהלקוח מוסר חייבת לרדת לפקודה שכותבת את העמודה המתאימה. אין next כשאפשר לשמור. אין details על חיפוש, ואין seek על פנייה.

### requests
- number (מספר פנייה) ← system
- status (סטטוס פנייה) ← system
- origin (סוג פנייה (מסירה כללית או ישירה)) ← פקודה donate.direct
- run_date (תאריך הובלה מתואם) ← system
- earliest_run_date (תאריך מוקדם ביותר אחרי ביטול) ← פקודה cancel.choice
- human_reason (סיבת טיפול אנושי) ← פקודה escalate.reason
- verification_contacted (האם פנינו לצד השני) ← פקודה contact_counterparty.contact
- preferred_time (שעת העדפה) ← פקודה details.preferred_time
- represents_both_parties (מייצג את שני הצדדים) ← פקודה donate.counterparty_phone
- closed_at (מועד סגירה) ← פקודה cancel
- proposed_run_date (מועד הובלה מוצע) ← system

### request_parties
- role (תפקיד (מוסר/מקבל)) ← פקודה donate.type
- name (שם) ← פקודה details.name
- settlement (יישוב) ← פקודה details.settlement
- address (כתובת או רחוב) ← פקודה details.address
- floor (קומה) ← פקודה details.floor
- floor_note_shown (האם הוצגה הערת קומה) ← system
- approved_at (אישור החלק בפנייה) ← פקודה approve_self
- approved_by (מי אישר את החלק) ← פקודה approve_self
- schedule_approved (האם אושר המועד) ← פקודה approve_schedule
- schedule_approved_date (תאריך מועד שאושר) ← פקודה approve_schedule.date
- schedule_approved_at (מתי אושר המועד) ← פקודה approve_schedule

### request_items
- kind (סוג פריט) ← פקודה donate.items
- description (תיאור פריט) ← פקודה donate.items
- quantity (כמות) ← פקודה donate.items
- free (נמסר בחינם) ← פקודה item_facts.free
- working (תקין ושמיש) ← פקודה item_facts.working
- needs_disassembly (נדרש פירוק) ← פקודה item_facts.needs_disassembly
- wardrobe_small_whole (ארון קטן ושלם) ← פקודה item_facts.wardrobe_small_whole
- oven_type (סוג תנור) ← פקודה item_facts.oven_type
- evacuation (פינוי רהיט) ← פקודה item_facts.evacuation

### request_media
- media_id (תמונת פריט) ← engine

### request_locations
- role (צד שנקודת המיקום שייכת לו) ← engine
- latitude (קו רוחב) ← engine
- longitude (קו אורך) ← engine

### request_verifications
- role (צד באימות) ← פקודה contact_counterparty
- state (מצב אימות) ← פקודה contact_counterparty.contact
- consented_at (מועד הסכמה לפנייה) ← פקודה contact_counterparty.contact
- last_error (שגיאת אימות) ← system

### searches
- kind (סוג פריט שמחפשים) ← פקודה seek.kind
- state (מצב חיפוש) ← פקודה seek
- settlement (יישוב מועדף למבקש) ← פקודה seek.settlement
- address (כתובת מועדפת למבקש) ← פקודה seek.address
- floor (קומה מועדפת למבקש) ← פקודה seek.floor
- name (שם המבקש) ← פקודה seek.name

### matches
- state (מצב התאמה) ← פקודה interest.request_number

### conversations
- mode (מצב שיחה (בוט/אנושי)) ← engine
- selected_request_id (פנייה נבחרת בשיחה) ← פקודה select.request_number
- pending_counterparty_name (שם צד ממתין לקישור) ← פקודה counterparty_candidate.name
- pending_counterparty_phone (טלפון צד ממתין לקישור) ← פקודה counterparty_candidate.phone

### outbox
- phone (נמען הודעה יוצאת) ← read_only
- text (טקסט הודעה יוצאת) ← read_only
- state (מצב שליחה) ← read_only
- format_state (מצב ניסוח) ← read_only
- delivery_state (מצב מסירה לספק) ← read_only
## מה מותר לומר

אמר "נשמר" / "רשמתי" / "שמרתי" / "עדכנתי" רק לשדה שמופיע ב-changed_fields של התור הזה. אם changed_fields ריק, אין פועל שמירה. שדה חסר: שאל או אשר בלי פועל שמירה.

- requests.number: נפתחה פנייה במספר זה
- requests.status: הסטטוס במסד הוא הערך שנקרא
- requests.run_date: ההובלה נקבעה לתאריך זה
- requests.verification_contacted: פנינו לצד השני; חסר: עדיין לא פנינו
- requests.preferred_time: נשמרה שעת ההעדפה; חסר: אין שעת העדפה שמורה
- requests.proposed_run_date: הוצע מועד הובלה; חסר: עדיין אין מועד מוצע
- request_parties.name: נשמר השם; חסר: חסר שם
- request_parties.settlement: נשמר היישוב; חסר: חסר יישוב
- request_parties.address: נשמרה הכתובת; חסר: חסרה כתובת
- request_parties.floor: נשמרה הקומה; חסר: אין קומה שמורה
- request_parties.approved_at: החלק בפנייה אושר; חסר: חסר אישור החלק
- request_parties.schedule_approved: המועד אושר; חסר: המועד טרם אושר
- request_parties.schedule_approved_date: אושר המועד לתאריך זה
- request_items.kind: נשמר סוג הפריט
- request_items.description: נשמר תיאור הפריט
- request_items.free: נרשם שהפריט בחינם; חסר: לא ידוע אם הפריט בחינם
- request_items.working: נרשמה תקינות הפריט; חסר: חסרה שאלת תקינות
- request_items.needs_disassembly: נרשם אם נדרש פירוק
- request_items.wardrobe_small_whole: נרשם שהארון קטן ושלם
- request_items.oven_type: נרשם סוג התנור
- request_media.media_id: התמונה התקבלה; חסר: אין תמונה שמורה
- request_locations.latitude: נקודת המיקום התקבלה
- request_locations.longitude: נקודת המיקום התקבלה
- request_verifications.state: מצב האימות במסד הוא הערך שנקרא
- request_verifications.consented_at: ניתנה הסכמה לפנייה לצד השני
- searches.kind: נרשם החיפוש; חסר: אין חיפוש פעיל
- searches.settlement: נשמר היישוב לחיפוש; חסר: אין יישוב שמור לחיפוש
- searches.address: נשמרה הכתובת לחיפוש; חסר: אין כתובת שמורה לחיפוש
- searches.floor: נשמרה הקומה לחיפוש; חסר: אין קומה שמורה לחיפוש
- searches.name: נשמר השם בחיפוש; חסר: אין שם שמור בחיפוש
- matches.state: נרשמה התעניינות בפריט
- conversations.pending_counterparty_name: נרשם שם הצד השני
- conversations.pending_counterparty_phone: נרשם מספר הצד השני
- outbox.state: ההודעה במצב שנקרא מהמסד; pending אינו נשלח
- outbox.delivery_state: המסירה במצב שנקרא מהמסד; אל תאמר נשלח על סמך תור
