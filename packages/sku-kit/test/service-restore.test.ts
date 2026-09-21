import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("archived combination restoration", () => {
  it("requires explicit restoration and reuses the original SKU code", async () => {
    const ids = ["dimension", "value-red", "value-blue", "sku-red", "sku-blue"];
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => ids.shift() ?? "id" });
    const save = (commandId: string, values: readonly string[], restoreArchivedSkuIds?: readonly string[]) => {
      const creating = commandId === "first";
      return service.saveConfiguration({}, {
      spuId: "p", spuCode: "P", commandId,
      ...(commandId === "first" ? {} : { expectedStructureVersion: commandId === "remove" ? "1" : "2" }),
      dimensions: [{ ...(creating ? { draftKey: "dimension" } : { id: "dimension" }), label: "颜色", sort: 0, values: values.map((id, sort) => creating ? ({ draftKey: id, label: id, sort }) : ({ id: `value-${id}`, label: id, sort })) }],
      selectedCombinations: values.map((id) => ({ pairs: [creating ? { dimensionDraftKey: "dimension", valueDraftKey: id } : { dimensionId: "dimension", valueId: `value-${id}` }] })),
      ...(restoreArchivedSkuIds === undefined ? {} : { restoreArchivedSkuIds }),
      });
    };
    const first = await save("first", ["red", "blue"]);
    if (!first.ok) throw new Error("fixture failed");
    await save("remove", ["red"]);
    const missingRestore = await save("needs-restore", ["red", "blue"]);
    const restored = await save("restore", ["red", "blue"], ["sku-blue"]);

    expect(missingRestore).toMatchObject({ ok: false, problem: { code: "RESTORE_REQUIRED" } });
    expect(restored.ok && restored.value.skus).toEqual(expect.arrayContaining([expect.objectContaining({ skuId: "sku-blue", skuCode: "P01" })]));
  });
});
