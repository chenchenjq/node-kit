import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

const context = { scopeKey: "shop-a", actorRef: "admin-1" };

describe("default SKU service path", () => {
  it("persists one default SKU at 00 and repeats a command safely", async () => {
    const store = createInMemorySkuStore();
    const service = createSkuService({
      store,
      resolveScope: async (ctx: typeof context) => ctx.scopeKey,
      authorize: async () => ({ ok: true }),
    });

    const first = await service.saveConfiguration(context, {
      spuId: "spu-1",
      spuCode: "SPU0001",
      commandId: "create-default",
      dimensions: [],
      selectedCombinations: [],
    });
    const retry = await service.saveConfiguration(context, {
      spuId: "spu-1",
      spuCode: "SPU0001",
      commandId: "create-default",
      dimensions: [],
      selectedCombinations: [],
    });

    expect(first).toMatchObject({ ok: true, value: { skus: [{ skuCode: "SPU000100", combinationKey: "v1:[]", status: "disabled" }] } });
    expect(retry).toEqual(first);

    const read = await service.getManagementConfiguration(context, { spuId: "spu-1" });
    expect(read).toMatchObject({ ok: true, value: { skus: [{ skuCode: "SPU000100" }], structureVersion: "1" } });
    expect(store.commandCount()).toBe(1);
  });
});
