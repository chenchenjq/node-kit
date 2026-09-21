import type { CreateMessageInput } from "../ports/store.js";
import type { MessageId, TemplateId, TenantId } from "../core/types.js";

/** A deterministic clock for tests; production code must receive time explicitly. */
export class FakeClock {
  private value: Date;

  constructor(now: Date) {
    this.value = new Date(now);
  }

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): Date {
    this.value = new Date(this.value.getTime() + milliseconds);
    return this.now();
  }
}

/** Deterministic non-secret identifiers for test-only idempotency and dedupe keys. */
export class SequenceIdGenerator {
  private sequence = 0;

  constructor(private readonly prefix = "test") {}

  next(): string {
    this.sequence += 1;
    return `${this.prefix}-${this.sequence}`;
  }
}

/** Builds a persistence-safe message fixture: it contains no plaintext phone or render values. */
export function createSafeMessageFixture(input: Readonly<{
  id: MessageId;
  tenantId: TenantId;
  templateId: TemplateId;
  idempotencyKey: string;
  submittedAt: Date;
}>): CreateMessageInput {
  return {
    id: input.id,
    tenantId: input.tenantId,
    templateId: input.templateId,
    idempotencyKey: input.idempotencyKey,
    templateKeySnapshot: "notice.contract",
    externalTemplateCodeSnapshot: "SMS_CONTRACT",
    signatureNameSnapshot: "Contract",
    purpose: "contract",
    phoneCiphertext: "enc:test:phone",
    phoneKeyId: "test-key",
    phoneHash: "hash:test:phone",
    phoneLast4: "0000",
    phoneMasked: "***0000",
    variableNames: [],
    metadata: { counts: [{ name: "message", value: 1 }] },
    submittedAt: input.submittedAt,
  };
}
