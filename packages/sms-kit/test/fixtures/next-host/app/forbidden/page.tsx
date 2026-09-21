"use client";

import { AesGcmPhoneNumberProtector } from "sms-kit/security";

export default function ForbiddenPage() {
  return <main>{typeof AesGcmPhoneNumberProtector}</main>;
}
