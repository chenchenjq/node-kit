ALTER TABLE sms_kit.otp_challenge
  DROP CONSTRAINT otp_challenge_terminal_error_code_check,
  ADD COLUMN delivery_acceptance_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_acceptance_status IN ('pending', 'accepted', 'rejected', 'unknown'));

ALTER TABLE sms_kit.otp_challenge
  DROP CONSTRAINT otp_challenge_terminal_state_check,
  ADD CONSTRAINT otp_challenge_terminal_state_check CHECK (
    (invalidated_at IS NULL AND terminal_error_code IS NULL) OR
    (invalidated_at IS NOT NULL AND terminal_error_code IS NOT NULL)
  );
