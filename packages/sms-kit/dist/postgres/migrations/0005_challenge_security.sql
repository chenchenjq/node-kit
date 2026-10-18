ALTER TABLE sms_kit.otp_challenge
  ADD COLUMN idempotency_key text NOT NULL DEFAULT ('legacy:' || gen_random_uuid()::text),
  ADD COLUMN policy_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN otp_length smallint NOT NULL DEFAULT 6 CHECK (otp_length BETWEEN 4 AND 8),
  ADD COLUMN otp_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (otp_ttl_seconds BETWEEN 60 AND 900),
  ADD COLUMN proof_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (proof_ttl_seconds BETWEEN 30 AND 900),
  ADD COLUMN invalidated_at timestamptz,
  ADD COLUMN terminal_error_code text CHECK (terminal_error_code IN ('PROVIDER_REJECTED', 'ACCEPTANCE_UNKNOWN'));

ALTER TABLE sms_kit.otp_challenge
  ADD CONSTRAINT otp_challenge_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  ADD CONSTRAINT otp_challenge_terminal_state_check CHECK (
    (invalidated_at IS NULL AND terminal_error_code IS NULL) OR
    (invalidated_at IS NOT NULL AND terminal_error_code IS NOT NULL)
  );
