import type { MainlandPhone } from "../core/phone.js";

declare const positiveTimeoutMsBrand: unique symbol;

/** A finite duration that has been checked to be greater than zero. */
export type PositiveTimeoutMs = number & { readonly [positiveTimeoutMsBrand]: "PositiveTimeoutMs" };

export function positiveTimeoutMs(value: number): PositiveTimeoutMs {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("provider timeout must be positive");
  }
  return value as PositiveTimeoutMs;
}

/** Ephemeral credentials resolved immediately before a provider operation. */
export type ProviderAuthInput = Readonly<{
  region: string;
  endpoint?: string;
  accessKeyId: string;
  accessKeySecret: string;
}>;

export type ProviderListInput = ProviderAuthInput & Readonly<{
  pageSize: number;
  cursor?: string;
}>;

export type ProviderPage<T> = Readonly<{
  items: readonly T[];
  nextCursor?: string | undefined;
}>;

export type ProviderConnectionResult = Readonly<{
  status: "ready" | "degraded";
  signatureCount: number;
  templateCount: number;
}>;

export type ProviderSignature = Readonly<{
  externalKey: string;
  externalName: string;
  externalStatus: string;
  externalType: string;
}>;

export type ProviderTemplate = Readonly<{
  externalKey: string;
  externalCode: string;
  externalName: string;
  externalStatus: string;
  templateType: "verification" | "notification";
  variableNames: readonly string[];
}>;

export type ProviderSendInput = ProviderAuthInput & Readonly<{
  phoneNumber: MainlandPhone;
  signatureName: string;
  templateCode: string;
  templateParams: Readonly<Record<string, string>>;
  outId: string;
  timeoutMs: PositiveTimeoutMs;
}>;

export type ProviderDeliveryQuery = ProviderAuthInput & Readonly<{
  phoneNumber: MainlandPhone;
  sendDate: string;
  currentPage: number;
  pageSize: number;
  bizId?: string;
}>;

export type ProviderSendResult =
  | { kind: "accepted"; bizId: string; requestId: string }
  | { kind: "rejected"; code: string; retryable: boolean; requestId?: string }
  | { kind: "unknown"; code: "ACCEPTANCE_UNKNOWN" };

export type ProviderDeliveryItem = Readonly<{
  /** The caller's opaque OutId is the only response identity trusted for reconciliation. */
  outId?: string;
  status: "waiting" | "delivered" | "failed";
  occurredAt?: Date;
  providerCode?: string;
}>;
export type ProviderDeliveryResult =
  | Readonly<{ kind: "page"; items: readonly ProviderDeliveryItem[]; hasNextPage: boolean }>
  | Readonly<{ kind: "unknown"; code: "DELIVERY_UNKNOWN" }>;

export type ProviderReceipt = Readonly<{
  bizId: string;
  outId?: string;
  deliveryStatus: "delivered" | "failed";
  providerCode?: string;
  providerMessage?: string;
  occurredAt: Date;
  phoneNumber?: MainlandPhone;
}>;

export type ProviderReceiptBatch = Readonly<{
  items: readonly ProviderReceipt[];
  acknowledgement: Readonly<{ code: number; msg: string }>;
}>;

export interface SmsProvider {
  testConnection(input: ProviderAuthInput): Promise<ProviderConnectionResult>;
  listSignatures(input: ProviderListInput): Promise<ProviderPage<ProviderSignature>>;
  listTemplates(input: ProviderListInput): Promise<ProviderPage<ProviderTemplate>>;
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
  queryDelivery(input: ProviderDeliveryQuery): Promise<ProviderDeliveryResult>;
  parseReceipt(input: unknown): ProviderReceiptBatch;
}
