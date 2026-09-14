import { createSmsAdminHandler } from "sms-kit/next";

export default function ServerPage() {
  return <main>{typeof createSmsAdminHandler}</main>;
}
