-- haim-v6 functions. Idempotent (CREATE OR REPLACE). PostgreSQL 16+.
-- The agent calls the public functions. Invalid business writes raise inside
-- haim_apply_turn and are stored as rejected_update without committing the
-- rejected change.

CREATE OR REPLACE FUNCTION haim.fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = p_message;
END $$;

CREATE OR REPLACE FUNCTION haim.admin_phone() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT value #>> '{}' FROM haim.app_settings WHERE key = 'admin_phone'),
    '584152101'
  );
$$;

CREATE OR REPLACE FUNCTION haim.canon_phone(p_raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s text;
BEGIN
  IF p_raw IS NULL OR p_raw LIKE '%@lid%' THEN
    PERFORM haim.fail('invalid_phone', 'מספר הטלפון אינו תקין.');
  END IF;
  IF p_raw !~ '^[+0-9[:space:]().-]+(@c\.us|@s\.whatsapp\.net)?$' THEN
    PERFORM haim.fail('invalid_phone', 'מספר הטלפון אינו תקין.');
  END IF;
  s := regexp_replace(split_part(p_raw, '@', 1), '\D', '', 'g');
  IF s LIKE '00972%' THEN s := substr(s, 6);
  ELSIF s LIKE '972%' THEN s := substr(s, 4);
  END IF;
  IF left(s, 1) = '0' THEN s := substr(s, 2); END IF;
  IF s !~ '^[2-9][0-9]{7,8}$' THEN
    PERFORM haim.fail('invalid_phone', 'מספר הטלפון אינו תקין.');
  END IF;
  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION haim.write_log(
  p_level text,
  p_event text,
  p_phone text,
  p_conversation uuid,
  p_request uuid,
  p_waha text,
  p_details jsonb
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO haim.logs(level, event, phone, conversation_id, request_id, waha_message_id, details)
  VALUES (
    COALESCE(NULLIF(p_level, ''), 'info'),
    p_event,
    p_phone,
    p_conversation,
    p_request,
    p_waha,
    COALESCE(p_details, '{}'::jsonb)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.haim_log(
  p_level text,
  p_event text,
  p_phone text DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_conversation_id uuid DEFAULT NULL,
  p_request_id uuid DEFAULT NULL,
  p_waha_message_id text DEFAULT NULL
) RETURNS bigint
LANGUAGE sql AS $$
  SELECT haim.write_log(p_level, p_event, p_phone, p_conversation_id, p_request_id, p_waha_message_id, p_details);
$$;

CREATE OR REPLACE FUNCTION haim.explicit_approval(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_text, '') ~ '(?:^|[.!,;][[:space:]]*)(?:כן|מאשר|מאשרת|אני מאשר|אני מאשרת|מאושר|מסכים|מסכימה|אני[[:space:]]+[א-ת]{2,}[,[:space:]]+(?:מ|ומ)?אשר(?:ת)?)(?:[[:space:].,!]|$)';
$$;

CREATE OR REPLACE FUNCTION haim.bare_yes(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(COALESCE(p_text, '')) ~ '^כן(?:[.! ]|[[:space:]]+(?:תודה|בטח|ברור))*$';
$$;

CREATE OR REPLACE FUNCTION haim.next_tuesday(p_now timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(run_date date, same_day boolean)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  local_ts timestamp;
  d date;
  dow int;
  hour int;
  delta int;
BEGIN
  local_ts := timezone('Asia/Jerusalem', p_now);
  d := local_ts::date;
  dow := EXTRACT(DOW FROM d)::int;
  hour := EXTRACT(HOUR FROM local_ts)::int;
  delta := (2 - dow + 7) % 7;
  IF delta = 0 AND hour >= 20 THEN
    delta := 7;
  END IF;
  run_date := (d + delta)::date;
  same_day := delta = 0;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION haim.chat_for(p_phone text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT c.chat_id
       FROM haim.conversations c
       JOIN haim.contacts co ON co.id = c.contact_id
      WHERE co.phone = p_phone
      ORDER BY c.created_at
      LIMIT 1),
    '972' || p_phone || '@c.us'
  );
$$;

CREATE OR REPLACE FUNCTION haim.region_of(p_value text)
RETURNS TABLE(name text, decision text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s text;
  lookup text;
  bare text;
BEGIN
  s := btrim(regexp_replace(COALESCE(p_value, ''), '[[:space:]]+', ' ', 'g'));
  lookup := regexp_replace(s, '^(?:רחוב|שכונת|שכונה|שדרות|שד[''׳]?)[[:space:]]+', '');
  bare := regexp_replace(lookup, '[[:space:]]+[0-9]+[א-ת]?[[:space:]]*$', '');
  RETURN QUERY
  SELECT sl.name, sl.decision
    FROM haim.service_locations sl
   WHERE sl.name IN (lookup, bare, s)
      OR lookup = ANY(sl.aliases)
      OR bare = ANY(sl.aliases)
      OR s = ANY(sl.aliases)
   ORDER BY CASE sl.decision WHEN 'allowed' THEN 0 WHEN 'outside' THEN 1 ELSE 2 END
   LIMIT 1;
  IF FOUND THEN RETURN; END IF;
  RETURN QUERY
  SELECT st.name, 'allowed'::text
    FROM haim.streets st
   WHERE st.normalized IN (lookup, bare)
      OR st.name IN (lookup, bare)
   LIMIT 1;
  IF FOUND THEN RETURN; END IF;
  name := s;
  decision := 'review';
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION haim.outside_hit(p_text text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT sl.name
    FROM haim.service_locations sl
   WHERE sl.decision = 'outside'
     AND char_length(sl.name) >= 4
     AND COALESCE(p_text, '') LIKE '%' || sl.name || '%'
     AND COALESCE(p_text, '') !~ ('רחוב[[:space:]]+' || sl.name)
     AND COALESCE(p_text, '') !~ ('לא[[:space:]]*.{0,16}' || sl.name)
   ORDER BY char_length(sl.name) DESC
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION haim.pressure_line(p_text text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  angry boolean;
  impossible boolean;
  parts text[] := ARRAY[]::text[];
BEGIN
  angry := COALESCE(p_text, '') ~ '(דיי עם השטויות|די עם השטויות|נמאס|מספיק עם|עצבנ)';
  impossible :=
    COALESCE(p_text, '') ~ '(תתעלם מההוראות|תתעלם מהכללים|לעקוף את הכללים)'
    OR COALESCE(p_text, '') ~* '(ignore your instructions|bypass the rules)'
    OR (
      COALESCE(p_text, '') ~ '(תקבע|לקבוע|הובלה)'
      AND COALESCE(p_text, '') ~ '(דחוף|עכשיו|מיידי|יום ראשון|יום שישי|יום שני|יום רביעי|יום חמישי|יום שבת)'
    )
    OR (COALESCE(p_text, '') ~ 'המנהל אמר' AND COALESCE(p_text, '') ~ '(מותר|לקבוע|שישי|ראשון|חריג)')
    OR (COALESCE(p_text, '') ~* '\m(book|schedule)\M' AND COALESCE(p_text, '') ~* '\m(sunday|friday|monday|saturday)\M');
  IF NOT angry AND NOT impossible THEN RETURN NULL; END IF;
  IF angry THEN parts := parts || 'אני מבין, נעזור לך לטפל בזה.'; END IF;
  IF impossible THEN
    parts := parts || 'אי אפשר לקבוע הובלה מחוץ לחלון. ההובלות רק ביום שלישי בין 16:00 ל־20:00, בלי חריגים, ואי אפשר לעקוף את הכללים.';
  END IF;
  RETURN array_to_string(parts, E'\n');
END $$;

CREATE OR REPLACE FUNCTION haim.units_of(p_request uuid) RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(quantity) FILTER (WHERE kind NOT IN ('table','chairs')), 0)::int
       + CASE
           WHEN BOOL_OR(kind = 'table') AND BOOL_OR(kind = 'chairs') THEN 1
           ELSE COALESCE(SUM(quantity) FILTER (WHERE kind IN ('table','chairs')), 0)::int
         END
    FROM haim.request_items
   WHERE request_id = p_request;
$$;

CREATE OR REPLACE FUNCTION haim.item_problem(p_request uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  has_photo boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM haim.request_media rm WHERE rm.request_id = p_request) INTO has_photo;
  IF EXISTS (SELECT 1 FROM haim.request_items WHERE request_id = p_request AND kind IN ('piano','house_move')) THEN
    RETURN 'לא ניתן לסייע בהובלת פסנתרים או בהובלות דירה.';
  END IF;
  IF haim.units_of(p_request) > 2 THEN
    RETURN 'ניתן לסייע בהובלת עד שני פריטים. שולחן וכיסאות נחשבים פריט אחד.';
  END IF;
  IF EXISTS (SELECT 1 FROM haim.request_items WHERE request_id = p_request AND free IS FALSE) THEN
    RETURN 'התוכנית מסייעת במסירה בחינם בלבד.';
  END IF;
  IF EXISTS (SELECT 1 FROM haim.request_items WHERE request_id = p_request AND working IS FALSE) THEN
    RETURN 'ניתן למסור רק ציוד תקין ושמיש ב־100%.';
  END IF;
  IF has_photo AND EXISTS (
    SELECT 1 FROM haim.request_items
     WHERE request_id = p_request AND kind = 'wardrobe'
       AND (needs_disassembly IS TRUE OR wardrobe_small_whole IS FALSE)
  ) THEN
    RETURN 'אין אצלנו פירוק והרכבה של ארונות. אפשר להעביר רק ארון קטן שניתן להעביר שלם.';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION haim.photo_gate(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM haim.requests r
     WHERE r.id = p_request
       AND r.origin = 'donation'
       AND EXISTS (SELECT 1 FROM haim.request_parties p WHERE p.request_id = r.id AND p.role = 'donor')
       AND NOT EXISTS (SELECT 1 FROM haim.request_parties p WHERE p.request_id = r.id AND p.role = 'receiver')
       AND NOT EXISTS (SELECT 1 FROM haim.request_media m WHERE m.request_id = r.id)
  );
$$;

CREATE OR REPLACE FUNCTION haim.own_party(p_request uuid, p_phone text, p_role text DEFAULT NULL)
RETURNS haim.request_parties
LANGUAGE plpgsql STABLE AS $$
DECLARE
  row haim.request_parties;
BEGIN
  SELECT * INTO row
    FROM haim.request_parties
   WHERE request_id = p_request
     AND phone = p_phone
     AND (p_role IS NULL OR role = p_role)
   ORDER BY (name IS NULL OR settlement IS NULL OR address IS NULL) DESC, role
   LIMIT 1;
  IF NOT FOUND THEN
    PERFORM haim.fail('forbidden_party', 'אפשר לעדכן רק את הצד שלך בפנייה.');
  END IF;
  RETURN row;
END $$;

CREATE OR REPLACE FUNCTION haim.invalidate_schedule(p_request uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE haim.requests SET proposed_run_date = NULL, version = version + 1, updated_at = clock_timestamp()
   WHERE id = p_request;
  UPDATE haim.request_parties
     SET schedule_approved = false, schedule_approved_date = NULL, schedule_approved_at = NULL
   WHERE request_id = p_request;
$$;

CREATE OR REPLACE FUNCTION haim.ensure_contact(p_phone text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO haim.contacts(phone) VALUES (p_phone)
  ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION haim.mutable(p_request uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM haim.requests WHERE id = p_request FOR UPDATE;
  IF st IN ('coordinated','closed','cancelled','rejected','cancel_pending') THEN
    PERFORM haim.fail('request_protected', 'הפנייה מוגנת משינוי. לפנייה חדשה יש לציין שמדובר בבקשה חדשה; לשינוי התיאום נעביר לטיפול אנושי.');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION haim.status_text(p_request uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r haim.requests%ROWTYPE;
  d haim.request_parties%ROWTYPE;
  v haim.request_parties%ROWTYPE;
  items text;
  label text;
BEGIN
  SELECT * INTO r FROM haim.requests WHERE id = p_request;
  IF NOT FOUND THEN RETURN 'לא נמצאו פניות פעילות עבורך.'; END IF;
  SELECT * INTO d FROM haim.request_parties WHERE request_id = r.id AND role = 'donor';
  SELECT * INTO v FROM haim.request_parties WHERE request_id = r.id AND role = 'receiver';
  SELECT string_agg(description || CASE WHEN quantity > 1 THEN ' ×' || quantity ELSE '' END, ', ')
    INTO items FROM haim.request_items WHERE request_id = r.id;
  label := CASE r.status
    WHEN 'collecting' THEN 'בהשלמת פרטים'
    WHEN 'available' THEN 'ממתינה למקבל'
    WHEN 'awaiting_approval' THEN 'ממתינה לאישורים'
    WHEN 'waiting_capacity' THEN 'ממתינה למקום בהובלה'
    WHEN 'coordinated' THEN 'תואמה'
    WHEN 'closed' THEN 'הושלמה'
    WHEN 'cancelled' THEN 'בוטלה'
    WHEN 'rejected' THEN 'לא מתאימה'
    WHEN 'human' THEN 'בטיפול אנושי'
    WHEN 'cancel_pending' THEN 'ממתינה להחלטה לאחר ביטול'
    ELSE r.status END;
  RETURN format(E'פנייה %s\nפריט: %s\nמצב: %s\nמוסר: %s · %s\nאיסוף: %s, %s\nמקבל: %s · %s\nיעד: %s, %s\n%s\nחלון הובלה: 16:00–20:00 · בדרך כלל עד 10 הובלות; תוספת דורשת אישור מנהל%s',
    r.number,
    COALESCE(items, '—'),
    label,
    COALESCE(d.name, '—'), COALESCE(d.phone, '—'),
    COALESCE(d.settlement, '—'), COALESCE(d.address, '—'),
    COALESCE(v.name, '—'), COALESCE(v.phone, '—'),
    COALESCE(v.settlement, '—'), COALESCE(v.address, '—'),
    CASE
      WHEN r.run_date IS NOT NULL THEN 'תאריך הובלה שאושר: ' || r.run_date
      WHEN r.proposed_run_date IS NOT NULL THEN 'מועד מוצע — ממתין לאישור: ' || r.proposed_run_date
      ELSE 'תאריך הובלה: טרם נקבע'
    END,
    CASE WHEN r.status = 'coordinated' THEN E'\nביום ההובלה ניצור קשר טלפוני לפני ההגעה' ELSE '' END
  );
END $$;

CREATE OR REPLACE FUNCTION haim.next_question(p_request uuid, p_phone text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r haim.requests%ROWTYPE;
  p haim.request_parties%ROWTYPE;
  other_exists boolean;
  donor boolean;
  proposal date;
  other_phone text;
  other_ok boolean;
BEGIN
  SELECT * INTO r FROM haim.requests WHERE id = p_request;
  IF NOT FOUND THEN
    RETURN 'נא לציין אם ברצונך למסור פריט, לקבל פריט או לתאם הובלה.';
  END IF;
  IF r.status = 'coordinated' THEN RETURN haim.status_text(r.id); END IF;
  IF r.status IN ('closed','cancelled','rejected') THEN
    RETURN format('פנייה %s סגורה.', r.number);
  END IF;
  IF r.status = 'human' THEN
    RETURN 'העברתי את הפנייה לטיפול אנושי. נעדכן.';
  END IF;
  BEGIN
    p := haim.own_party(r.id, p_phone, NULL);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN 'אפשר לעדכן רק את הצד שלך בפנייה.';
  END;
  donor := p.role = 'donor';
  SELECT EXISTS (SELECT 1 FROM haim.request_parties x WHERE x.request_id = r.id AND x.role <> p.role)
    INTO other_exists;
  IF r.origin = 'direct' AND NOT r.represents_both_parties AND NOT r.verification_contacted AND other_exists THEN
    RETURN format('האם תרצה שנפנה ל%s לצורך אימות הפרטים?', CASE WHEN donor THEN 'מקבל' ELSE 'מוסר' END);
  END IF;
  IF r.origin = 'direct' AND NOT other_exists THEN
    RETURN format('האם תרצה שנפנה ל%s לצורך אימות הפרטים? אם כן, נא לשלוח מספר טלפון או כרטיס איש קשר.', CASE WHEN donor THEN 'מקבל' ELSE 'מוסר' END);
  END IF;
  IF donor AND EXISTS (
    SELECT 1 FROM haim.request_items i
     WHERE i.request_id = r.id AND i.kind = 'wardrobe' AND i.wardrobe_small_whole IS DISTINCT FROM TRUE
  ) THEN
    RETURN 'אפשר להעביר רק ארון קטן שניתן להעביר שלם, ללא פירוק והרכבה. האם זה ארון כזה?';
  END IF;
  IF donor AND EXISTS (SELECT 1 FROM haim.request_items i WHERE i.request_id = r.id AND i.working IS NULL) THEN
    RETURN 'האם הפריט תקין ושמיש ב־100%?';
  END IF;
  IF donor AND r.origin <> 'direct' AND EXISTS (
    SELECT 1 FROM haim.request_items i WHERE i.request_id = r.id AND i.kind = 'oven' AND i.oven_type IS NULL
  ) THEN
    RETURN 'האם זה תנור בילט־אין או תנור משולב?';
  END IF;
  IF donor AND r.origin <> 'direct' AND EXISTS (
    SELECT 1 FROM haim.request_items i
     WHERE i.request_id = r.id
       AND i.kind NOT IN ('fridge','oven','washing_machine','dryer','freezer','dishwasher','wardrobe')
       AND i.needs_disassembly IS NULL
  ) THEN
    RETURN 'האם נדרש פירוק של הפריט לצורך ההובלה?';
  END IF;
  IF p.approved_at IS NULL THEN
    RETURN format('נא לאשר את חלקך ב%s בפנייה %s. אישור חלקך נפרד מאישור מועד ההובלה.',
      CASE WHEN p.role = 'donor' THEN 'מסירה' ELSE 'קבלה' END, r.number);
  END IF;
  IF p.settlement IS NULL THEN
    RETURN CASE WHEN donor THEN 'באיזה יישוב נמצא הפריט?' ELSE 'לאיזה יישוב צריך להעביר את הפריט?' END;
  END IF;
  IF p.name IS NULL OR p.address IS NULL THEN
    IF p.settlement = 'בית שאן' THEN
      RETURN (CASE
        WHEN p.name IS NULL AND p.address IS NOT NULL THEN 'תודה. חסר רק השם.'
        WHEN p.name IS NULL THEN 'נא לציין שם וכתובת.'
        ELSE 'תודה. חסרה רק הכתובת המדויקת.' END)
        || CASE WHEN NOT p.floor_note_shown AND p.floor IS NULL THEN ' בבניין עם קומות — לציין קומה.' ELSE '' END;
    END IF;
    RETURN CASE WHEN p.name IS NULL
      THEN 'נא לציין שם ותיאור כללי של המקום ביישוב, למשל ״בכניסה״ או ״ליד המזכירות״.'
      ELSE 'תודה. חסר רק תיאור כללי של המקום ביישוב, למשל ״בכניסה״ או ״ליד המזכירות״.' END;
  END IF;
  IF NOT other_exists THEN
    RETURN CASE WHEN donor
      THEN 'האם יש מקבל מסוים? אם כן, נא לשלוח את מספרו או כרטיס איש קשר.'
      ELSE 'נא לשלוח את מספר המוסר או כרטיס איש קשר.' END;
  END IF;
  proposal := r.proposed_run_date;
  IF proposal IS NOT NULL AND p.schedule_approved_date IS DISTINCT FROM proposal THEN
    RETURN format('הוצע מועד ההובלה ליום שלישי %s, בין 16:00–20:00. נא לאשר את המועד במפורש.', to_char(proposal, 'DD/MM/YYYY'));
  END IF;
  SELECT x.phone, x.schedule_approved_date IS NOT DISTINCT FROM proposal
    INTO other_phone, other_ok
    FROM haim.request_parties x
   WHERE x.request_id = r.id AND x.phone <> p_phone
   LIMIT 1;
  IF proposal IS NOT NULL AND other_phone IS NOT NULL AND NOT COALESCE(other_ok, false) THEN
    RETURN format('אישרת את מועד ההובלה בפנייה %s. ממתינים לאישור המועד של הצד השני.', r.number);
  END IF;
  RETURN 'הפרטים נשמרו. נעדכן.';
END $$;

CREATE OR REPLACE FUNCTION haim.ready_to_propose(p_request uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r haim.requests%ROWTYPE;
  n int;
BEGIN
  SELECT * INTO r FROM haim.requests WHERE id = p_request;
  IF r.status NOT IN ('collecting','available','awaiting_approval','waiting_capacity') THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO n FROM haim.request_parties WHERE request_id = p_request;
  IF n <> 2 THEN RETURN false; END IF;
  IF r.origin = 'direct' AND NOT r.represents_both_parties AND NOT r.verification_contacted THEN
    RETURN false;
  END IF;
  IF haim.item_problem(p_request) IS NOT NULL THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM haim.request_parties p
     WHERE p.request_id = p_request
       AND (p.approved_at IS NULL OR p.approved_by_phone IS DISTINCT FROM p.phone OR p.name IS NULL OR p.settlement IS NULL OR p.address IS NULL)
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM haim.request_items i
     WHERE i.request_id = p_request
       AND (
         i.free IS DISTINCT FROM TRUE
         OR i.working IS DISTINCT FROM TRUE
         OR (i.kind = 'wardrobe' AND i.wardrobe_small_whole IS DISTINCT FROM TRUE)
         OR (i.kind = 'oven' AND i.oven_type IS NULL)
         OR (
           r.origin <> 'direct'
           AND i.kind NOT IN ('fridge','oven','washing_machine','dryer','freezer','dishwasher','wardrobe')
           AND i.needs_disassembly IS NULL
         )
         OR i.evacuation = 'different'
       )
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM haim.request_parties p
     WHERE p.request_id = p_request
       AND COALESCE((SELECT decision FROM haim.service_locations s WHERE s.name = p.settlement), 'review') <> 'allowed'
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION haim.ask_capacity(p_request uuid, p_date date, p_capacity int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_status text;
  v_inserted boolean := false;
  body text;
BEGIN
  IF p_capacity >= 100 THEN RETURN; END IF;
  INSERT INTO haim.transport_capacity_approvals(run_date, requested_capacity, request_id)
  VALUES (p_date, p_capacity + 1, p_request)
  ON CONFLICT (run_date, requested_capacity) DO NOTHING
  RETURNING id, status INTO v_id, v_status;
  IF v_id IS NOT NULL THEN
    v_inserted := true;
  ELSE
    SELECT id, status INTO v_id, v_status
      FROM haim.transport_capacity_approvals
     WHERE run_date = p_date AND requested_capacity = p_capacity + 1;
  END IF;
  IF v_inserted THEN
    body := format('הגענו ל־%s הובלות מאושרות ביום שלישי %s. האם לאשר הובלה נוספת אחת (מכסה %s)?%sהשב/י: כן %s או לא %s. עד לאישור, לא נציע ולא נתאם הובלות נוספות ליום זה.',
      p_capacity, to_char(p_date, 'DD/MM/YYYY'), p_capacity + 1, E'\n', p_date, p_date);
    INSERT INTO haim.deliveries(dedupe_key, request_id, phone, chat_id, body)
    VALUES ('capacity-approval:' || v_id::text, p_request, haim.admin_phone(), haim.chat_for(haim.admin_phone()), body)
    ON CONFLICT (dedupe_key) DO NOTHING;
    PERFORM haim.write_log('warn', 'escalation', haim.admin_phone(), NULL, p_request, NULL,
      jsonb_build_object('kind', 'capacity', 'date', p_date, 'requested', p_capacity + 1));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION haim.propose_date(p_request uuid) RETURNS date
LANGUAGE plpgsql AS $$
DECLARE
  r haim.requests%ROWTYPE;
  nxt record;
  d date;
  cap int;
  st text;
  used int;
  proposed_n int;
BEGIN
  SELECT * INTO r FROM haim.requests WHERE id = p_request FOR UPDATE;
  SELECT * INTO nxt FROM haim.next_tuesday();
  d := nxt.run_date;
  IF r.earliest_run_date IS NOT NULL AND r.earliest_run_date > d THEN
    d := r.earliest_run_date;
  END IF;
  d := d + ((2 - EXTRACT(ISODOW FROM d)::int + 7) % 7);
  INSERT INTO haim.transport_runs(run_date, capacity)
  VALUES (d, 10)
  ON CONFLICT (run_date) DO NOTHING;
  SELECT capacity, status INTO cap, st FROM haim.transport_runs WHERE run_date = d FOR UPDATE;
  SELECT count(*)::int INTO used FROM haim.requests WHERE run_date = d AND status IN ('coordinated','closed');
  IF st <> 'open' OR (d = nxt.run_date AND nxt.same_day) THEN
    RETURN NULL;
  END IF;
  SELECT count(*)::int INTO proposed_n
    FROM haim.requests
   WHERE proposed_run_date = d AND status = 'awaiting_approval' AND id <> p_request;
  IF used >= cap THEN
    PERFORM haim.ask_capacity(p_request, d, cap);
    RETURN NULL;
  END IF;
  IF used + proposed_n >= cap THEN
    RETURN NULL;
  END IF;
  RETURN d;
END $$;

CREATE OR REPLACE FUNCTION haim.sync_schedule(p_request uuid, p_phone text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r haim.requests%ROWTYPE;
  proposed date;
  nxt record;
  cap int;
  st text;
  used int;
  approval text;
  party_row record;
BEGIN
  SELECT * INTO r FROM haim.requests WHERE id = p_request FOR UPDATE;
  IF r.status IN ('coordinated','closed','cancelled','rejected','human','cancel_pending') THEN
    RETURN NULL;
  END IF;
  IF haim.ready_to_propose(p_request)
     AND (r.proposed_run_date IS NULL OR r.proposed_run_date < (SELECT run_date FROM haim.next_tuesday())) THEN
    proposed := haim.propose_date(p_request);
    IF proposed IS NULL THEN
      UPDATE haim.requests SET status = 'waiting_capacity', version = version + 1, updated_at = clock_timestamp()
       WHERE id = p_request;
      SELECT a.status INTO approval
        FROM haim.transport_capacity_approvals a
       WHERE a.request_id = p_request
       ORDER BY a.requested_at DESC LIMIT 1;
      IF approval = 'pending' THEN
        RETURN 'מכסת ההובלות ליום שלישי מלאה. שלחתי למנהל בקשה לאשר הובלה נוספת. הפנייה ממתינה, ולא ייקבע מועד נוסף עד לאישור מפורש.';
      ELSIF approval = 'denied' THEN
        RETURN 'המנהל לא אישר הובלה נוספת ליום שלישי זה. הפנייה נשארה בהמתנה ולא תואמה.';
      END IF;
      RETURN 'אין כרגע מועד שניתן להציע. השארתי את הפנייה בהמתנה; לא תואם מועד נוסף.';
    END IF;
    UPDATE haim.requests
       SET proposed_run_date = proposed, status = 'awaiting_approval', version = version + 1, updated_at = clock_timestamp()
     WHERE id = p_request;
    UPDATE haim.request_parties
       SET schedule_approved = false, schedule_approved_date = NULL, schedule_approved_at = NULL
     WHERE request_id = p_request;
  END IF;
  SELECT * INTO r FROM haim.requests WHERE id = p_request;
  IF NOT (
    r.run_date IS NULL
    AND r.proposed_run_date IS NOT NULL
    AND haim.ready_to_propose(p_request)
    AND NOT EXISTS (
      SELECT 1 FROM haim.request_parties p
       WHERE p.request_id = p_request
         AND (p.approved_at IS NULL OR p.approved_by_phone IS DISTINCT FROM p.phone OR p.schedule_approved_date IS DISTINCT FROM r.proposed_run_date)
    )
  ) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO nxt FROM haim.next_tuesday();
  IF nxt.same_day AND nxt.run_date = r.proposed_run_date THEN
    UPDATE haim.requests
       SET status = 'human', human_reason = 'same_day_admin_approval', version = version + 1, updated_at = clock_timestamp()
     WHERE id = p_request;
    RETURN 'העברתי את הפנייה לטיפול אנושי. נעדכן.';
  END IF;
  INSERT INTO haim.transport_runs(run_date, capacity) VALUES (r.proposed_run_date, 10) ON CONFLICT DO NOTHING;
  SELECT capacity, status INTO cap, st FROM haim.transport_runs WHERE run_date = r.proposed_run_date FOR UPDATE;
  SELECT count(*)::int INTO used FROM haim.requests WHERE run_date = r.proposed_run_date AND status IN ('coordinated','closed');
  IF st <> 'open' OR used >= cap THEN
    UPDATE haim.requests SET status = 'waiting_capacity', version = version + 1, updated_at = clock_timestamp() WHERE id = p_request;
    PERFORM haim.ask_capacity(p_request, r.proposed_run_date, cap);
    RETURN format('הגענו למכסת ההובלות ליום שלישי %s. שלחתי למנהל בקשה לאשר הובלה נוספת. הפנייה ממתינה; לא אעביר אותה אוטומטית לשבוע הבא ולא אתאם בלי אישור.', r.proposed_run_date);
  END IF;
  UPDATE haim.requests
     SET status = 'coordinated', run_date = r.proposed_run_date, proposed_run_date = NULL,
         version = version + 1, updated_at = clock_timestamp()
   WHERE id = p_request;
  FOR party_row IN SELECT phone FROM haim.request_parties WHERE request_id = p_request AND phone <> p_phone LOOP
    INSERT INTO haim.deliveries(dedupe_key, request_id, phone, chat_id, body)
    VALUES (
      'coordination:' || p_request::text || ':' || r.proposed_run_date::text || ':' || party_row.phone,
      p_request, party_row.phone, haim.chat_for(party_row.phone), haim.status_text(p_request)
    ) ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;
  RETURN haim.status_text(p_request);
END $$;

CREATE OR REPLACE FUNCTION haim.claim_guard(p_canonical text, p_proposed text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  marker text;
  markers text[] := ARRAY['התיאום הושלם','נשלחה','תואמה','בוצעה','נקבעה','מאושר','נשמר','אושר','פנינו','נשלח','תואם','שלחתי','פניתי','בוצע','נקבע','נאסוף','נבוא','ניקח'];
BEGIN
  IF p_proposed IS NULL OR btrim(p_proposed) = '' THEN RETURN p_canonical; END IF;
  FOREACH marker IN ARRAY markers LOOP
    IF position(marker IN p_proposed) > 0 AND position(marker IN COALESCE(p_canonical, '')) = 0 THEN
      RETURN p_canonical;
    END IF;
  END LOOP;
  IF COALESCE(p_canonical, '') ~ '(תמונה|photo|صورة|фото)' AND p_proposed !~ '(תמונה|photo|صورة|фото)' THEN
    RETURN p_canonical;
  END IF;
  IF COALESCE(p_canonical, '') ~ '(האם הפריט תקין|תקין ושמיש)' AND p_proposed !~ '(תקין|usable|سليم|исправен)' THEN
    RETURN p_canonical;
  END IF;
  RETURN btrim(p_proposed);
END $$;

CREATE OR REPLACE FUNCTION haim.new_request(p_origin text, p_status text DEFAULT 'collecting') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_number bigint;
BEGIN
  UPDATE haim.request_counter SET value = value + 1 WHERE id RETURNING value INTO v_number;
  INSERT INTO haim.requests(number, status, origin) VALUES (v_number, p_status, p_origin) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION haim.add_party(
  p_request uuid, p_role text, p_phone text, p_name text, p_approved boolean
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_contact uuid;
BEGIN
  v_contact := haim.ensure_contact(p_phone);
  INSERT INTO haim.request_parties(request_id, role, contact_id, phone, name, approved_at, approved_by_phone)
  VALUES (
    p_request, p_role, v_contact, p_phone, NULLIF(p_name, ''),
    CASE WHEN p_approved THEN clock_timestamp() ELSE NULL END,
    CASE WHEN p_approved THEN p_phone ELSE NULL END
  );
  INSERT INTO haim.request_verifications(request_id, role, state)
  VALUES (p_request, p_role, 'not_offered')
  ON CONFLICT DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION haim.add_items(p_request uuid, p_items jsonb, p_direct boolean, p_free boolean, p_working boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  item jsonb;
  i int := 0;
  k text;
  qty int;
  descr text;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    k := item->>'kind';
    qty := COALESCE((item->>'quantity')::int, 1);
    descr := btrim(item->>'description');
    IF k IS NULL OR descr IS NULL OR descr = '' THEN
      PERFORM haim.fail('invalid_item', 'חסר תיאור או סוג לפריט.');
    END IF;
    IF k IN ('piano','house_move') THEN
      PERFORM haim.fail('item_rejected', 'לא ניתן לסייע בהובלת פסנתרים או בהובלות דירה.');
    END IF;
    IF qty < 1 OR qty > 2 OR i > 1 THEN
      PERFORM haim.fail('too_many_items', 'ניתן לסייע בהובלת עד שני פריטים. שולחן וכיסאות נחשבים פריט אחד.');
    END IF;
    INSERT INTO haim.request_items(request_id, position, kind, description, quantity, free, working, needs_disassembly)
    VALUES (
      p_request, i, k, left(descr, 160), qty,
      CASE WHEN p_free IS FALSE THEN false ELSE true END,
      CASE WHEN p_direct THEN COALESCE(p_working, true) ELSE p_working END,
      CASE WHEN k IN ('fridge','oven','washing_machine','dryer','freezer','dishwasher') THEN false ELSE NULL END
    );
    i := i + 1;
  END LOOP;
  IF i = 0 THEN
    PERFORM haim.fail('invalid_item', 'חסר פריט.');
  END IF;
  IF haim.item_problem(p_request) IS NOT NULL THEN
    PERFORM haim.fail('item_rejected', haim.item_problem(p_request));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION haim.phone_supplied(p_text text, p_contacts jsonb, p_actor text, p_raw text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  phone text;
  digits text;
BEGIN
  phone := haim.canon_phone(p_raw);
  digits := regexp_replace(COALESCE(p_text, ''), '\D', '', 'g');
  IF phone = p_actor AND COALESCE(p_text, '') ~ '(לעצמי|אליי|אני[[:space:]]+(?:שני הצדדים|גם המוסר וגם המקבל))' THEN
    RETURN phone;
  END IF;
  IF position(phone IN digits) = 0 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_contacts, '[]'::jsonb)) c
     WHERE haim.canon_phone(c->>'phone') = phone
  ) THEN
    PERFORM haim.fail('phone_not_supplied', 'נא לשלוח את מספר הצד השני או כרטיס איש קשר.');
  END IF;
  RETURN phone;
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM = 'invalid_phone' THEN
    PERFORM haim.fail('phone_not_supplied', 'נא לשלוח את מספר הצד השני או כרטיס איש קשר.');
  END IF;
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION haim.target_request(p_conv uuid, p_phone text, p_number int) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_number IS NOT NULL THEN
    SELECT r.id INTO v_id
      FROM haim.requests r
      JOIN haim.request_parties p ON p.request_id = r.id
     WHERE r.number = p_number AND p.phone = p_phone
     LIMIT 1;
  END IF;
  IF v_id IS NULL THEN
    SELECT selected_request_id INTO v_id FROM haim.conversations WHERE id = p_conv;
  END IF;
  IF v_id IS NULL THEN
    SELECT r.id INTO v_id
      FROM haim.requests r
      JOIN haim.request_parties p ON p.request_id = r.id
     WHERE p.phone = p_phone
       AND r.status NOT IN ('closed','cancelled','rejected')
     ORDER BY r.number DESC
     LIMIT 1;
  END IF;
  IF v_id IS NULL THEN
    PERFORM haim.fail('choose_request', 'נא לציין אם ברצונך למסור פריט, לקבל פריט או לתאם הובלה.');
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION haim.exec_command(
  p_phone text,
  p_text text,
  p_contacts jsonb,
  p_conv uuid,
  p_cmd jsonb,
  p_prev_reply text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE
  kind text := p_cmd->>'type';
  req uuid;
  origin text;
  direct boolean;
  other text;
  items jsonb;
  free_flag boolean;
  working_flag boolean;
  existing uuid;
  n int;
  reply text;
  notices jsonb := '[]'::jsonb;
  party haim.request_parties%ROWTYPE;
  reg record;
  settlement text;
  addr text;
  chosen_role text;
  v_number int;
BEGIN
  IF kind IS NULL OR kind = 'next' OR kind = 'status' THEN
    IF kind = 'status' THEN
      SELECT r.id INTO req FROM haim.requests r
        JOIN haim.request_parties p ON p.request_id = r.id
       WHERE p.phone = p_phone AND r.status NOT IN ('closed','cancelled','rejected')
       ORDER BY r.number DESC LIMIT 1;
      reply := CASE WHEN req IS NULL THEN 'לא נמצאו פניות פעילות עבורך.' ELSE haim.status_text(req) END;
    ELSIF kind = 'next' THEN
      req := haim.target_request(p_conv, p_phone, NULLIF(p_cmd->>'request_number','')::int);
      reply := haim.next_question(req, p_phone);
    ELSE
      reply := NULL;
      req := NULL;
    END IF;
    RETURN jsonb_build_object('request_id', req, 'reply', reply, 'notices', notices);
  END IF;

  IF kind = 'donate' OR kind = 'receive_from_donor' THEN
    items := p_cmd->'items';
    other := NULLIF(CASE WHEN kind = 'donate' THEN p_cmd->>'counterparty_phone' ELSE p_cmd->>'donor_phone' END, '');
    direct := other IS NOT NULL OR COALESCE((p_cmd->>'direct')::boolean, false);
    IF kind = 'donate' AND NOT direct AND COALESCE(p_text, '') !~ '(למסירה|לתרומה|למסור|לתרום|מוסר|מוסרת|להעביר|מעביר|מעבירה|יש לי להעביר|donate|donation|تبرع|отдать)' THEN
      PERFORM haim.fail('donor_intent_required', 'האם ברצונך למסור את הפריט בחינם?');
    END IF;
    free_flag := CASE WHEN p_cmd ? 'free' AND p_cmd->>'free' IS NOT NULL THEN (p_cmd->>'free')::boolean ELSE NULL END;
    working_flag := CASE WHEN p_cmd ? 'working' AND p_cmd->>'working' IS NOT NULL THEN (p_cmd->>'working')::boolean ELSE NULL END;
    IF free_flag IS FALSE THEN
      PERFORM haim.fail('item_rejected', 'התוכנית מסייעת במסירה בחינם בלבד.');
    END IF;
    IF working_flag IS FALSE THEN
      PERFORM haim.fail('item_rejected', 'ניתן למסור רק ציוד תקין ושמיש ב־100%.');
    END IF;
    IF other IS NOT NULL THEN
      other := haim.phone_supplied(p_text, p_contacts, p_phone, other);
    END IF;
    SELECT r.id INTO existing
      FROM haim.requests r
      JOIN haim.request_parties donor ON donor.request_id = r.id AND donor.role = 'donor' AND donor.phone = p_phone
     WHERE r.status NOT IN ('coordinated','closed','cancelled','rejected','cancel_pending')
       AND (SELECT count(*) FROM haim.request_items i WHERE i.request_id = r.id) = jsonb_array_length(items)
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(items) WITH ORDINALITY e(item, ord)
          WHERE COALESCE((SELECT i.kind FROM haim.request_items i WHERE i.request_id = r.id AND i.position = (ord-1)::int), '') <> (item->>'kind')
       )
     ORDER BY r.number DESC LIMIT 1;
    IF existing IS NOT NULL AND COALESCE((p_cmd->>'force_new')::boolean, false) IS NOT TRUE THEN
      UPDATE haim.conversations SET selected_request_id = existing, version = version + 1 WHERE id = p_conv;
      RETURN jsonb_build_object('request_id', existing, 'reply', format('כבר קיימת פנייה %s עבור הפריט הזה. נמשיך אותה.', (SELECT number FROM haim.requests WHERE id = existing)), 'notices', notices);
    END IF;
    origin := CASE WHEN direct THEN 'direct' ELSE 'donation' END;
    req := haim.new_request(origin, 'collecting');
    PERFORM haim.add_items(req, items, direct, true, working_flag);
    IF kind = 'donate' THEN
      PERFORM haim.add_party(req, 'donor', p_phone, NULL, true);
      IF other IS NOT NULL THEN
        PERFORM haim.add_party(req, 'receiver', other, NULLIF(p_cmd->>'counterparty_name',''), other = p_phone);
      END IF;
    ELSE
      PERFORM haim.add_party(req, 'receiver', p_phone, NULL, false);
      IF other IS NOT NULL THEN
        PERFORM haim.add_party(req, 'donor', other, NULLIF(p_cmd->>'counterparty_name',''), false);
      END IF;
    END IF;
    IF other IS NOT NULL AND other = p_phone THEN
      UPDATE haim.requests SET represents_both_parties = true WHERE id = req;
    END IF;
    UPDATE haim.conversations SET selected_request_id = req, version = version + 1 WHERE id = p_conv;
    reply := haim.next_question(req, p_phone);
    IF haim.photo_gate(req) THEN reply := 'בשמחה. כדי להמשיך, נא לשלוח תמונה של הפריט.'; END IF;
    RETURN jsonb_build_object('request_id', req, 'reply', reply, 'notices', notices);
  END IF;

  v_number := NULLIF(p_cmd->>'request_number','')::int;
  req := haim.target_request(p_conv, p_phone, v_number);
  PERFORM haim.mutable(req);

  IF kind = 'details' THEN
    chosen_role := NULLIF(p_cmd->>'role','');
    BEGIN
      party := haim.own_party(req, p_phone, chosen_role);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF chosen_role = 'receiver' AND EXISTS (
        SELECT 1 FROM haim.requests r JOIN haim.request_parties d ON d.request_id = r.id
         WHERE r.id = req AND r.origin = 'direct' AND d.role = 'donor' AND d.phone = p_phone
      ) THEN
        SELECT * INTO party FROM haim.request_parties WHERE request_id = req AND role = 'receiver';
        IF party.approved_at IS NOT NULL THEN RAISE; END IF;
      ELSE
        RAISE;
      END IF;
    END;
    IF p_cmd ? 'name' OR p_cmd ? 'settlement' OR p_cmd ? 'address' OR (p_cmd ? 'floor' AND p_cmd->>'floor' IS NOT NULL) THEN
      PERFORM haim.invalidate_schedule(req);
    END IF;
    settlement := NULLIF(p_cmd->>'settlement','');
    addr := NULLIF(p_cmd->>'address','');
    IF settlement IS NOT NULL AND NOT (addr IS NOT NULL AND addr ~ '^(רחוב|שיכון|שכונה|שכונת|שדרות|שד)' AND position(settlement IN addr) > 0) THEN
      SELECT * INTO reg FROM haim.region_of(settlement);
      IF reg.decision = 'outside' THEN
        UPDATE haim.requests SET status = 'rejected', version = version + 1, updated_at = clock_timestamp() WHERE id = req;
        RETURN jsonb_build_object('request_id', req, 'reply', 'אנחנו פועלים רק בבית שאן, מסילות, ירדנה, בית אלפא, טירת צבי, כפר רופין ומחולה. לא נוכל לסייע בהובלה הזו.', 'notices', notices);
      ELSIF reg.decision = 'review' THEN
        UPDATE haim.requests SET status = 'human', human_reason = 'borderline_area', version = version + 1, updated_at = clock_timestamp() WHERE id = req;
        RETURN jsonb_build_object('request_id', req, 'reply', 'העברתי את הפנייה לטיפול אנושי. נעדכן.', 'notices', notices, 'escalate', true);
      END IF;
      UPDATE haim.request_parties SET settlement = reg.name WHERE request_id = req AND role = party.role;
    END IF;
    IF NULLIF(p_cmd->>'name','') IS NOT NULL THEN
      UPDATE haim.request_parties SET name = p_cmd->>'name' WHERE request_id = req AND phone = p_phone;
    END IF;
    IF addr IS NOT NULL THEN
      UPDATE haim.request_parties SET address = addr WHERE request_id = req AND role = party.role;
    END IF;
    UPDATE haim.request_parties
       SET floor = CASE
         WHEN settlement IS NOT NULL AND settlement <> 'בית שאן' THEN 0
         WHEN p_cmd->>'floor' IS NOT NULL AND (settlement = 'בית שאן' OR (settlement IS NULL AND (SELECT settlement FROM haim.request_parties WHERE request_id = req AND role = party.role) = 'בית שאן')) THEN (p_cmd->>'floor')::smallint
         ELSE floor END
     WHERE request_id = req AND role = party.role;
    reply := haim.next_question(req, p_phone);
    RETURN jsonb_build_object('request_id', req, 'reply', reply, 'notices', notices);
  END IF;

  IF kind = 'item_facts' THEN
    PERFORM haim.own_party(req, p_phone, 'donor');
    PERFORM haim.invalidate_schedule(req);
    IF p_cmd ? 'working' AND p_cmd->>'working' IS NOT NULL THEN
      IF (p_cmd->>'working')::boolean AND COALESCE(p_text,'') !~ '(תקינ|תקין|עובד|שמיש)' AND NOT (haim.explicit_approval(p_text) AND COALESCE(p_prev_reply,'') LIKE '%תקין%') THEN
        PERFORM haim.fail('working_confirmation_missing', 'נא לאשר שהפריט תקין ושמיש.');
      END IF;
      UPDATE haim.request_items SET working = (p_cmd->>'working')::boolean WHERE request_id = req;
    END IF;
    IF COALESCE(p_text,'') ~ '(לא תקין|לא עובד|מקולקל|שבור)' THEN
      UPDATE haim.request_items SET working = false WHERE request_id = req;
    END IF;
    IF p_cmd ? 'free' AND p_cmd->>'free' IS NOT NULL THEN
      IF (p_cmd->>'free')::boolean AND COALESCE(p_text,'') !~ '(חינם|תרומה)' AND NOT (haim.explicit_approval(p_text) AND COALESCE(p_prev_reply,'') LIKE '%בחינם%') THEN
        PERFORM haim.fail('free_confirmation_missing', 'נא לאשר שהמסירה בחינם.');
      END IF;
      UPDATE haim.request_items SET free = (p_cmd->>'free')::boolean WHERE request_id = req;
    END IF;
    IF p_cmd ? 'needs_disassembly' AND p_cmd->>'needs_disassembly' IS NOT NULL THEN
      UPDATE haim.request_items SET needs_disassembly = (p_cmd->>'needs_disassembly')::boolean
       WHERE request_id = req AND kind NOT IN ('fridge','oven','washing_machine','dryer','freezer','dishwasher');
    END IF;
    IF p_cmd ? 'wardrobe_small_whole' AND p_cmd->>'wardrobe_small_whole' IS NOT NULL THEN
      UPDATE haim.request_items SET wardrobe_small_whole = (p_cmd->>'wardrobe_small_whole')::boolean
       WHERE request_id = req AND kind = 'wardrobe';
    END IF;
    IF NULLIF(p_cmd->>'oven_type','') IS NOT NULL THEN
      UPDATE haim.request_items SET oven_type = p_cmd->>'oven_type' WHERE request_id = req AND kind = 'oven';
    END IF;
    IF NULLIF(p_cmd->>'evacuation','') IS NOT NULL THEN
      UPDATE haim.request_items SET evacuation = p_cmd->>'evacuation' WHERE request_id = req;
    END IF;
    IF haim.item_problem(req) IS NOT NULL THEN
      UPDATE haim.requests SET status = 'rejected', version = version + 1, updated_at = clock_timestamp() WHERE id = req;
      RETURN jsonb_build_object('request_id', req, 'reply', haim.item_problem(req), 'notices', notices);
    END IF;
    IF EXISTS (SELECT 1 FROM haim.request_items WHERE request_id = req AND evacuation = 'different') THEN
      UPDATE haim.requests SET status = 'human', human_reason = 'evacuation', version = version + 1, updated_at = clock_timestamp() WHERE id = req;
      RETURN jsonb_build_object('request_id', req, 'reply', 'העברתי את הפנייה לטיפול אנושי. נעדכן.', 'notices', notices, 'escalate', true);
    END IF;
    RETURN jsonb_build_object('request_id', req, 'reply', haim.next_question(req, p_phone), 'notices', notices);
  END IF;

  IF kind = 'approve_self' THEN
    IF NOT haim.explicit_approval(p_text) OR (haim.bare_yes(p_text) AND COALESCE(p_prev_reply,'') !~ '(נא לאשר|לאשר מחדש)') THEN
      PERFORM haim.fail('explicit_approval_required', 'נא לאשר במפורש את חלקך בפנייה.');
    END IF;
    UPDATE haim.request_parties
       SET approved_at = COALESCE(approved_at, clock_timestamp()), approved_by_phone = phone
     WHERE request_id = req AND phone = p_phone;
    RETURN jsonb_build_object('request_id', req, 'reply', haim.next_question(req, p_phone), 'notices', notices);
  END IF;

  IF kind = 'approve_schedule' THEN
    IF NOT EXISTS (
      SELECT 1 FROM haim.requests r
       WHERE r.id = req AND r.proposed_run_date = (p_cmd->>'date')::date
    ) OR NOT haim.explicit_approval(p_text) THEN
      PERFORM haim.fail('schedule_approval_mismatch', 'המועד לא אושר כי הוא אינו תואם להצעה הנוכחית. נשלח מחדש את המועד המעודכן.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM haim.request_parties WHERE request_id = req AND phone = p_phone AND approved_at IS NOT NULL) THEN
      PERFORM haim.fail('identity_approval_required', 'נא לאשר תחילה את חלקך בפנייה.');
    END IF;
    IF haim.bare_yes(p_text) AND COALESCE(p_prev_reply,'') !~ '(נא לאשר את המועד|ממתינים לאישור המועד)' AND position(to_char((p_cmd->>'date')::date, 'DD/MM/YYYY') IN COALESCE(p_text,'')) = 0 THEN
      PERFORM haim.fail('schedule_approval_mismatch', 'המועד לא אושר כי הוא אינו תואם להצעה הנוכחית. נשלח מחדש את המועד המעודכן.');
    END IF;
    UPDATE haim.request_parties
       SET schedule_approved = true,
           schedule_approved_date = (SELECT proposed_run_date FROM haim.requests WHERE id = req),
           schedule_approved_at = clock_timestamp()
     WHERE request_id = req AND phone = p_phone;
    RETURN jsonb_build_object('request_id', req, 'reply', haim.next_question(req, p_phone), 'notices', notices);
  END IF;

  IF kind = 'cancel' THEN
    IF COALESCE(p_cmd->>'choice','final') = 'final' THEN
      IF COALESCE(p_text,'') !~ '(סופית|סופי|לגמרי|לא רלוונטי|לבטל|ביטול|תבטלו|תבטל|מבטל|מבטלת)' THEN
        PERFORM haim.fail('final_cancellation_not_explicit', 'נא לציין במפורש אם ברצונך לבטל את ההובלה.');
      END IF;
      UPDATE haim.requests
         SET status = 'cancelled', run_date = NULL, proposed_run_date = NULL, closed_at = clock_timestamp(),
             version = version + 1, updated_at = clock_timestamp()
       WHERE id = req;
      SELECT string_agg(description, ', ') INTO addr FROM haim.request_items WHERE request_id = req;
      reply := format('פנייה %s בוטלה: %s. לא תתואם הובלה.', (SELECT number FROM haim.requests WHERE id = req), COALESCE(addr, 'פריט'));
      FOR party IN SELECT * FROM haim.request_parties WHERE request_id = req AND phone <> p_phone LOOP
        notices := notices || jsonb_build_array(jsonb_build_object('phone', party.phone, 'body', reply, 'dedupe', 'cancel:' || req::text || ':' || party.phone));
      END LOOP;
      RETURN jsonb_build_object('request_id', req, 'reply', reply, 'notices', notices);
    END IF;
    PERFORM haim.fail('cancellation_not_explicit', 'נא לציין במפורש אם ברצונך לבטל את ההובלה.');
  END IF;

  IF kind = 'escalate' THEN
    UPDATE haim.requests SET status = 'human', human_reason = COALESCE(NULLIF(p_cmd->>'reason',''), 'unclear'), version = version + 1, updated_at = clock_timestamp()
     WHERE id = req AND status <> 'coordinated';
    UPDATE haim.conversations SET mode = 'human', version = version + 1 WHERE id = p_conv;
    RETURN jsonb_build_object('request_id', req, 'reply', 'העברתי את הפנייה לטיפול אנושי. נעדכן.', 'notices', notices, 'escalate', true);
  END IF;

  IF kind = 'contact_counterparty' THEN
    IF NOT EXISTS (SELECT 1 FROM haim.requests WHERE id = req AND origin = 'direct') THEN
      PERFORM haim.fail('counterparty_not_ready', 'נא לשלוח קודם את מספר הצד השני או כרטיס איש קשר.');
    END IF;
    SELECT * INTO party FROM haim.request_parties WHERE request_id = req AND phone <> p_phone LIMIT 1;
    IF NOT FOUND THEN
      PERFORM haim.fail('counterparty_not_ready', 'נא לשלוח קודם את מספר הצד השני או כרטיס איש קשר.');
    END IF;
    IF COALESCE((p_cmd->>'contact')::boolean, false) THEN
      UPDATE haim.requests SET verification_contacted = true, version = version + 1, updated_at = clock_timestamp() WHERE id = req;
      INSERT INTO haim.request_verifications(request_id, role, state)
      VALUES (req, party.role, 'consented')
      ON CONFLICT (request_id, role) DO UPDATE SET state = 'consented', updated_at = clock_timestamp();
      notices := notices || jsonb_build_array(jsonb_build_object(
        'phone', party.phone,
        'dedupe', 'verify:' || req::text || ':' || party.phone,
        'body', format(E'שלום%s,\n\nפנייה %s: %s.\nנא לאשר את חלקך ב%s.',
          COALESCE(' ' || party.name, ''),
          (SELECT number FROM haim.requests WHERE id = req),
          COALESCE((SELECT string_agg(description, ', ') FROM haim.request_items WHERE request_id = req), 'פריט'),
          CASE WHEN party.role = 'donor' THEN 'מסירה' ELSE 'קבלה' END)
      ));
      reply := 'נפנה לצד השני עכשיו לצורך אימות.' || E'\n' || haim.next_question(req, p_phone);
    ELSE
      UPDATE haim.requests SET verification_contacted = false WHERE id = req;
      INSERT INTO haim.request_verifications(request_id, role, state, last_error)
      VALUES (req, party.role, 'declined', 'user_declined_contact')
      ON CONFLICT (request_id, role) DO UPDATE SET state = 'declined', last_error = 'user_declined_contact', updated_at = clock_timestamp();
      reply := 'בסדר, לא נפנה לצד השני כרגע.' || E'\n' || haim.next_question(req, p_phone);
    END IF;
    RETURN jsonb_build_object('request_id', req, 'reply', reply, 'notices', notices);
  END IF;

  IF kind = 'counterparty' THEN
    IF NULLIF(p_cmd->>'phone','') IS NULL THEN
      UPDATE haim.conversations
         SET pending_counterparty_name = NULLIF(p_cmd->>'name',''), version = version + 1
       WHERE id = p_conv;
      RETURN jsonb_build_object('request_id', req, 'reply', format('רשמתי שהמקבל הוא %s. כדי שנוכל לתאם איתו ב־WhatsApp, נא לשלוח את מספר הטלפון שלו או כרטיס איש קשר. אם אין לך את המספר, כתוב "אין לי מספר" ונמשיך לחיפוש מקבל מתאים.', COALESCE(p_cmd->>'name','המקבל')), 'notices', notices);
    END IF;
    other := haim.phone_supplied(p_text, p_contacts, p_phone, p_cmd->>'phone');
    chosen_role := CASE WHEN (SELECT role FROM haim.request_parties WHERE request_id = req AND phone = p_phone LIMIT 1) = 'donor' THEN 'receiver' ELSE 'donor' END;
    IF EXISTS (SELECT 1 FROM haim.request_parties WHERE request_id = req AND role = chosen_role) THEN
      PERFORM haim.fail('party_already_linked', 'כבר קיים צד שני בפנייה הזו.');
    END IF;
    PERFORM haim.add_party(req, chosen_role, other, NULLIF(p_cmd->>'name',''), other = p_phone);
    UPDATE haim.requests SET origin = 'direct', represents_both_parties = (other = p_phone), version = version + 1, updated_at = clock_timestamp() WHERE id = req;
    UPDATE haim.request_items SET working = COALESCE(working, true) WHERE request_id = req;
    UPDATE haim.conversations SET pending_counterparty_name = NULL, pending_counterparty_phone = NULL, version = version + 1 WHERE id = p_conv;
    RETURN jsonb_build_object('request_id', req, 'reply', haim.next_question(req, p_phone), 'notices', notices);
  END IF;

  IF kind = 'seek' THEN
    PERFORM haim.ensure_contact(p_phone);
    INSERT INTO haim.searches(contact_id, kind)
    VALUES ((SELECT id FROM haim.contacts WHERE phone = p_phone), p_cmd->>'kind')
    ON CONFLICT (contact_id) DO UPDATE SET kind = EXCLUDED.kind, state = 'active', updated_at = clock_timestamp();
    SELECT r.id INTO existing
      FROM haim.requests r
      JOIN haim.request_items i ON i.request_id = r.id AND i.kind = p_cmd->>'kind'
     WHERE r.status = 'available' AND r.origin = 'donation'
       AND NOT EXISTS (SELECT 1 FROM haim.request_parties p WHERE p.request_id = r.id AND p.role = 'receiver')
     ORDER BY r.number LIMIT 1;
    IF existing IS NULL THEN
      RETURN jsonb_build_object('request_id', NULL, 'reply', 'כרגע לא נמצא פריט מתאים. נעדכן כשיהיה פריט מתאים.', 'notices', notices);
    END IF;
    INSERT INTO haim.matches(request_id, contact_id, state)
    VALUES (existing, (SELECT id FROM haim.contacts WHERE phone = p_phone),
      CASE WHEN EXISTS (SELECT 1 FROM haim.request_media m WHERE m.request_id = existing) THEN 'presented' ELSE 'waiting_photo' END)
    ON CONFLICT (request_id, contact_id) DO NOTHING;
    reply := CASE WHEN EXISTS (SELECT 1 FROM haim.request_media m WHERE m.request_id = existing)
      THEN 'יש פריט מתאים. אם הוא מתאים לך, כתוב כן.'
      ELSE 'נבקש מהמוסר תמונה של הפריט ונעדכן.' END;
    RETURN jsonb_build_object('request_id', existing, 'reply', reply, 'notices', notices);
  END IF;

  IF kind = 'interest' THEN
    SELECT m.request_id INTO existing
      FROM haim.matches m
      JOIN haim.requests r ON r.id = m.request_id AND r.number = (p_cmd->>'request_number')::int
      JOIN haim.contacts c ON c.id = m.contact_id AND c.phone = p_phone
     WHERE m.state = 'presented';
    IF existing IS NULL THEN
      PERFORM haim.fail('match_unavailable', 'הפריט כבר אינו זמין. נחפש פריט מתאים נוסף.');
    END IF;
    IF EXISTS (SELECT 1 FROM haim.request_parties WHERE request_id = existing AND role = 'receiver') THEN
      PERFORM haim.fail('match_taken', 'הפריט כבר אינו זמין. נחפש פריט מתאים נוסף.');
    END IF;
    PERFORM haim.add_party(existing, 'receiver', p_phone, NULL, false);
    UPDATE haim.requests SET status = 'awaiting_approval', version = version + 1, updated_at = clock_timestamp() WHERE id = existing;
    UPDATE haim.matches SET state = CASE WHEN contact_id = (SELECT id FROM haim.contacts WHERE phone = p_phone) THEN 'interested' ELSE 'unavailable' END
     WHERE request_id = existing;
    UPDATE haim.conversations SET selected_request_id = existing WHERE id = p_conv;
    RETURN jsonb_build_object('request_id', existing, 'reply', haim.next_question(existing, p_phone), 'notices', notices);
  END IF;

  IF kind = 'select' THEN
    req := haim.target_request(p_conv, p_phone, (p_cmd->>'request_number')::int);
    UPDATE haim.conversations SET selected_request_id = req, version = version + 1 WHERE id = p_conv;
    RETURN jsonb_build_object('request_id', req, 'reply', haim.next_question(req, p_phone), 'notices', notices);
  END IF;

  IF kind = 'capacity_decision' THEN
    IF p_phone <> haim.admin_phone() THEN
      PERFORM haim.fail('admin_required', 'רק המנהל המורשה יכול לאשר הובלה מעבר למכסה. הבקשה שלך לא שינתה את התיאום.');
    END IF;
    SELECT count(*) INTO n FROM haim.transport_capacity_approvals
     WHERE status = 'pending' AND (NULLIF(p_cmd->>'date','') IS NULL OR run_date = (p_cmd->>'date')::date);
    IF n = 0 THEN
      RETURN jsonb_build_object('request_id', NULL, 'reply', 'אין בקשת הגדלת מכסה ממתינה כרגע.', 'notices', notices);
    ELSIF n > 1 THEN
      RETURN jsonb_build_object('request_id', NULL, 'reply', 'יש כמה בקשות ממתינות. נא להשיב כן או לא בצירוף תאריך בפורמט YYYY-MM-DD.', 'notices', notices);
    END IF;
    IF COALESCE((p_cmd->>'approve')::boolean, false) THEN
      UPDATE haim.transport_runs tr
         SET capacity = a.requested_capacity
        FROM haim.transport_capacity_approvals a
       WHERE a.status = 'pending'
         AND (NULLIF(p_cmd->>'date','') IS NULL OR a.run_date = (p_cmd->>'date')::date)
         AND tr.run_date = a.run_date;
      UPDATE haim.transport_capacity_approvals
         SET status = 'approved', resolved_at = clock_timestamp(), resolved_by = p_phone
       WHERE status = 'pending' AND (NULLIF(p_cmd->>'date','') IS NULL OR run_date = (p_cmd->>'date')::date);
      reply := 'אישרת הובלה נוספת אחת. המכסה הוגדלה באותו יום בלבד; ההובלה עדיין תתואם רק לאחר אישורי הצדדים.';
    ELSE
      UPDATE haim.transport_capacity_approvals
         SET status = 'denied', resolved_at = clock_timestamp(), resolved_by = p_phone
       WHERE status = 'pending' AND (NULLIF(p_cmd->>'date','') IS NULL OR run_date = (p_cmd->>'date')::date);
      reply := 'הבנתי. לא אוסיף הובלה לאותו יום; הפניות הממתינות יישארו ללא תיאום.';
    END IF;
    RETURN jsonb_build_object('request_id', NULL, 'reply', reply, 'notices', notices);
  END IF;

  IF kind = 'clarify_duplicate' THEN
    RETURN jsonb_build_object('request_id', req, 'reply', format('כבר קיימת פנייה %s. נמשיך אותה, אלא אם ביקשת פריט חדש.', (SELECT number FROM haim.requests WHERE id = req)), 'notices', notices);
  END IF;

  PERFORM haim.fail('unknown_command', 'הפקודה אינה מוכרת.');
  RETURN jsonb_build_object('request_id', req, 'reply', NULL, 'notices', notices);
END $$;

CREATE OR REPLACE FUNCTION public.haim_get_context(p_phone text) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_variable
DECLARE
  phone text;
  conv haim.conversations%ROWTYPE;
  access jsonb;
  allowed boolean := true;
BEGIN
  phone := haim.canon_phone(p_phone);
  SELECT * INTO conv
    FROM haim.conversations c
    JOIN haim.contacts co ON co.id = c.contact_id
   WHERE co.phone = phone
   ORDER BY c.created_at DESC
   LIMIT 1;
  SELECT value INTO access FROM haim.app_settings WHERE key = 'bot_access';
  IF access IS NOT NULL AND access->>'mode' = 'allowlist' THEN
    allowed := phone = ANY (SELECT jsonb_array_elements_text(COALESCE(access->'phones','[]'::jsonb)));
  END IF;
  RETURN jsonb_build_object(
    'phone', phone,
    'is_admin', phone = haim.admin_phone(),
    'access', CASE WHEN allowed THEN 'open' ELSE 'denied' END,
    'admin_phone', haim.admin_phone(),
    'service_towns', 'בית שאן, מסילות, ירדנה, בית אלפא, טירת צבי, כפר רופין ומחולה',
    'conversation', CASE WHEN conv.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', conv.id, 'mode', conv.mode, 'chat_id', conv.chat_id, 'session', conv.session,
      'selected_request_id', conv.selected_request_id,
      'pending_counterparty_name', conv.pending_counterparty_name,
      'pending_counterparty_phone', conv.pending_counterparty_phone,
      'version', conv.version
    ) END,
    'requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'number', r.number, 'status', r.status, 'origin', r.origin,
        'version', r.version, 'run_date', r.run_date, 'proposed_run_date', r.proposed_run_date,
        'represents_both_parties', r.represents_both_parties,
        'verification_contacted', r.verification_contacted, 'human_reason', r.human_reason,
        'photo_gate', haim.photo_gate(r.id),
        'next_question', haim.next_question(r.id, phone),
        'parties', (SELECT COALESCE(jsonb_agg(to_jsonb(p) - 'contact_id'), '[]'::jsonb) FROM haim.request_parties p WHERE p.request_id = r.id),
        'items', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.position), '[]'::jsonb) FROM haim.request_items i WHERE i.request_id = r.id),
        'locations', (SELECT COALESCE(jsonb_agg(to_jsonb(l)), '[]'::jsonb) FROM haim.request_locations l WHERE l.request_id = r.id),
        'media_ids', (SELECT COALESCE(jsonb_agg(m.id), '[]'::jsonb) FROM haim.request_media rm JOIN haim.media m ON m.id = rm.media_id WHERE rm.request_id = r.id)
      ) ORDER BY r.number)
      FROM haim.requests r
      JOIN haim.request_parties p ON p.request_id = r.id AND p.phone = phone
    ), '[]'::jsonb),
    'recent_messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'waha_message_id', m.waha_message_id, 'kind', m.kind,
        'text', m.text, 'reply', m.reply, 'error_code', m.error_code,
        'received_at', m.received_at, 'processed_at', m.processed_at
      ) ORDER BY m.seq)
      FROM (
        SELECT * FROM haim.messages
         WHERE conversation_id = conv.id
         ORDER BY seq DESC LIMIT 40
      ) m
    ), '[]'::jsonb),
    'pending_deliveries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'phone', d.phone, 'chat_id', d.chat_id, 'text', d.body, 'state', d.state, 'dedupe_key', d.dedupe_key))
        FROM haim.deliveries d
       WHERE d.phone = phone AND d.state IN ('pending','sending','uncertain')
    ), '[]'::jsonb)
  );
END $$;

CREATE OR REPLACE FUNCTION public.haim_apply_turn(
  p_waha_message_id text,
  p_phone text,
  p_updates jsonb,
  p_reply_text text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE
  phone text;
  session text;
  chat text;
  kind text;
  body text;
  phase text;
  contact uuid;
  conv uuid;
  msg uuid;
  existing jsonb;
  processed timestamptz;
  cmd jsonb;
  result jsonb;
  req uuid;
  canonical text;
  final_reply text;
  replaced boolean := false;
  send_it boolean := false;
  rejected boolean := false;
  err_code text;
  err_detail text;
  prev_reply text;
  notice jsonb;
  outbound jsonb := '[]'::jsonb;
  del_id uuid;
  access jsonb;
  outside text;
  pressure text;
  v_loc jsonb;
  media_id uuid;
  owned int;
BEGIN
  IF p_waha_message_id IS NULL OR length(p_waha_message_id) = 0 OR length(p_waha_message_id) > 300 THEN
    PERFORM haim.fail('missing_message_id', 'חסר מזהה הודעה.');
  END IF;
  phone := haim.canon_phone(p_phone);
  PERFORM pg_advisory_xact_lock(hashtextextended('haim:' || phone, 0));
  session := COALESCE(NULLIF(p_updates->>'session',''), 'HAIM_YAHAD');
  chat := COALESCE(NULLIF(p_updates->>'chat_id',''), '972' || phone || '@c.us');
  kind := COALESCE(NULLIF(p_updates->>'kind',''), 'text');
  body := COALESCE(p_updates->>'text', '');
  phase := COALESCE(NULLIF(p_updates->>'phase',''), 'full');
  IF kind NOT IN ('text','image','voice','contact','location') THEN
    PERFORM haim.fail('bad_kind', 'סוג ההודעה אינו נתמך.');
  END IF;

  SELECT m.turn_result INTO existing
    FROM haim.messages m
   WHERE m.session = session AND m.waha_message_id = p_waha_message_id;
  IF existing IS NOT NULL AND COALESCE((existing->>'ingested')::boolean, false) IS NOT TRUE THEN
    RETURN existing || jsonb_build_object(
      'duplicate', true,
      'send', EXISTS (
        SELECT 1 FROM haim.deliveries d
         WHERE d.dedupe_key = 'reply:' || session || ':' || p_waha_message_id
           AND d.state = 'pending'
      )
    );
  END IF;

  contact := haim.ensure_contact(phone);
  INSERT INTO haim.conversations(contact_id, session, chat_id)
  VALUES (contact, session, chat)
  ON CONFLICT ON CONSTRAINT conversations_session_contact_id_key DO UPDATE SET chat_id = EXCLUDED.chat_id
  RETURNING id INTO conv;
  INSERT INTO haim.contact_identities(session, chat_id, contact_id)
  VALUES (session, chat, contact)
  ON CONFLICT ON CONSTRAINT contact_identities_pkey DO UPDATE SET contact_id = EXCLUDED.contact_id;

  INSERT INTO haim.messages(session, waha_message_id, contact_id, conversation_id, kind, text, contacts, location, media)
  VALUES (
    session, p_waha_message_id, contact, conv, kind, body,
    COALESCE(p_updates->'contacts', '[]'::jsonb),
    p_updates->'location',
    p_updates->'media'
  )
  ON CONFLICT ON CONSTRAINT messages_session_waha_message_id_key DO NOTHING
  RETURNING id INTO msg;
  IF msg IS NULL THEN
    SELECT m.id, m.turn_result, m.processed_at INTO msg, existing, processed
      FROM haim.messages m
     WHERE m.session = session AND m.waha_message_id = p_waha_message_id;
    -- An ingest-only row stays open so the same WAHA id can be applied later.
    IF existing IS NOT NULL AND NOT (
      processed IS NULL AND COALESCE((existing->>'ingested')::boolean, false)
    ) THEN
      RETURN existing || jsonb_build_object(
        'duplicate', true,
        'send', EXISTS (
          SELECT 1 FROM haim.deliveries d
           WHERE d.dedupe_key = 'reply:' || session || ':' || p_waha_message_id
             AND d.state = 'pending'
        )
      );
    END IF;
  END IF;
  PERFORM haim.write_log('info', 'inbound', phone, conv, NULL, p_waha_message_id,
    jsonb_build_object('kind', kind, 'phase', phase, 'text', left(body, 500)));

  IF phase = 'ingest' THEN
    UPDATE haim.messages
       SET turn_result = jsonb_build_object('ok', true, 'ingested', true, 'send', false, 'message_id', msg, 'conversation_id', conv)
     WHERE id = msg AND processed_at IS NULL;
    RETURN (SELECT turn_result FROM haim.messages WHERE id = msg);
  END IF;

  IF EXISTS (
    SELECT 1 FROM haim.messages m
     WHERE m.conversation_id = conv AND m.processed_at IS NULL AND m.seq > (SELECT seq FROM haim.messages WHERE id = msg)
  ) THEN
    UPDATE haim.messages
       SET processed_at = clock_timestamp(), error_code = 'coalesced',
           turn_result = jsonb_build_object('ok', true, 'coalesced', true, 'send', false, 'message_id', msg)
     WHERE id = msg;
    RETURN (SELECT turn_result FROM haim.messages WHERE id = msg);
  END IF;

  SELECT value INTO access FROM haim.app_settings WHERE key = 'bot_access';
  IF access IS NOT NULL AND access->>'mode' = 'allowlist' AND phone <> ALL (
    SELECT jsonb_array_elements_text(COALESCE(access->'phones','[]'::jsonb))
  ) AND phone <> haim.admin_phone() THEN
    UPDATE haim.messages SET processed_at = clock_timestamp(), error_code = 'access_denied',
      turn_result = jsonb_build_object('ok', true, 'send', false, 'error', 'access_denied', 'message_id', msg)
     WHERE id = msg;
    PERFORM haim.write_log('warn', 'rejected_update', phone, conv, NULL, p_waha_message_id, '{"code":"access_denied"}'::jsonb);
    RETURN (SELECT turn_result FROM haim.messages WHERE id = msg);
  END IF;

  IF (SELECT mode FROM haim.conversations WHERE id = conv) = 'human' THEN
    final_reply := NULL;
    send_it := false;
    INSERT INTO haim.deliveries(dedupe_key, message_id, phone, chat_id, body)
    VALUES (
      'human:' || msg::text, msg, haim.admin_phone(), haim.chat_for(haim.admin_phone()),
      format(E'נדרש טיפול אנושי\nטלפון: %s\nהודעת הלקוח האחרונה: %s\nנא לחזור ללקוח.', phone, left(body, 1500))
    ) RETURNING id INTO del_id;
    outbound := jsonb_build_array(jsonb_build_object('id', del_id, 'phone', haim.admin_phone(), 'chat_id', haim.chat_for(haim.admin_phone()), 'text', (SELECT body FROM haim.deliveries WHERE id = del_id), 'state', 'pending'));
    PERFORM haim.write_log('warn', 'escalation', phone, conv, NULL, p_waha_message_id, '{"reason":"human_followup"}'::jsonb);
  ELSE
    outside := haim.outside_hit(body);
    pressure := haim.pressure_line(body);
    BEGIN
      IF outside IS NOT NULL AND COALESCE(body,'') !~ '(תיקון|טעיתי)' THEN
        SELECT r.id INTO req
          FROM haim.requests r JOIN haim.request_parties p ON p.request_id = r.id
         WHERE p.phone = phone AND r.status NOT IN ('coordinated','closed','cancelled','rejected','cancel_pending')
         ORDER BY r.number DESC LIMIT 1;
        IF req IS NOT NULL THEN
          UPDATE haim.requests SET status = 'rejected', version = version + 1, updated_at = clock_timestamp() WHERE id = req;
        END IF;
        canonical := 'אנחנו פועלים רק בבית שאן, מסילות, ירדנה, בית אלפא, טירת צבי, כפר רופין ומחולה. לא נוכל לסייע בהובלה הזו.';
      ELSIF pressure IS NOT NULL THEN
        SELECT r.id INTO req
          FROM haim.requests r JOIN haim.request_parties p ON p.request_id = r.id
         WHERE p.phone = phone AND r.status NOT IN ('coordinated','closed','cancelled','rejected','human','cancel_pending')
         ORDER BY r.number DESC LIMIT 1;
        canonical := pressure || CASE WHEN req IS NOT NULL THEN E'\n' || haim.next_question(req, phone) ELSE '' END;
      ELSIF COALESCE(body,'') ~ '(לבטל|ביטול|תבטלו|תבטל|מבטל|מבטלת|לא רלוונטי)' THEN
        result := haim.exec_command(phone, body, COALESCE(p_updates->'contacts','[]'::jsonb), conv,
          jsonb_build_object('type','cancel','choice','final'), NULL);
        req := NULLIF(result->>'request_id','')::uuid;
        canonical := result->>'reply';
      ELSE
        IF kind = 'image' THEN
          INSERT INTO haim.media(message_id, mime_type, waha_message_id)
          VALUES (msg, p_updates #>> '{media,mime}', p_waha_message_id)
          ON CONFLICT (message_id) DO UPDATE SET mime_type = EXCLUDED.mime_type
          RETURNING id INTO media_id;
          SELECT count(*) INTO owned
            FROM haim.requests r
            JOIN haim.request_parties p ON p.request_id = r.id AND p.role = 'donor' AND p.phone = phone
           WHERE r.status NOT IN ('coordinated','closed','cancelled','rejected','cancel_pending');
          IF owned = 1 THEN
            SELECT r.id INTO req
              FROM haim.requests r
              JOIN haim.request_parties p ON p.request_id = r.id AND p.role = 'donor' AND p.phone = phone
             WHERE r.status NOT IN ('coordinated','closed','cancelled','rejected','cancel_pending')
             LIMIT 1;
            INSERT INTO haim.request_media(request_id, media_id, added_by) VALUES (req, media_id, contact) ON CONFLICT DO NOTHING;
            UPDATE haim.requests SET status = CASE WHEN (SELECT count(*) FROM haim.request_parties x WHERE x.request_id = req) = 1 THEN 'available' ELSE status END,
              version = version + 1, updated_at = clock_timestamp()
             WHERE id = req;
            canonical := 'תודה, התמונה התקבלה.' || E'\n' || haim.next_question(req, phone);
          ELSE
            canonical := 'תודה, התמונה התקבלה.';
          END IF;
        ELSIF kind = 'location' AND p_updates ? 'location' THEN
          req := (SELECT selected_request_id FROM haim.conversations WHERE id = conv);
          IF req IS NOT NULL THEN
            SELECT role INTO kind FROM haim.request_parties WHERE request_id = req AND haim.request_parties.phone = phone ORDER BY role LIMIT 1;
            v_loc := p_updates->'location';
            IF kind IN ('donor','receiver') THEN
              INSERT INTO haim.request_locations(request_id, role, latitude, longitude, message_id)
              VALUES (req, kind, (v_loc->>'latitude')::float8, (v_loc->>'longitude')::float8, msg)
              ON CONFLICT (request_id, role) DO UPDATE
                SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, message_id = EXCLUDED.message_id, captured_at = clock_timestamp();
            END IF;
            canonical := 'נקודת המיקום התקבלה. ' || haim.next_question(req, phone);
          ELSE
            canonical := 'נקודת המיקום התקבלה. נא לציין גם את שם היישוב אם עדיין לא נמסר.';
          END IF;
          kind := 'location';
        END IF;
        IF canonical IS NULL THEN
          SELECT reply INTO prev_reply FROM haim.messages
           WHERE conversation_id = conv AND id <> msg AND processed_at IS NOT NULL
           ORDER BY seq DESC LIMIT 1;
          FOR cmd IN SELECT * FROM jsonb_array_elements(COALESCE(p_updates->'commands', '[]'::jsonb)) LOOP
            result := haim.exec_command(phone, body, COALESCE(p_updates->'contacts','[]'::jsonb), conv, cmd, prev_reply);
            IF NULLIF(result->>'request_id','') IS NOT NULL THEN req := (result->>'request_id')::uuid; END IF;
            IF result->>'reply' IS NOT NULL THEN canonical := result->>'reply'; END IF;
            IF result ? 'notices' THEN
              FOR notice IN SELECT * FROM jsonb_array_elements(COALESCE(result->'notices','[]'::jsonb)) LOOP
                INSERT INTO haim.deliveries(dedupe_key, message_id, request_id, phone, chat_id, body)
                VALUES (notice->>'dedupe', msg, req, haim.canon_phone(notice->>'phone'), haim.chat_for(haim.canon_phone(notice->>'phone')), notice->>'body')
                ON CONFLICT (dedupe_key) DO NOTHING
                RETURNING id INTO del_id;
                IF del_id IS NOT NULL THEN
                  outbound := outbound || jsonb_build_array(jsonb_build_object('id', del_id, 'phone', notice->>'phone', 'chat_id', haim.chat_for(haim.canon_phone(notice->>'phone')), 'text', notice->>'body', 'state', 'pending'));
                  PERFORM haim.write_log('info', 'outbound', notice->>'phone', conv, req, p_waha_message_id, jsonb_build_object('dedupe', notice->>'dedupe'));
                END IF;
                del_id := NULL;
              END LOOP;
            END IF;
            IF COALESCE((result->>'escalate')::boolean, false) THEN
              UPDATE haim.conversations SET mode = 'human' WHERE id = conv;
              EXIT;
            END IF;
            IF req IS NOT NULL AND haim.photo_gate(req) AND (cmd->>'type') IS DISTINCT FROM 'details' THEN
              canonical := 'בשמחה. כדי להמשיך, נא לשלוח תמונה של הפריט.';
              EXIT;
            END IF;
          END LOOP;
        END IF;
        IF req IS NOT NULL AND canonical IS NOT NULL AND canonical NOT LIKE 'אנחנו פועלים רק%' AND canonical NOT LIKE 'לא ניתן%' AND canonical NOT LIKE 'התוכנית מסייעת%' THEN
          result := jsonb_build_object('reply', haim.sync_schedule(req, phone));
          IF result->>'reply' IS NOT NULL AND length(result->>'reply') > 0 THEN
            canonical := result->>'reply';
          ELSIF req IS NOT NULL THEN
            canonical := COALESCE(canonical, haim.next_question(req, phone));
          END IF;
        END IF;
      END IF;
      PERFORM haim.write_log('info', 'db_update', phone, conv, req, p_waha_message_id,
        jsonb_build_object('commands', COALESCE(p_updates->'commands','[]'::jsonb)));
    EXCEPTION
      WHEN SQLSTATE 'P0001' THEN
        GET STACKED DIAGNOSTICS err_code = MESSAGE_TEXT, err_detail = PG_EXCEPTION_DETAIL;
        rejected := true;
        req := NULL;
        canonical := COALESCE(err_detail, 'הבקשה לא הושלמה.');
        PERFORM haim.write_log('warn', 'rejected_update', phone, conv, NULL, p_waha_message_id,
          jsonb_build_object('code', err_code, 'message', canonical));
      WHEN SQLSTATE '23514' THEN
        rejected := true;
        req := NULL;
        canonical := 'ניתן לסייע בהובלת עד שני פריטים. שולחן וכיסאות נחשבים פריט אחד.';
        PERFORM haim.write_log('warn', 'rejected_update', phone, conv, NULL, p_waha_message_id,
          jsonb_build_object('code', 'check_violation'));
    END;

    IF canonical IS NULL OR btrim(canonical) = '' THEN
      canonical := 'לא הבנתי את הכוונה. אפשר לכתוב את זה שוב?';
    END IF;
    final_reply := haim.claim_guard(canonical, p_reply_text);
    replaced := final_reply IS DISTINCT FROM btrim(COALESCE(p_reply_text, ''));
    IF btrim(COALESCE(p_reply_text, '')) = '' THEN replaced := false; END IF;
    send_it := true;
  END IF;

  IF send_it AND final_reply IS NOT NULL THEN
    INSERT INTO haim.deliveries(dedupe_key, message_id, request_id, phone, chat_id, body)
    VALUES ('reply:' || session || ':' || p_waha_message_id, msg, req, phone, chat, final_reply)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO del_id;
    IF del_id IS NOT NULL THEN
      outbound := jsonb_build_array(jsonb_build_object('id', del_id, 'phone', phone, 'chat_id', chat, 'text', final_reply, 'state', 'pending')) || outbound;
    END IF;
    PERFORM haim.write_log('info', 'outbound', phone, conv, req, p_waha_message_id,
      jsonb_build_object('reply', left(final_reply, 500), 'replaced', replaced));
  END IF;

  UPDATE haim.messages
     SET processed_at = clock_timestamp(),
         reply = final_reply,
         error_code = CASE WHEN rejected THEN COALESCE(err_code, 'rejected') ELSE NULL END,
         turn_result = jsonb_build_object(
           'ok', true,
           'duplicate', false,
           'send', send_it,
           'rejected', rejected,
           'message_id', msg,
           'conversation_id', conv,
           'request_id', req,
           'reply_text', final_reply,
           'canonical_reply', canonical,
           'reply_replaced', replaced,
           'chat_id', chat,
           'outbound', outbound
         )
   WHERE id = msg;
  UPDATE haim.conversations SET version = version + 1 WHERE id = conv;
  IF final_reply LIKE '%בבניין עם קומות%' AND req IS NOT NULL THEN
    UPDATE haim.request_parties SET floor_note_shown = true WHERE request_id = req AND haim.request_parties.phone = phone;
  END IF;
  RETURN (SELECT turn_result FROM haim.messages WHERE id = msg) || jsonb_build_object('context', haim_get_context(phone));
END $$;

CREATE OR REPLACE FUNCTION public.haim_mark_delivery(
  p_id uuid,
  p_state text,
  p_provider_id text DEFAULT NULL,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  cur haim.delivery_state;
BEGIN
  SELECT state INTO cur FROM haim.deliveries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM haim.fail('delivery_not_found', 'משלוח ההודעה לא נמצא.');
  END IF;
  IF cur IN ('sent','cancelled') THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'state', cur);
  END IF;
  IF cur = 'uncertain' AND p_state = 'sent' THEN
    PERFORM haim.fail('uncertain_not_resendable', 'השליחה לא ודאית. אין לשלוח שוב בלי בדיקה ידנית.');
  END IF;
  IF p_state NOT IN ('pending','sending','sent','uncertain','failed','cancelled') THEN
    PERFORM haim.fail('bad_delivery_state', 'מצב שליחה לא תקין.');
  END IF;
  UPDATE haim.deliveries
     SET state = p_state::haim.delivery_state,
         provider_id = COALESCE(p_provider_id, provider_id),
         error_code = p_error,
         sent_at = CASE WHEN p_state = 'sent' THEN clock_timestamp() ELSE sent_at END
   WHERE id = p_id;
  PERFORM haim.write_log(
    CASE WHEN p_state IN ('failed','uncertain') THEN 'error' ELSE 'info' END,
    'outbound', NULL, NULL, NULL, NULL,
    jsonb_build_object('delivery_id', p_id, 'state', p_state, 'provider_id', p_provider_id, 'error', p_error)
  );
  RETURN jsonb_build_object('ok', true, 'state', p_state);
END $$;

CREATE OR REPLACE FUNCTION public.haim_reset(p_phone text) RETURNS jsonb
LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE
  phone text;
  n int := 0;
  conv uuid;
BEGIN
  phone := haim.canon_phone(p_phone);
  FOR conv IN
    SELECT c.id FROM haim.conversations c JOIN haim.contacts co ON co.id = c.contact_id WHERE co.phone = phone
  LOOP
    INSERT INTO haim.conversation_resets(conversation_id, reset_at)
    VALUES (conv, clock_timestamp())
    ON CONFLICT (conversation_id) DO UPDATE SET reset_at = EXCLUDED.reset_at;
    UPDATE haim.conversations
       SET mode = 'bot', selected_request_id = NULL, pending_counterparty_name = NULL,
           pending_counterparty_phone = NULL, version = version + 1
     WHERE id = conv;
    n := n + 1;
  END LOOP;
  PERFORM haim.write_log('warn', 'db_update', phone, conv, NULL, NULL, jsonb_build_object('action', 'reset', 'conversations', n));
  RETURN jsonb_build_object('ok', true, 'phone', phone, 'conversations', n);
END $$;

CREATE OR REPLACE FUNCTION public.haim_cancel_phone(p_phone text, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE
  phone text;
  deleted int := 0;
BEGIN
  IF p_confirm IS DISTINCT FROM 'בטל פניות' THEN
    PERFORM haim.fail('confirm_required', 'יש לאשר במדויק: בטל פניות');
  END IF;
  phone := haim.canon_phone(p_phone);
  PERFORM haim.write_log('warn', 'db_update', phone, NULL, NULL, NULL, jsonb_build_object('action', 'cancel_phone'));
  DELETE FROM haim.requests r
   WHERE r.id IN (SELECT request_id FROM haim.request_parties rp WHERE rp.phone = phone);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM haim_reset(phone);
  DELETE FROM haim.messages m USING haim.contacts c
   WHERE m.contact_id = c.id AND c.phone = phone;
  RETURN jsonb_build_object('ok', true, 'phone', phone, 'deleted_requests', deleted);
END $$;

CREATE OR REPLACE FUNCTION public.haim_clear_all(p_confirm text) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  IF p_confirm IS DISTINCT FROM 'מחק הכל' THEN
    PERFORM haim.fail('confirm_required', 'יש לאשר במדויק: מחק הכל');
  END IF;
  DELETE FROM haim.deliveries;
  DELETE FROM haim.transport_capacity_approvals;
  DELETE FROM haim.request_events;
  DELETE FROM haim.request_verifications;
  DELETE FROM haim.request_media;
  DELETE FROM haim.request_locations;
  DELETE FROM haim.matches;
  DELETE FROM haim.request_parties;
  DELETE FROM haim.request_items;
  UPDATE haim.conversations SET selected_request_id = NULL;
  DELETE FROM haim.requests;
  DELETE FROM haim.media;
  DELETE FROM haim.messages;
  DELETE FROM haim.conversation_resets;
  DELETE FROM haim.conversations;
  DELETE FROM haim.contact_identities;
  DELETE FROM haim.searches;
  DELETE FROM haim.contacts;
  DELETE FROM haim.logs;
  UPDATE haim.request_counter SET value = 0 WHERE id = true;
  UPDATE haim.transport_runs SET capacity = 10 WHERE status = 'open';
  PERFORM haim.write_log('warn', 'db_update', NULL, NULL, NULL, NULL, '{"action":"clear_all"}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'cleared', true);
END $$;

CREATE OR REPLACE FUNCTION public.haim_set_access(p_mode text, p_phones jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  phones jsonb := '[]'::jsonb;
  raw text;
  canon text;
BEGIN
  IF p_mode NOT IN ('open','allowlist') THEN
    PERFORM haim.fail('bad_access_mode', 'מצב הגישה חייב להיות open או allowlist.');
  END IF;
  FOR raw IN SELECT jsonb_array_elements_text(COALESCE(p_phones, '[]'::jsonb)) LOOP
    canon := haim.canon_phone(raw);
    phones := phones || to_jsonb(canon);
  END LOOP;
  INSERT INTO haim.app_settings(key, value)
  VALUES ('bot_access', jsonb_build_object('mode', p_mode, 'phones', phones))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
  PERFORM haim.write_log('info', 'db_update', NULL, NULL, NULL, NULL, jsonb_build_object('action', 'set_access', 'mode', p_mode));
  RETURN jsonb_build_object('ok', true, 'mode', p_mode, 'phones', phones);
END $$;
