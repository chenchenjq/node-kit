import { describe, it, expect } from "vitest";
import {
  providerSeeds,
  seedProviderDictionary,
  modelPresets,
} from "../src/catalog.js";
describe("provider dictionary", () => {
  it("seeds nine providers idempotently without overwriting administrators", async () => {
    const rows = new Map([
      ["qwen", { code: "qwen", name: "自定义", sort: 99, enabled: false }],
    ]);
    let types = 0;
    const dictionary = {
      async insertTypeIfAbsent() {
        types = 1;
      },
      async insertItemIfAbsent(
        _type: string,
        item: (typeof providerSeeds)[number],
      ) {
        if (!rows.has(item.code)) rows.set(item.code, { ...item });
      },
      async listItems() {
        return [...rows.values()];
      },
    };
    await seedProviderDictionary(dictionary);
    await seedProviderDictionary(dictionary);
    expect(types).toBe(1);
    expect(rows.size).toBe(9);
    expect(rows.get("qwen")).toEqual({
      code: "qwen",
      name: "自定义",
      sort: 99,
      enabled: false,
    });
  });
  it("keeps documented text presets separate from provider dictionary", () => {
    expect(new Set(modelPresets.map((x) => x.providerCode)).size).toBe(9);
    expect(
      modelPresets.every(
        (x) =>
          x.source.startsWith("https://") &&
          x.checkedAt === "2026-09-17" &&
          x.maxOutputTokens > 0,
      ),
    ).toBe(true);
  });
});
