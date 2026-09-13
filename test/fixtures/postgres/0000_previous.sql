CREATE SCHEMA sms_kit;
CREATE TABLE sms_kit.schema_migration (
  version bigint PRIMARY KEY CHECK (version > 0),
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
);

CREATE TABLE sms_kit.provider_config (
  id smallint PRIMARY KEY CHECK (id = 1),
  provider text NOT NULL CHECK (provider = 'aliyun'),
  region text NOT NULL,
  endpoint text,
  access_key_id_ref text NOT NULL,
  access_key_secret_ref text NOT NULL,
  receipt_callback_token_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('unconfigured', 'untested', 'ready', 'degraded', 'disabled')),
  enabled boolean NOT NULL DEFAULT false,
  last_test_status text NOT NULL CHECK (last_test_status IN ('never', 'succeeded', 'failed')),
  last_test_summary jsonb,
  last_tested_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE sms_kit.signature (
  id uuid PRIMARY KEY,
  external_key text NOT NULL UNIQUE,
  external_name text NOT NULL,
  external_status text NOT NULL,
  external_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  imported_at timestamptz NOT NULL,
  last_synced_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (external_name, external_type)
);
CREATE INDEX signature_enabled_external_status_idx ON sms_kit.signature (enabled, external_status);

CREATE TABLE sms_kit.template (
  id uuid PRIMARY KEY,
  signature_id uuid NOT NULL REFERENCES sms_kit.signature(id),
  template_key text NOT NULL UNIQUE CHECK (template_key ~ '^[a-z0-9._-]+$'),
  external_code text NOT NULL UNIQUE,
  external_name text NOT NULL,
  external_status text NOT NULL,
  template_type text NOT NULL CHECK (template_type IN ('verification', 'notification')),
  purpose text NOT NULL,
  content_snapshot text NOT NULL,
  variable_schema jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  imported_at timestamptz NOT NULL,
  last_synced_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX template_enabled_external_status_idx ON sms_kit.template (enabled, external_status);
CREATE INDEX template_purpose_idx ON sms_kit.template (purpose);

CREATE TABLE sms_kit.resource_sync (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  provider_request_id text,
  summary jsonb NOT NULL,
  error_code text,
  expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX resource_sync_started_at_idx ON sms_kit.resource_sync (started_at DESC);
CREATE INDEX resource_sync_status_started_at_idx ON sms_kit.resource_sync (status, started_at DESC);

CREATE TABLE sms_kit.resource_sync_candidate (
  id uuid PRIMARY KEY,
  sync_id uuid NOT NULL REFERENCES sms_kit.resource_sync(id),
  resource_type text NOT NULL CHECK (resource_type IN ('signature', 'template')),
  external_key text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('new', 'changed', 'unavailable', 'unchanged')),
  snapshot jsonb NOT NULL,
  checksum text NOT NULL,
  expires_at timestamptz NOT NULL,
  committed_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (sync_id, resource_type, external_key)
);
CREATE INDEX resource_sync_candidate_sync_change_idx ON sms_kit.resource_sync_candidate (sync_id, change_type);
CREATE INDEX resource_sync_candidate_expires_at_idx ON sms_kit.resource_sync_candidate (expires_at);

CREATE TABLE sms_kit.send_message (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  template_id uuid NOT NULL REFERENCES sms_kit.template(id),
  template_key_snapshot text NOT NULL,
  external_template_code_snapshot text NOT NULL,
  signature_name_snapshot text NOT NULL,
  purpose text NOT NULL,
  phone_ciphertext text,
  phone_hash text,
  phone_last4 char(4),
  phone_masked text,
  variable_names jsonb NOT NULL,
  render_params_ciphertext text,
  render_params_key_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  acceptance_status text NOT NULL CHECK (acceptance_status IN ('pending', 'accepted', 'rejected', 'unknown')),
  delivery_status text NOT NULL CHECK (delivery_status IN ('not_applicable', 'waiting', 'delivered', 'failed', 'unknown_final')),
  provider_biz_id text,
  provider_request_id text,
  final_error_code text,
  submitted_at timestamptz NOT NULL,
  accepted_at timestamptz,
  delivered_at timestamptz,
  finalized_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX send_message_provider_biz_id_idx ON sms_kit.send_message (provider_biz_id);
CREATE INDEX send_message_tenant_submitted_idx ON sms_kit.send_message (tenant_id, submitted_at DESC);
CREATE INDEX send_message_tenant_template_submitted_idx ON sms_kit.send_message (tenant_id, template_id, submitted_at DESC);
CREATE INDEX send_message_tenant_purpose_submitted_idx ON sms_kit.send_message (tenant_id, purpose, submitted_at DESC);
CREATE INDEX send_message_tenant_acceptance_submitted_idx ON sms_kit.send_message (tenant_id, acceptance_status, submitted_at);
CREATE INDEX send_message_tenant_delivery_submitted_idx ON sms_kit.send_message (tenant_id, delivery_status, submitted_at);
CREATE INDEX send_message_tenant_phone_hash_submitted_idx ON sms_kit.send_message (tenant_id, phone_hash, submitted_at DESC);

CREATE TABLE sms_kit.send_attempt (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES sms_kit.send_message(id),
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  status text NOT NULL CHECK (status IN ('started', 'accepted', 'rejected', 'unknown')),
  provider_request_id text,
  provider_code text,
  error_code text,
  latency_ms integer CHECK (latency_ms >= 0),
  occurred_at timestamptz NOT NULL,
  UNIQUE (message_id, attempt_no)
);
CREATE INDEX send_attempt_status_occurred_at_idx ON sms_kit.send_attempt (status, occurred_at);
CREATE INDEX send_attempt_occurred_at_idx ON sms_kit.send_attempt (occurred_at DESC);

CREATE TABLE sms_kit.delivery_receipt (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES sms_kit.send_message(id),
  dedupe_key text NOT NULL UNIQUE,
  provider_biz_id text NOT NULL,
  delivery_status text NOT NULL CHECK (delivery_status IN ('delivered', 'failed')),
  provider_code text,
  provider_message text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('callback', 'query')),
  redacted_payload jsonb
);
CREATE INDEX delivery_receipt_provider_biz_id_idx ON sms_kit.delivery_receipt (provider_biz_id);
CREATE INDEX delivery_receipt_message_occurred_at_idx ON sms_kit.delivery_receipt (message_id, occurred_at);

CREATE TABLE sms_kit.send_job (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  dedupe_key text NOT NULL,
  job_type text NOT NULL CHECK (job_type IN ('send', 'dispatch_recovery', 'reconcile', 'retention', 'rollup')),
  message_id uuid REFERENCES sms_kit.send_message(id),
  state text NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'failed', 'dead')),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  last_error_code text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, job_type, dedupe_key)
);
CREATE INDEX send_job_state_available_idx ON sms_kit.send_job (state, available_at);
CREATE INDEX send_job_tenant_state_available_idx ON sms_kit.send_job (tenant_id, state, available_at);
CREATE INDEX send_job_pending_available_idx ON sms_kit.send_job (available_at) WHERE state = 'pending';

CREATE TABLE sms_kit.otp_challenge (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  action text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('password_change', 'step_up')),
  phone_hash text NOT NULL,
  code_hash text NOT NULL,
  proof_hash text,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  proof_expires_at timestamptz,
  consumed_at timestamptz,
  consumed_by_key text,
  created_at timestamptz NOT NULL
);
CREATE INDEX otp_challenge_tenant_subject_action_created_idx ON sms_kit.otp_challenge (tenant_id, subject_id, action, created_at DESC);
CREATE INDEX otp_challenge_tenant_expires_idx ON sms_kit.otp_challenge (tenant_id, expires_at);

CREATE TABLE sms_kit.rate_limit_bucket (
  tenant_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('phone_purpose', 'ip_purpose', 'global')),
  scope_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  count integer NOT NULL CHECK (count >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope, scope_hash, window_start, window_seconds)
);
CREATE INDEX rate_limit_bucket_expires_at_idx ON sms_kit.rate_limit_bucket (expires_at);

CREATE TABLE sms_kit.audit_event (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  result text NOT NULL CHECK (result IN ('succeeded', 'failed', 'denied')),
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX audit_event_tenant_occurred_idx ON sms_kit.audit_event (tenant_id, occurred_at DESC);
CREATE INDEX audit_event_tenant_actor_occurred_idx ON sms_kit.audit_event (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX audit_event_tenant_action_occurred_idx ON sms_kit.audit_event (tenant_id, action, occurred_at DESC);

CREATE TABLE sms_kit.daily_stat (
  stat_date date NOT NULL,
  tenant_id text NOT NULL,
  template_id uuid,
  template_key text NOT NULL,
  purpose text NOT NULL,
  submitted_count bigint NOT NULL DEFAULT 0 CHECK (submitted_count >= 0),
  accepted_count bigint NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  delivered_count bigint NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  delivery_failed_count bigint NOT NULL DEFAULT 0 CHECK (delivery_failed_count >= 0),
  retry_count bigint NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, stat_date, template_key, purpose)
);

CREATE TABLE sms_kit.stat_dirty_date (
  tenant_id text NOT NULL,
  stat_date date NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, stat_date)
);

INSERT INTO sms_kit.schema_migration (version, name, checksum, applied_at)
VALUES (1, '0001_initial.sql', 'db6a741380771e92690823c4c4556449b97b5bdc1d813f08ec786bef251d67ea', TIMESTAMPTZ '2026-09-13 00:00:00+00');

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

INSERT INTO sms_kit.schema_migration (version, name, checksum, applied_at)
VALUES (2, '0002_reliability_policy.sql', '2e50eb57308d28d0a0b08cbf5c4b66ad522ea97e8b7ac7c21b854e8c83975c06', TIMESTAMPTZ '2026-09-13 00:01:00+00');
