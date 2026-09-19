import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("preview and inventory authority", () => {
  it("classifies a draft without allocating a code or writing", async () => {
    const store = createInMemorySkuStore();
    const service = createSkuService({ store, resolveScope: async () => "scope", authorize: async () => ({ ok: true }) });
    const preview = await service.previewConfiguration({}, { spuId: "p", spuCode: "P", dimensions: [], selectedCombinations: [] });
    expect(preview).toMatchObject({ ok: true, value: { combinations: [{ kind: "added" }] } });
    expect(store.commandCount()).toBe(0);
    expect(await service.getManagementConfiguration({}, { spuId: "p" })).toMatchObject({ ok: false, problem: { code: "NOT_FOUND" } });
  });

  it("does not write local stock when the scope uses an external authority", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => "sku", resolveInventoryAuthority: async () => ({ kind: "external-read-only", authorityKey: "erp" }) });
    const created = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] });
    if (!created.ok) throw new Error("fixture failed");
    await expect(service.setLocalInventory({}, { spuId: "p", skuId: "sku", commandId: "stock", expectedInventoryVersion: "1", quantity: 2 })).resolves.toMatchObject({ ok: false, problem: { code: "INVENTORY_READ_ONLY" } });
  });
});
