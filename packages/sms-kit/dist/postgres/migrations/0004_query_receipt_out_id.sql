ALTER TABLE sms_kit.delivery_receipt
  ALTER COLUMN provider_biz_id DROP NOT NULL,
  ADD COLUMN provider_out_id text;

ALTER TABLE sms_kit.delivery_receipt
  ADD CONSTRAINT delivery_receipt_provider_reference_check CHECK (
    provider_biz_id IS NOT NULL OR provider_out_id IS NOT NULL
  );
