ALTER TABLE sms_kit.admin_operation
  DROP CONSTRAINT admin_operation_operation_check,
  ADD CONSTRAINT admin_operation_operation_check CHECK (operation IN (
    'config.patch',
    'config.test_connection',
    'resource.sync.preview',
    'resource.sync.commit',
    'signature.update',
    'template.import',
    'template.update',
    'sms.test.send',
    'policy.update',
    'receipt.reconcile'
  ));

ALTER TABLE sms_kit.send_job
  ADD COLUMN origin_action text,
  ADD CONSTRAINT send_job_origin_action_check CHECK (
    origin_action IS NULL OR
    (origin_action = 'sms.test' AND job_type IN ('send', 'reconcile')) OR
    (origin_action = 'receipt.reconcile' AND job_type = 'reconcile')
  );
