import type { DatasetSummary, RegionSummary } from "../../src/types.js";

export function syntheticDataset(
  overrides: Partial<DatasetSummary> = {},
): DatasetSummary {
  return {
    datasetId: "00000000-0000-4000-8000-000000000001",
    versionCode: "synthetic:v1",
    source: "synthetic-test-only",
    sourceCommit: "synthetic-commit",
    rulesVersion: "synthetic-v1",
    codeScheme: "synthetic-test-only",
    dataAsOf: "2023-06-30",
    sourcePublishedAt: "2023-09-11",
    coverage: {
      levels: [1],
      excluded: ["synthetic-test-only"],
      description: "仅供合成测试使用的数据集",
    },
    levelCounts: { 1: 1 },
    status: "ready",
    isActive: true,
    importedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function syntheticRegion(
  overrides: Partial<RegionSummary> = {},
): RegionSummary {
  return {
    code: "01",
    sourceName: "合成省",
    label: "合成省",
    level: 1,
    parentCode: null,
    nodeKind: "unknown",
    enabled: true,
    effectiveEnabled: true,
    navigable: true,
    selectable: true,
    hasChildren: false,
    childrenState: "NONE_IN_SNAPSHOT",
    sort: 0,
    revision: 1,
    ...overrides,
  };
}
