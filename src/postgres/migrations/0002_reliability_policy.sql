ALTER TABLE sms_kit.send_message ADD COLUMN phone_key_id text;

ALTER TABLE sms_kit.send_attempt
  ADD COLUMN dispatch_mode text NOT NULL DEFAULT 'direct',
  ADD COLUMN dispatch_token uuid,
  ADD COLUMN lease_token uuid,
  ADD COLUMN dispatch_marked_at timestamptz;
UPDATE sms_kit.send_attempt
   SET dispatch_token = id,
       dispatch_marked_at = occurred_at
 WHERE dispatch_token IS NULL;
ALTER TABLE sms_kit.send_attempt
  ALTER COLUMN dispatch_token SET NOT NULL,
  ALTER COLUMN dispatch_marked_at SET NOT NULL,
  ADD CONSTRAINT send_attempt_dispatch_mode_value_check CHECK (dispatch_mode IN ('direct', 'queued')),
  ADD CONSTRAINT send_attempt_dispatch_mode_check CHECK (
    (dispatch_mode = 'direct' AND lease_token IS NULL) OR
    (dispatch_mode = 'queued' AND lease_token IS NOT NULL)
  ),
  ADD CONSTRAINT send_attempt_dispatch_token_key UNIQUE (dispatch_token);
CREATE UNIQUE INDEX send_attempt_one_started_per_message_idx
  ON sms_kit.send_attempt (message_id) WHERE status = 'started';
CREATE INDEX send_attempt_status_dispatch_marked_at_idx
  ON sms_kit.send_attempt (status, dispatch_marked_at);

ALTER TABLE sms_kit.delivery_receipt
  ALTER COLUMN message_id DROP NOT NULL,
  ADD COLUMN match_status text NOT NULL DEFAULT 'matched';
ALTER TABLE sms_kit.delivery_receipt
  ADD CONSTRAINT delivery_receipt_match_status_check CHECK (
    (match_status = 'matched' AND message_id IS NOT NULL) OR
    (match_status = 'unmatched' AND message_id IS NULL)
  );
CREATE INDEX delivery_receipt_match_status_received_at_idx
  ON sms_kit.delivery_receipt (match_status, received_at);

ALTER TABLE sms_kit.send_job
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE sms_kit.send_job
  ADD CONSTRAINT send_job_lease_state_check CHECK (
    (state = 'pending' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL) OR
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
    (state IN ('succeeded', 'failed', 'dead'))
  );

ALTER TABLE sms_kit.daily_stat
  ADD COLUMN acceptance_rejected_count bigint NOT NULL DEFAULT 0 CHECK (acceptance_rejected_count >= 0),
  ADD COLUMN acceptance_unknown_count bigint NOT NULL DEFAULT 0 CHECK (acceptance_unknown_count >= 0),
  ADD COLUMN delivery_waiting_count bigint NOT NULL DEFAULT 0 CHECK (delivery_waiting_count >= 0),
  ADD COLUMN delivery_unknown_final_count bigint NOT NULL DEFAULT 0 CHECK (delivery_unknown_final_count >= 0);

CREATE TABLE sms_kit.policy_config (
  id smallint PRIMARY KEY CHECK (id = 1),
  otp_length smallint NOT NULL DEFAULT 6 CHECK (otp_length BETWEEN 4 AND 8),
  otp_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (otp_ttl_seconds BETWEEN 60 AND 900),
  otp_max_attempts smallint NOT NULL DEFAULT 3 CHECK (otp_max_attempts BETWEEN 1 AND 10),
  proof_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (proof_ttl_seconds BETWEEN 30 AND 900),
  phone_min_interval_seconds integer NOT NULL DEFAULT 60 CHECK (phone_min_interval_seconds BETWEEN 1 AND 3600),
  phone_hourly_limit integer NOT NULL DEFAULT 5 CHECK (phone_hourly_limit > 0),
  phone_daily_limit integer NOT NULL DEFAULT 10 CHECK (phone_daily_limit >= phone_hourly_limit),
  ip_window_seconds integer NOT NULL DEFAULT 600 CHECK (ip_window_seconds BETWEEN 60 AND 86400),
  ip_window_limit integer NOT NULL DEFAULT 20 CHECK (ip_window_limit > 0),
  system_daily_budget integer CHECK (system_daily_budget > 0),
  circuit_open boolean NOT NULL DEFAULT false,
  circuit_reason text,
  circuit_opened_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT policy_config_circuit_open_check CHECK (
    (circuit_open AND circuit_opened_at IS NOT NULL) OR
    (NOT circuit_open AND circuit_opened_at IS NULL)
  )
);

CREATE TABLE sms_kit.daily_send_budget (
  budget_date date PRIMARY KEY,
  held_count bigint NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE sms_kit.send_budget_reservation (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE REFERENCES sms_kit.send_message(id),
  budget_date date NOT NULL REFERENCES sms_kit.daily_send_budget(budget_date),
  state text NOT NULL CHECK (state IN ('held', 'released')),
  held_at timestamptz NOT NULL,
  released_at timestamptz,
  CONSTRAINT send_budget_reservation_released_at_check CHECK (
    (state = 'held' AND released_at IS NULL) OR
    (state = 'released' AND released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX otp_challenge_proof_hash_key
  ON sms_kit.otp_challenge (proof_hash) WHERE proof_hash IS NOT NULL;
