import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("external inventory writes", () => {
  it("rejects writes to an external read-only authority", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), resolveInventoryAuthority: async () => ({ kind: "external-read-only", authorityKey: "erp" }) });
    const result = await service.setExternalInventory({}, { spuId: "p", skuId: "s", commandId: "x", expectedInventoryVersion: "1", quantity: 1 });
    expect(result).toMatchObject({ ok: false, problem: { code: "INVENTORY_READ_ONLY" } });
  });
});
