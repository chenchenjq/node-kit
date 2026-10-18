import type { MessageId, SmsScope, TenantId } from "../core/types.js";
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

/** Existing tenant callers remain compatible; SYSTEM requires an explicit scope. */
export type BudgetOwnership = Readonly<
  | { tenantId: TenantId; ownership?: never }
  | { ownership: SmsScope; tenantId?: never }
>;
export type HoldBudgetInput = BudgetOwnership & Readonly<{ messageId: MessageId; now: Date }>;
export type ReleaseBudgetInput = BudgetOwnership & Readonly<{ messageId: MessageId }>;

export interface PolicyStore {
  get(tx?: SmsTransaction): Promise<VerificationPolicy>;
  update(input: VerificationPolicyUpdate, tx?: SmsTransaction): Promise<VerificationPolicy>;
  holdBudget(input: HoldBudgetInput, tx: SmsTransaction): Promise<BudgetReservation>;
  releaseBudget(input: ReleaseBudgetInput, tx: SmsTransaction): Promise<boolean>;
}
