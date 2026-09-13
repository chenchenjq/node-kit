-- A lease held across the v2-to-v3 deployment may already have reached the
-- provider. Fence it permanently as uncertain instead of making it retryable.
UPDATE sms_kit.send_message message
   SET acceptance_status = 'unknown',
       delivery_status = case when delivery_status = 'not_applicable' then 'waiting' else delivery_status end,
       final_error_code = coalesce(final_error_code, 'ACCEPTANCE_UNKNOWN'),
       version = version + 1,
       updated_at = now()
  FROM sms_kit.send_job job
 WHERE job.message_id = message.id
   AND job.state = 'leased'
   AND message.acceptance_status = 'pending';
UPDATE sms_kit.send_job
   SET state = 'dead',
       lease_owner = null,
       lease_token = null,
       lease_until = null,
       last_error_code = coalesce(last_error_code, 'ACCEPTANCE_UNKNOWN'),
       updated_at = now()
 WHERE state = 'leased';

ALTER TABLE sms_kit.delivery_receipt ADD COLUMN tenant_id text;

UPDATE sms_kit.delivery_receipt receipt
   SET tenant_id = message.tenant_id
  FROM sms_kit.send_message message
 WHERE receipt.message_id = message.id
   AND receipt.match_status = 'matched';

ALTER TABLE sms_kit.delivery_receipt
  ADD CONSTRAINT delivery_receipt_tenant_ownership_check CHECK (
    (match_status = 'matched' AND tenant_id IS NOT NULL) OR
    (match_status = 'unmatched' AND tenant_id IS NULL)
  );
CREATE INDEX delivery_receipt_tenant_received_at_idx
  ON sms_kit.delivery_receipt (tenant_id, received_at DESC)
  WHERE tenant_id IS NOT NULL;
