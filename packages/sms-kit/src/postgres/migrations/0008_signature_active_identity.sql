-- Provider identities are keyed by external_key. A provider can retire one
-- signature and recreate the same visible name/type under a new external key,
-- so historical unavailable rows must not reserve the active identity. The
-- partial index keeps active provider identities unique without changing any
-- historical migration file.
ALTER TABLE sms_kit.signature
  DROP CONSTRAINT signature_external_name_external_type_key;

CREATE UNIQUE INDEX signature_active_name_type_key
  ON sms_kit.signature (external_name, external_type)
  WHERE external_status <> 'unavailable';
