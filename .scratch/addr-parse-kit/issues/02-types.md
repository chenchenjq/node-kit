# 02 — 核心类型与 RegionProvider 接口

Status: done

`src/types.ts`：ParsedAddress/AddressCandidate/LevelNode(matched 三态+matchedRange)/ParseStatus/Warning 枚举/ParseOptions/ParserMeta/RegionProvider/RegionSnapshot/PathCheck。`.` 出口纯类型；server 出口接口。字段规范以 spec.md 为准（null 语义、regionGroup、residualText）。

## Comments

- 完成证据：类型全部落在 `src/types.ts` 并由 `.` 与 `./server` 两个入口透传；验收证据见 `scripts/verify-pack.mjs` 的「无 area-kit 依赖 + 双入口可用」步骤（断言根入口不带 `initParser`/`DEFAULT_LIMITS`）。
