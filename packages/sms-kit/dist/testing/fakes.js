/** A deterministic clock for tests; production code must receive time explicitly. */
export class FakeClock {
    value;
    constructor(now) {
        this.value = new Date(now);
    }
    now() {
        return new Date(this.value);
    }
    advance(milliseconds) {
        this.value = new Date(this.value.getTime() + milliseconds);
        return this.now();
    }
}
/** Deterministic non-secret identifiers for test-only idempotency and dedupe keys. */
export class SequenceIdGenerator {
    prefix;
    sequence = 0;
    constructor(prefix = "test") {
        this.prefix = prefix;
    }
    next() {
        this.sequence += 1;
        return `${this.prefix}-${this.sequence}`;
    }
}
/** Builds a persistence-safe message fixture: it contains no plaintext phone or render values. */
export function createSafeMessageFixture(input) {
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
