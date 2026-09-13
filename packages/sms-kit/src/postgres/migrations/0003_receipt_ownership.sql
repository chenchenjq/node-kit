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
