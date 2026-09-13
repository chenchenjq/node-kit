import { describe, expect, it } from "vitest";

import { FixedTenantContext, positiveTimeoutMs } from "../../src/ports/index.js";
import type { TenantId } from "../../src/core/index.js";

describe("Docker-free public contract lane", () => {
  it("uses one fixed trusted tenant for every untrusted host input", async () => {
    const tenantId = "host-default-tenant" as TenantId;
    const context = new FixedTenantContext(tenantId);

    await expect(Promise.resolve(context.resolve({ tenantId: "attacker-tenant" }))).resolves.toBe(tenantId);
    await expect(Promise.resolve(context.resolve(undefined))).resolves.toBe(tenantId);
  });

  it("enforces the provider timeout contract without infrastructure", () => {
    expect(positiveTimeoutMs(1)).toBe(1);
    expect(() => positiveTimeoutMs(0)).toThrow(/positive/);
  });
});
