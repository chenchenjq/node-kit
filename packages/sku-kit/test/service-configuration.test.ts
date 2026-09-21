import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("SKU configuration patches", () => {
  it("updates price and enabled state without changing the SKU identity", async () => {
    const service = createSkuService({
      store: createInMemorySkuStore(),
      resolveScope: async () => "shop-a",
      authorize: async () => ({ ok: true }),
      createId: () => "sku-default",
    });
    const created = await service.saveConfiguration({}, {
      spuId: "spu-1", spuCode: "SPU", commandId: "create", dimensions: [], selectedCombinations: [],
    });
    if (!created.ok) throw new Error("fixture creation failed");

    const patched = await service.patchSkuConfigurations({}, {
      spuId: "spu-1",
      commandId: "set-price",
      patches: [{
        skuId: created.value.skus[0]?.skuId ?? "",
        expectedConfigVersion: "1",
        suggestedRetailPrice: "12.3",
        supplyPrice: "5",
        status: "enabled",
      }],
    });

    expect(patched).toMatchObject({
      ok: true,
      value: [{ skuId: "sku-default", skuCode: "SPU00", status: "enabled", suggestedRetailPrice: "12.30", supplyPrice: "5.00", configVersion: "2" }],
    });
  });

  it("does not initialize a product when a configuration patch targets a missing SPU", async () => {
    const store = createInMemorySkuStore();
    const service = createSkuService({ store, resolveScope: async () => "shop-a", authorize: async () => ({ ok: true }) });
    const result = await service.patchSkuConfigurations({}, {
      spuId: "missing", commandId: "missing-patch", patches: [{ skuId: "unknown", expectedConfigVersion: "1" }],
    });

    expect(result).toMatchObject({ ok: false, problem: { code: "NOT_FOUND" } });
    expect(await store.read("shop-a", "missing")).toBeNull();
  });

  it("rejects a batch addressed to a stale structure revision", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "shop-a", authorize: async () => ({ ok: true }), createId: () => "sku" });
    const created = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] });
    if (!created.ok) throw new Error("fixture creation failed");
    const result = await service.patchSkuConfigurations({}, { spuId: "p", commandId: "stale", expectedStructureVersion: "0", patches: [{ skuId: "sku", expectedConfigVersion: "1", status: "enabled" }] });
    expect(result).toMatchObject({ ok: false, problem: { code: "VERSION_CONFLICT" } });
  });
});
