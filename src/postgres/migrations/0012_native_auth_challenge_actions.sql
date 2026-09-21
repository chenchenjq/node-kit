ALTER TABLE sms_kit.otp_challenge
  DROP CONSTRAINT otp_challenge_purpose_check,
  ADD CONSTRAINT otp_challenge_purpose_check CHECK (
    purpose IN ('password_change', 'step_up', 'login_otp', 'password_reset')
  );
