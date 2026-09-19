import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("read authorization boundaries", () => {
  it("does not expose supply price to a management-only caller", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", createId: () => "sku", authorize: async (_context, action) => action === "supply-price.read" ? { ok: false } : { ok: true } });
    const created = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] });
    if (!created.ok) throw new Error("fixture failed");
    await service.patchSkuConfigurations({}, { spuId: "p", commandId: "price", patches: [{ skuId: "sku", expectedConfigVersion: "1", supplyPrice: "9.00" }] });
    const management = await service.getManagementConfiguration({}, { spuId: "p" });
    expect(management.ok && management.value.skus[0]).not.toHaveProperty("supplyPrice");
  });
});
