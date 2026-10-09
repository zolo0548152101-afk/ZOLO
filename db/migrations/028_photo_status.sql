ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS photo_status text NOT NULL DEFAULT 'לא בוקשה'
  CHECK (photo_status IN ('לא בוקשה', 'בוקשה', 'אין תמונה', 'התקבלה'));
