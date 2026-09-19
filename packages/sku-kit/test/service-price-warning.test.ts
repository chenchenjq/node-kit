import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("price warnings", () => {
  it("warns, including on an idempotent replay, when supply exceeds retail", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => "sku" });
    await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] });
    const input = { spuId: "p", commandId: "prices", patches: [{ skuId: "sku", expectedConfigVersion: "1", supplyPrice: "20", suggestedRetailPrice: "10" }] };
    const first = await service.patchSkuConfigurations({}, input);
    const replay = await service.patchSkuConfigurations({}, input);
    expect(first.ok && first.warnings?.[0]?.code).toBe("SUPPLY_PRICE_ABOVE_RETAIL");
    expect(replay.ok && replay.warnings?.[0]?.code).toBe("SUPPLY_PRICE_ABOVE_RETAIL");
  });
});
