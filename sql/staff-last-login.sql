-- Manual owner execution before deploying staff last-login recording.
-- No startup migration. Existing accounts remain NULL until their next successful login.
BEGIN;
SET LOCAL lock_timeout = '15s';
ALTER TABLE public.staff_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_auth') THEN
    GRANT UPDATE(last_login_at) ON public.staff_users TO hotel_auth;
  END IF;
END $$;
COMMIT;
