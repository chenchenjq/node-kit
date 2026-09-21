import { describe, expect, it } from "vitest";

import { SYSTEM_SCOPE, scopeTenantId, tenantScope } from "../../../src/core/index.js";
import type { TenantId } from "../../../src/core/index.js";

describe("SMS ownership scope", () => {
  it("represents SYSTEM without a synthetic tenant identifier", () => {
    expect(SYSTEM_SCOPE).toEqual({ scopeType: "SYSTEM" });
    expect(scopeTenantId(SYSTEM_SCOPE)).toBeNull();
    expect("tenantId" in SYSTEM_SCOPE).toBe(false);
  });

  it("keeps a trusted tenant identifier only on TENANT scope", () => {
    const scope = tenantScope("tenant-a" as TenantId);

    expect(scope).toEqual({ scopeType: "TENANT", tenantId: "tenant-a" });
    expect(scopeTenantId(scope)).toBe("tenant-a");
  });
});
