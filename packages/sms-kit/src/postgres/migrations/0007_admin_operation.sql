CREATE TABLE sms_kit.admin_operation (
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  operation text NOT NULL CHECK (operation IN (
    'config.patch',
    'config.test_connection',
    'resource.sync.preview',
    'resource.sync.commit',
    'signature.update',
    'template.import',
    'template.update',
    'sms.test.send'
  )),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  request_checksum text NOT NULL CHECK (length(request_checksum) > 0),
  result_snapshot jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, operation, idempotency_key),
  CHECK ((result_snapshot IS NULL) = (completed_at IS NULL)),
  CHECK (result_snapshot IS NULL OR jsonb_typeof(result_snapshot) = 'object')
);

CREATE INDEX admin_operation_created_at_idx ON sms_kit.admin_operation (created_at);
