ALTER TABLE sms_kit.send_job
  ADD CONSTRAINT send_job_tenant_id_id_key UNIQUE (tenant_id, id);

-- A manual receipt reconciliation may reuse a pre-existing system job. Keep
-- that job's origin unchanged, and persist only the narrow admin capability
-- conferred by the authorizing operation.
CREATE TABLE sms_kit.admin_job_authorization (
  tenant_id text NOT NULL,
  job_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation = 'receipt.reconcile'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  required_permission text NOT NULL CHECK (required_permission = 'receipt.reconcile'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id, required_permission),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES sms_kit.send_job (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, operation, idempotency_key)
    REFERENCES sms_kit.admin_operation (tenant_id, operation, idempotency_key) ON DELETE CASCADE
);

CREATE INDEX admin_job_authorization_operation_idx
  ON sms_kit.admin_job_authorization (tenant_id, operation, idempotency_key);

-- Preserve the capability for receipt-reconcile operations completed before
-- this additive table existed. Text comparison avoids unsafe UUID casts from
-- legacy or manually-corrupted JSON snapshots.
INSERT INTO sms_kit.admin_job_authorization (
  tenant_id, job_id, operation, idempotency_key, required_permission, created_at
)
SELECT operation.tenant_id, job.id, operation.operation,
       operation.idempotency_key, 'receipt.reconcile', operation.completed_at
  FROM sms_kit.admin_operation operation
  JOIN sms_kit.send_job job
    ON job.tenant_id = operation.tenant_id
   AND job.id::text = operation.result_snapshot ->> 'id'
 WHERE operation.operation = 'receipt.reconcile'
   AND operation.completed_at IS NOT NULL
   AND operation.result_snapshot ->> 'kind' = 'receipt-reconcile-job'
   AND job.job_type = 'reconcile'
   AND job.origin_action IS NULL
ON CONFLICT DO NOTHING;
