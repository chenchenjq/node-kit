import { createHash, timingSafeEqual } from "node:crypto";

import { parseAliyunReceiptBatch, type AliyunReceipt } from "../aliyun/receipt.js";
import { SmsKitError } from "../core/errors.js";
import type { Clock, EventSink } from "../ports/runtime.js";
import type { SecretResolver } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";

const acknowledgement = Object.freeze({ code: 0, msg: "成功" });
const callbackTokenBytes = 32;
const callbackTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const unmatchedTenant = "" as never;

export type ReceiptServiceDependencies = Readonly<{
  store: SmsStore;
  secrets: SecretResolver;
  clock: Clock;
  events: EventSink;
  /** Reserve adapter response time; callbacks should fail retryably before it. */
  safetyMarginMs?: number;
}>;

export type ReceiptIngestInput = Readonly<{
  token: string;
  body: string | Uint8Array;
  deadlineAt: Date;
  /** Handler-owned cooperative cancellation for body/ingest deadline expiry. */
  signal?: AbortSignal;
}>;

export type ReceiptIngestResult = Readonly<{ acknowledgement: typeof acknowledgement }>;

function fixedToken(value: string): Readonly<{ bytes: Buffer; valid: boolean }> {
  const valid = callbackTokenPattern.test(value);
  const decoded = valid ? Buffer.from(value, "base64url") : Buffer.alloc(callbackTokenBytes);
  return { bytes: decoded.length === callbackTokenBytes ? decoded : Buffer.alloc(callbackTokenBytes), valid: valid && decoded.length === callbackTokenBytes };
}

function receiptDedupeKey(receipt: AliyunReceipt): string {
  return createHash("sha256")
    .update("aliyun\0")
    .update(receipt.bizId).update("\0")
    .update(receipt.occurredAt.toISOString()).update("\0")
    .update(receipt.deliveryStatus).update("\0")
    .update(receipt.providerCode)
    .digest("hex");
}

function deadlineReached(clock: Clock, deadlineAt: Date, safetyMarginMs: number): boolean {
  return !Number.isFinite(deadlineAt.getTime()) || deadlineAt.getTime() - clock.now().getTime() < safetyMarginMs;
}

function assertActive(input: ReceiptIngestInput, clock: Clock, safetyMarginMs: number): void {
  if (input.signal?.aborted === true || deadlineReached(clock, input.deadlineAt, safetyMarginMs)) {
    throw new SmsKitError("STORAGE_FAILURE", "receipt callback deadline is too close", true);
  }
}

/** Observability must never turn an already-durable provider acknowledgement into a retry. */
function observe(events: EventSink, event: Parameters<EventSink["emit"]>[0]): void {
  try {
    void Promise.resolve(events.emit(event)).catch(() => undefined);
  } catch {
    // Event sinks are optional observers of durable receipt state.
  }
}

/**
 * Accepts an already HTTPS-terminated callback. Its possession token prevents
 * accidental traffic, but message ownership is proved only by the opaque
 * out_id and provider BizId pair stored at dispatch time.
 */
export class ReceiptService {
  private readonly safetyMarginMs: number;

  constructor(private readonly dependencies: ReceiptServiceDependencies) {
    this.safetyMarginMs = dependencies.safetyMarginMs ?? 50;
    if (!Number.isFinite(this.safetyMarginMs) || this.safetyMarginMs < 0) throw new RangeError("receipt safety margin must be non-negative");
  }

  async ingest(input: ReceiptIngestInput): Promise<ReceiptIngestResult> {
    assertActive(input, this.dependencies.clock, this.safetyMarginMs);
    const config = await this.dependencies.store.config.get();
    assertActive(input, this.dependencies.clock, this.safetyMarginMs);
    if (config.status === "unconfigured" || !config.enabled) {
      throw new SmsKitError("PERMISSION_DENIED", "receipt callback is not enabled");
    }
    let expected: string;
    try {
      expected = await this.dependencies.secrets.resolve(config.receiptCallbackTokenRef);
    } catch {
      assertActive(input, this.dependencies.clock, this.safetyMarginMs);
      throw new SmsKitError("SECRET_UNRESOLVABLE", "receipt callback token cannot be resolved");
    }
    assertActive(input, this.dependencies.clock, this.safetyMarginMs);
    const suppliedToken = fixedToken(input.token);
    const expectedToken = fixedToken(expected);
    const equal = timingSafeEqual(suppliedToken.bytes, expectedToken.bytes);
    if (!expectedToken.valid) throw new SmsKitError("CONFIG_INVALID", "receipt callback token configuration is invalid");
    if (!suppliedToken.valid || !equal) throw new SmsKitError("PERMISSION_DENIED", "receipt callback token is invalid");

    assertActive(input, this.dependencies.clock, this.safetyMarginMs);
    const reports = parseAliyunReceiptBatch(input.body);
    assertActive(input, this.dependencies.clock, this.safetyMarginMs);

    const outcomes = await this.dependencies.store.transaction(async (tx) => {
      const result = { unmatched: 0, terminalConflicts: 0 };
      for (const report of reports) {
        assertActive(input, this.dependencies.clock, this.safetyMarginMs);
        const message = await this.dependencies.store.messages.lockByReceiptReference({ outId: report.outId, bizId: report.bizId }, tx);
        assertActive(input, this.dependencies.clock, this.safetyMarginMs);
        const recorded = await this.dependencies.store.receipts.record({
          tenantId: message?.tenantId ?? unmatchedTenant,
          ...(message === undefined ? {} : { messageId: message.id }),
          dedupeKey: receiptDedupeKey(report),
          providerBizId: report.bizId,
          deliveryStatus: report.deliveryStatus,
          providerCode: report.providerCode,
          occurredAt: report.occurredAt,
          receivedAt: this.dependencies.clock.now(),
          source: "callback",
          redactedPayload: { redactedFields: ["phone"], reportCount: 1 },
        }, tx);
        assertActive(input, this.dependencies.clock, this.safetyMarginMs);
        if (message === undefined) {
          if (recorded.created) result.unmatched += 1;
          continue;
        }
        if (!recorded.created) continue;
        try {
          await this.dependencies.store.messages.completeDelivery({
            tenantId: message.tenantId,
            id: message.id,
            status: report.deliveryStatus,
            occurredAt: report.occurredAt,
          }, tx);
          assertActive(input, this.dependencies.clock, this.safetyMarginMs);
        } catch (error) {
          if (error instanceof SmsKitError && error.code === "CONCURRENT_MODIFICATION") {
            result.terminalConflicts += 1;
            continue;
          }
          throw error;
        }
      }
      assertActive(input, this.dependencies.clock, this.safetyMarginMs);
      return result;
    }, input.signal === undefined ? {} : { signal: input.signal });
    // A deadline can win after PostgreSQL has already accepted COMMIT. Treat
    // that as a retryable late completion; receiptDedupeKey makes the provider
    // retry a no-op instead of duplicating the durable state transition.
    assertActive(input, this.dependencies.clock, this.safetyMarginMs);

    if (outcomes.unmatched > 0) {
      observe(this.dependencies.events, { name: "sms.receipt.unmatched", level: "warn", metadata: { redactedFields: ["phone"], counts: [{ name: "receipt", value: outcomes.unmatched }] } });
    }
    if (outcomes.terminalConflicts > 0) {
      observe(this.dependencies.events, { name: "sms.receipt.terminal_conflict", level: "warn", metadata: { counts: [{ name: "receipt", value: outcomes.terminalConflicts }] } });
    }
    return { acknowledgement };
  }
}
