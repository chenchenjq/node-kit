import type { MessageId } from "../core/types.js";
import type { SmsTransaction } from "./store.js";

export type VerificationPolicy = {
  version: number;
  otpLength: number;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  proofTtlSeconds: number;
  phoneMinIntervalSeconds: number;
  phoneHourlyLimit: number;
  phoneDailyLimit: number;
  ipWindowSeconds: number;
  ipWindowLimit: number;
  systemDailyBudget: number | null;
  circuitOpen: boolean;
  circuitReason?: string;
};

export type VerificationPolicyUpdate = Omit<VerificationPolicy, "version"> & {
  expectedVersion: number;
};

export type BudgetReservation = {
  messageId: MessageId;
  budgetDate: string;
  state: "held" | "released";
};

export interface PolicyStore {
  get(tx?: SmsTransaction): Promise<VerificationPolicy>;
  update(input: VerificationPolicyUpdate, tx?: SmsTransaction): Promise<VerificationPolicy>;
  holdBudget(messageId: MessageId, now: Date, tx: SmsTransaction): Promise<BudgetReservation>;
  releaseBudget(messageId: MessageId, tx: SmsTransaction): Promise<boolean>;
}
