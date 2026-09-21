import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("registered SPU code uniqueness", () => {
  it("rejects a second product with the same code in one scope", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }) });
    await service.saveConfiguration({}, { spuId: "first", spuCode: "CODE", commandId: "first", dimensions: [], selectedCombinations: [] });
    const duplicate = await service.saveConfiguration({}, { spuId: "second", spuCode: "CODE", commandId: "second", dimensions: [], selectedCombinations: [] });
    expect(duplicate).toMatchObject({ ok: false, problem: { code: "SPU_CODE_CONFLICT" } });
  });
});
