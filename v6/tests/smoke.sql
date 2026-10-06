-- Local smoke test for haim-v6. Expects migrations 001-003 already applied.
-- Exits 0 only when every check passes. Leaves a few rows for the admin UI.
\set ON_ERROR_STOP on

SELECT public.haim_clear_all('מחק הכל') AS cleared;

DO $$
BEGIN
  PERFORM public.haim_clear_all('מחק');
  RAISE EXCEPTION 'clear_all accepted a wrong phrase';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM IS DISTINCT FROM 'confirm_required' THEN
    RAISE EXCEPTION 'unexpected clear_all error %', SQLERRM;
  END IF;
END $$;

DO $$
BEGIN
  PERFORM public.haim_cancel_phone('0521111111', 'בטל');
  RAISE EXCEPTION 'cancel accepted a wrong phrase';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM IS DISTINCT FROM 'confirm_required' THEN
    RAISE EXCEPTION 'unexpected cancel error %', SQLERRM;
  END IF;
END $$;

-- Ingest does not create a request. A later apply of the same WAHA id does.
DO $$
DECLARE
  a jsonb;
  b jsonb;
  n int;
BEGIN
  a := public.haim_apply_turn(
    'm-ingest', '0521111111',
    jsonb_build_object('phase','ingest','text','אני רוצה למסור ספה','kind','text','session','HAIM_V6'),
    NULL
  );
  IF COALESCE((a->>'ingested')::boolean, false) IS NOT TRUE
     OR COALESCE((a->>'send')::boolean, false) IS NOT FALSE THEN
    RAISE EXCEPTION 'ingest result %', a;
  END IF;
  SELECT count(*) INTO n FROM haim.requests;
  IF n <> 0 THEN RAISE EXCEPTION 'ingest created % requests', n; END IF;

  b := public.haim_apply_turn(
    'm-ingest', '0521111111',
    jsonb_build_object(
      'phase','full','text','אני רוצה למסור ספה','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object(
        'type','donate',
        'items', jsonb_build_array(jsonb_build_object('kind','sofa','description','ספה','quantity',1))
      ))
    ),
    NULL
  );
  IF COALESCE((b->>'duplicate')::boolean, false) THEN
    RAISE EXCEPTION 'apply after ingest was duplicate %', b;
  END IF;
  IF COALESCE((b->>'send')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'apply did not send %', b;
  END IF;
  IF position('תמונה' IN COALESCE(b->>'reply_text','')) = 0 THEN
    RAISE EXCEPTION 'photo-first missing: %', b->>'reply_text';
  END IF;
  SELECT count(*) INTO n FROM haim.requests;
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 request, got %', n; END IF;
END $$;

DO $$
DECLARE
  b jsonb;
  n int;
BEGIN
  b := public.haim_apply_turn(
    'm-ingest', '0521111111',
    jsonb_build_object('text','אני רוצה למסור ספה','kind','text','session','HAIM_V6','commands','[]'::jsonb),
    NULL
  );
  IF COALESCE((b->>'duplicate')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'expected duplicate, got %', b;
  END IF;
  SELECT count(*) INTO n FROM haim.requests;
  IF n <> 1 THEN RAISE EXCEPTION 'duplicate created requests: %', n; END IF;
END $$;

DO $$
DECLARE
  b jsonb;
  n int;
BEGIN
  b := public.haim_apply_turn(
    'm-piano', '0525555555',
    jsonb_build_object(
      'text','אני רוצה למסור פסנתר','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object(
        'type','donate',
        'items', jsonb_build_array(jsonb_build_object('kind','piano','description','פסנתר','quantity',1))
      ))
    ),
    NULL
  );
  IF position('פסנתר' IN COALESCE(b->>'reply_text','')) = 0 THEN
    RAISE EXCEPTION 'piano reply %', b->>'reply_text';
  END IF;
  IF COALESCE((b->>'rejected')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'piano should be rejected %', b;
  END IF;
  SELECT count(*) INTO n FROM haim.requests r
    JOIN haim.request_parties p ON p.request_id = r.id
   WHERE p.phone = '525555555';
  IF n <> 0 THEN RAISE EXCEPTION 'piano created a request'; END IF;
END $$;

DO $$
DECLARE
  b jsonb;
  n int;
BEGIN
  b := public.haim_apply_turn(
    'm-three', '0525555556',
    jsonb_build_object(
      'text','אני רוצה למסור מיטה ספה ומקרר','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object(
        'type','donate',
        'items', jsonb_build_array(
          jsonb_build_object('kind','bed','description','מיטה','quantity',1),
          jsonb_build_object('kind','sofa','description','ספה','quantity',1),
          jsonb_build_object('kind','fridge','description','מקרר','quantity',1)
        )
      ))
    ),
    NULL
  );
  IF position('שני פריטים' IN COALESCE(b->>'reply_text','')) = 0 THEN
    RAISE EXCEPTION 'three-item reply %', b->>'reply_text';
  END IF;
  SELECT count(*) INTO n FROM haim.request_parties WHERE phone = '525555556';
  IF n <> 0 THEN RAISE EXCEPTION 'three items created a party'; END IF;
END $$;

DO $$
DECLARE
  b jsonb;
  st text;
BEGIN
  PERFORM public.haim_apply_turn(
    'm-out-open', '0525555557',
    jsonb_build_object(
      'text','אני רוצה למסור מיטה','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object(
        'type','donate',
        'items', jsonb_build_array(jsonb_build_object('kind','bed','description','מיטה','quantity',1))
      ))
    ),
    NULL
  );
  b := public.haim_apply_turn(
    'm-out', '0525555557',
    jsonb_build_object('text','אני גר בעפולה','kind','text','session','HAIM_V6','commands','[]'::jsonb),
    NULL
  );
  IF position('לא נוכל לסייע' IN COALESCE(b->>'reply_text','')) = 0 THEN
    RAISE EXCEPTION 'outside reply %', b->>'reply_text';
  END IF;
  SELECT status INTO st FROM haim.requests r
    JOIN haim.request_parties p ON p.request_id = r.id
   WHERE p.phone = '525555557';
  IF st IS DISTINCT FROM 'rejected' THEN RAISE EXCEPTION 'outside status %', st; END IF;
END $$;

DO $$
DECLARE
  b jsonb;
  origin text;
  parties int;
BEGIN
  b := public.haim_apply_turn(
    'm-direct', '0522222222',
    jsonb_build_object(
      'text','אני רוצה למסור ספה לטל 0523333333','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object(
        'type','donate','direct', true, 'counterparty_phone','0523333333','counterparty_name','טל',
        'items', jsonb_build_array(jsonb_build_object('kind','sofa','description','ספה','quantity',1))
      ))
    ),
    NULL
  );
  IF position('למקבל' IN COALESCE(b->>'reply_text','')) = 0 THEN
    RAISE EXCEPTION 'direct reply %', b->>'reply_text';
  END IF;
  SELECT r.origin, (SELECT count(*) FROM haim.request_parties p WHERE p.request_id = r.id)
    INTO origin, parties
    FROM haim.requests r WHERE r.id = (b->>'request_id')::uuid;
  IF origin IS DISTINCT FROM 'direct' OR parties <> 2 THEN
    RAISE EXCEPTION 'direct shape origin=% parties=%', origin, parties;
  END IF;
END $$;

DO $$
DECLARE b jsonb;
BEGIN
  b := public.haim_apply_turn(
    'm-bare', '0522222222',
    jsonb_build_object(
      'text','כן','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object('type','approve_self'))
    ),
    NULL
  );
  IF position('במפורש' IN COALESCE(b->>'reply_text','')) = 0 THEN
    RAISE EXCEPTION 'bare yes reply %', b->>'reply_text';
  END IF;
  IF COALESCE((b->>'rejected')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'bare yes should reject %', b;
  END IF;
END $$;

DO $$
DECLARE b jsonb;
BEGIN
  b := public.haim_apply_turn(
    'm-yes', '0522222222',
    jsonb_build_object(
      'text','מאשר את חלקי','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object('type','approve_self'))
    ),
    NULL
  );
  IF COALESCE((b->>'rejected')::boolean, false) THEN
    RAISE EXCEPTION 'explicit approval rejected %', b->>'reply_text';
  END IF;
END $$;

DO $$
DECLARE b jsonb;
BEGIN
  b := public.haim_apply_turn(
    'm-claim', '0521111111',
    jsonb_build_object(
      'text','שלחתי את זה','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object('type','next'))
    ),
    'שלחתי את זה'
  );
  IF COALESCE(b->>'reply_text','') IS DISTINCT FROM 'בשמחה. כדי להמשיך, נא לשלוח תמונה של הפריט.' THEN
    RAISE EXCEPTION 'claim guard reply %', b->>'reply_text';
  END IF;
  IF COALESCE((b->>'reply_replaced')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'claim guard did not replace';
  END IF;
END $$;

DO $$
DECLARE
  created jsonb;
  cancelled jsonb;
  left_n int;
BEGIN
  created := public.haim_apply_turn(
    'm-cancel-src', '0524444444',
    jsonb_build_object(
      'text','אני רוצה למסור כיסא','kind','text','session','HAIM_V6',
      'commands', jsonb_build_array(jsonb_build_object(
        'type','donate',
        'items', jsonb_build_array(jsonb_build_object('kind','other','description','כיסא','quantity',1))
      ))
    ),
    NULL
  );
  IF created->>'request_id' IS NULL THEN RAISE EXCEPTION 'cancel fixture missing request'; END IF;
  cancelled := public.haim_cancel_phone('0524444444', 'בטל פניות');
  IF (cancelled->>'deleted_requests')::int <> 1 THEN
    RAISE EXCEPTION 'cancel deleted %', cancelled;
  END IF;
  SELECT count(*) INTO left_n FROM haim.request_parties WHERE phone = '521111111';
  IF left_n < 1 THEN RAISE EXCEPTION 'cancel removed the other phone'; END IF;
END $$;

DO $$
DECLARE r jsonb; mode text;
BEGIN
  r := public.haim_reset('0521111111');
  IF (r->>'conversations')::int < 1 THEN RAISE EXCEPTION 'reset %', r; END IF;
  SELECT c.mode INTO mode
    FROM haim.conversations c JOIN haim.contacts co ON co.id = c.contact_id
   WHERE co.phone = '521111111';
  IF mode IS DISTINCT FROM 'bot' THEN RAISE EXCEPTION 'mode %', mode; END IF;
END $$;

DO $$
BEGIN
  INSERT INTO haim.transport_runs(run_date, capacity) VALUES (DATE '2026-10-07', 10);
  RAISE EXCEPTION 'wednesday run was accepted';
EXCEPTION WHEN check_violation THEN
  NULL;
END $$;

DO $$
DECLARE
  id uuid;
  marked jsonb;
BEGIN
  SELECT d.id INTO id FROM haim.deliveries d WHERE d.state = 'pending' ORDER BY d.created_at LIMIT 1;
  IF id IS NULL THEN RAISE EXCEPTION 'no pending delivery'; END IF;
  PERFORM public.haim_mark_delivery(id, 'sending', NULL, NULL);
  marked := public.haim_mark_delivery(id, 'uncertain', NULL, 'timeout');
  IF marked->>'state' IS DISTINCT FROM 'uncertain' THEN RAISE EXCEPTION 'mark %', marked; END IF;
  BEGIN
    PERFORM public.haim_mark_delivery(id, 'sent', 'prov-1', NULL);
    RAISE EXCEPTION 'uncertain became sent';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM IS DISTINCT FROM 'uncertain_not_resendable' THEN
      RAISE EXCEPTION 'unexpected mark error %', SQLERRM;
    END IF;
  END;
END $$;

DO $$
DECLARE ctx jsonb; n bigint;
BEGIN
  ctx := public.haim_get_context('0521111111');
  IF ctx->>'phone' IS DISTINCT FROM '521111111' THEN RAISE EXCEPTION 'context %', ctx->>'phone'; END IF;
  IF ctx->>'is_admin' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'admin flag'; END IF;
  n := public.haim_log('info','agent_note','521111111','{"step":"smoke"}'::jsonb, NULL, NULL, 'm-ingest');
  IF n IS NULL THEN RAISE EXCEPTION 'haim_log returned null'; END IF;
END $$;

DO $$
DECLARE b jsonb;
BEGIN
  PERFORM public.haim_set_access('allowlist', '["0521111111"]'::jsonb);
  b := public.haim_apply_turn(
    'm-deny', '0526666666',
    jsonb_build_object('text','שלום','kind','text','session','HAIM_V6','commands','[]'::jsonb),
    'שלום'
  );
  IF b->>'error' IS DISTINCT FROM 'access_denied' OR COALESCE((b->>'send')::boolean, false) THEN
    RAISE EXCEPTION 'allowlist %', b;
  END IF;
  PERFORM public.haim_set_access('open', '[]'::jsonb);
END $$;

-- Row kept so the admin phone view has something to cancel in the browser.
SELECT public.haim_apply_turn(
  'm-ui-cancel', '0529999999',
  jsonb_build_object(
    'text','אני רוצה למסור מנורה','kind','text','session','HAIM_V6',
    'commands', jsonb_build_array(jsonb_build_object(
      'type','donate',
      'items', jsonb_build_array(jsonb_build_object('kind','other','description','מנורה','quantity',1))
    ))
  ),
  NULL
) AS ui_cancel_fixture;

SELECT 'smoke_ok' AS result,
  (SELECT count(*) FROM haim.requests) AS requests,
  (SELECT count(*) FROM haim.logs) AS logs,
  (SELECT count(*) FROM haim.streets) AS streets;
