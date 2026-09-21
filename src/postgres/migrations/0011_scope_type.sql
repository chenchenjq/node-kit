-- A SYSTEM record has no tenant.  `scope_type` makes that intentional and
-- prevents a nullable tenant column from weakening the ownership boundary.
-- Existing package versions represented SYSTEM with the private sentinel
-- `__system__`; normalize it during the forward-only upgrade.

-- The old authorization table has composite tenant foreign keys.  Convert it
-- before normalizing system jobs, otherwise the nullable SYSTEM identity
-- would be rejected by the legacy foreign key.
ALTER TABLE sms_kit.admin_job_authorization
  DROP CONSTRAINT admin_job_authorization_tenant_id_job_id_fkey,
  DROP CONSTRAINT admin_job_authorization_tenant_id_operation_idempotency_key_fkey,
  DROP CONSTRAINT admin_job_authorization_pkey,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.admin_job_authorization
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.admin_job_authorization
  ADD CONSTRAINT admin_job_authorization_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX admin_job_authorization_scope_key
  ON sms_kit.admin_job_authorization (scope_type, coalesce(tenant_id, ''), job_id, required_permission);

ALTER TABLE sms_kit.admin_operation
  DROP CONSTRAINT admin_operation_pkey,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.admin_operation
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.admin_operation
  ADD CONSTRAINT admin_operation_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX admin_operation_scope_key
  ON sms_kit.admin_operation (scope_type, coalesce(tenant_id, ''), operation, idempotency_key);

ALTER TABLE sms_kit.send_message
  DROP CONSTRAINT send_message_tenant_idempotency_key_key,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.send_message
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.send_message
  ADD CONSTRAINT send_message_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX send_message_scope_idempotency_key_key
  ON sms_kit.send_message (scope_type, coalesce(tenant_id, ''), idempotency_key);
CREATE INDEX send_message_scope_submitted_idx
  ON sms_kit.send_message (scope_type, tenant_id, submitted_at DESC);

ALTER TABLE sms_kit.otp_challenge
  DROP CONSTRAINT otp_challenge_tenant_idempotency_key,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.otp_challenge
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.otp_challenge
  ADD CONSTRAINT otp_challenge_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX otp_challenge_scope_idempotency_key_key
  ON sms_kit.otp_challenge (scope_type, coalesce(tenant_id, ''), idempotency_key);
CREATE INDEX otp_challenge_scope_subject_action_created_idx
  ON sms_kit.otp_challenge (scope_type, tenant_id, subject_id, action, created_at DESC);

ALTER TABLE sms_kit.send_job
  DROP CONSTRAINT send_job_tenant_id_job_type_dedupe_key_key,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.send_job
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.send_job
  ADD CONSTRAINT send_job_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX send_job_scope_type_dedupe_key_key
  ON sms_kit.send_job (scope_type, coalesce(tenant_id, ''), job_type, dedupe_key);
CREATE INDEX send_job_scope_state_available_idx
  ON sms_kit.send_job (scope_type, tenant_id, state, available_at);

ALTER TABLE sms_kit.rate_limit_bucket
  DROP CONSTRAINT rate_limit_bucket_pkey,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.rate_limit_bucket
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.rate_limit_bucket
  ADD CONSTRAINT rate_limit_bucket_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX rate_limit_bucket_scope_key
  ON sms_kit.rate_limit_bucket (scope_type, coalesce(tenant_id, ''), scope, scope_hash, window_start, window_seconds);
CREATE INDEX rate_limit_bucket_scope_expires_at_idx
  ON sms_kit.rate_limit_bucket (scope_type, tenant_id, expires_at);

ALTER TABLE sms_kit.audit_event
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.audit_event
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.audit_event
  ADD CONSTRAINT audit_event_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE INDEX audit_event_scope_occurred_idx
  ON sms_kit.audit_event (scope_type, tenant_id, occurred_at DESC);

ALTER TABLE sms_kit.daily_stat
  DROP CONSTRAINT daily_stat_pkey,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.daily_stat
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.daily_stat
  ADD CONSTRAINT daily_stat_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX daily_stat_scope_key
  ON sms_kit.daily_stat (scope_type, coalesce(tenant_id, ''), stat_date, template_key, purpose);

ALTER TABLE sms_kit.stat_dirty_date
  DROP CONSTRAINT stat_dirty_date_pkey,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'TENANT',
  ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE sms_kit.stat_dirty_date
   SET scope_type = 'SYSTEM', tenant_id = NULL
 WHERE tenant_id = '__system__';

ALTER TABLE sms_kit.stat_dirty_date
  ADD CONSTRAINT stat_dirty_date_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE UNIQUE INDEX stat_dirty_date_scope_key
  ON sms_kit.stat_dirty_date (scope_type, coalesce(tenant_id, ''), stat_date);

ALTER TABLE sms_kit.delivery_receipt
  DROP CONSTRAINT delivery_receipt_tenant_ownership_check,
  ADD COLUMN scope_type text NOT NULL DEFAULT 'SYSTEM';

UPDATE sms_kit.delivery_receipt receipt
   SET scope_type = message.scope_type,
       tenant_id = message.tenant_id
  FROM sms_kit.send_message message
 WHERE receipt.match_status = 'matched'
   AND receipt.message_id = message.id;

ALTER TABLE sms_kit.delivery_receipt
  ADD CONSTRAINT delivery_receipt_scope_type_check CHECK (
    (scope_type = 'SYSTEM' AND tenant_id IS NULL) OR
    (scope_type = 'TENANT' AND tenant_id IS NOT NULL)
  );

CREATE INDEX delivery_receipt_scope_received_at_idx
  ON sms_kit.delivery_receipt (scope_type, tenant_id, received_at DESC);

ALTER TABLE sms_kit.admin_job_authorization
  ADD CONSTRAINT admin_job_authorization_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES sms_kit.send_job (id) ON DELETE CASCADE;
