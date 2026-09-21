"use client";

import type { ApiSuccess, SmsOverviewDto } from "sms-kit/next/types";

const response: ApiSuccess<SmsOverviewDto> | null = null;

export default function TypeOnlyPage() {
  return <main>{response === null ? "type-only import" : response.requestId}</main>;
}
