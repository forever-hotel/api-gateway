-- Apply manually in Neon BEFORE using email password recovery.
-- No application startup runs this SQL. Existing account data is preserved.
BEGIN;
CREATE TABLE IF NOT EXISTS public.gateway_password_resets (
  worker_id uuid PRIMARY KEY REFERENCES public.staff_users(worker_id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL,
  code_hash char(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  credential_version integer NOT NULL CHECK (credential_version >= 0),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
REVOKE ALL ON public.gateway_password_resets FROM PUBLIC;
-- If the gateway uses a different runtime DB role, grant it SELECT, INSERT,
-- UPDATE and DELETE on this table. Never grant access to public/anonymous roles.
COMMIT;
