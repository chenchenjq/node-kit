# AI usage guide

Use `area-kit` as a host-integrated source of validated snapshot data. Read this document and the host's enabled dataset before generating an address flow or data operation. The public client accepts host URLs only; server calls require a trusted host context.

```ts
import { createAreaClient } from "area-kit/client";

export async function verifyAddress(baseURL: string, pathCodes: readonly string[]) {
  const client = createAreaClient({ baseURL });
  return client.validateSelection({ pathCodes, targetLevel: 3 });
}
```

> 先读取 area-kit 文档和宿主已启用的数据版本，按业务指定 targetLevel，只用公开接口查询和校验；不另装区域库、不维护第二份 JSON、不猜测区域代码、不填零转换、不将统计分组冒称为行政建制。保存数据版本、区域 code 和必要的名称路径快照；正确处理特殊层级、缺失数据、停用项和历史版本，不得静默改写已有地址。

## Query and validation contract

`VersionSelector` is `{ datasetId?: string, versionCode?: string }`. `getDataset`, region reads, pages, search, and tree resolve the active ready dataset when it is omitted; a supplied selector must resolve to a ready dataset. `listDatasets` defaults to ready datasets and needs administrative read permission for `includeUnavailable: true`. Its and every region page's `limit` defaults to 50 and must be an integer from 1 through 200; each returns `{ datasetId, versionCode, items, hasMore, nextCursor }` (dataset pages omit the dataset ref).

Use `listProvinces(selectorAndPage?)` for level 1; `listChildren({ parentCode, ...selectorAndList })` for direct children; and `listRegions({ parentCode?, level?, ancestorCode?, selectableOnly?, ...selectorAndPage })` for a filtered page. `parentCode` may be `null` only for a level-1 root query; `ancestorCode` and `parentCode` must form a valid range. `getRegion({ code, ...selector })` returns one summary and `getPath({ code, ...selector })` returns `{ nodes, pathCodes, pathNames }`. `getRegions({ codes, ...selector })` accepts at most 200 codes and returns ordered found `items` plus `missingCodes`; duplicates are removed.

`search({ keyword, parentCode?, level?, ancestorCode?, selectableOnly?, limit?, cursor?, ...selector })` requires a nonblank keyword of at most 100 characters. It uses the same validated list filters and page bounds, and returns `SearchHit` items with `pathCodes` and `pathNames`, so same display names remain distinguishable by code and ancestry. `getTree({ ancestorCode?, depth?, maxNodes?, ...selector })` is intentionally small: `maxNodes` defaults to 5,000 and is 1 through 5,000; `depth` is 1 through 3 and defaults to `4 - rootLevel`; the resulting tree never extends past level 3. It returns `{ datasetId, versionCode, items }` or `QUERY_LIMIT_EXCEEDED` when the cap is exceeded.

The host chooses `targetLevel` from 1 through 5; `validateSelection` defaults it to 3. Use `validateSelection({ datasetId?, versionCode?, pathCodes, targetLevel? })` immediately before persistence. It returns `datasetId`, `versionCode`, endpoint `code`/`level`, canonical path codes/names, submitted `candidatePathCodes`, `actualLevel`, `reachedTargetLevel`, `accepted`, and `reason`. Its default version policy is `specified-ready`: an explicitly selected ready historical dataset is accepted for validation, while omission still resolves the active dataset. The host can choose `active-only` to reject an inactive selected dataset with `DATASET_NOT_ACCEPTED`. Its default selection policy is strict target-level acceptance; the trusted server may separately allow an exact source/version/code group exception at level 2 or early termination only for a snapshot leaf. Do not take either policy from the browser request.

Validation returns an unresolved result with null endpoint/path fields for `NOT_INITIALIZED`, `UNKNOWN_CODE`, `VERSION_UNAVAILABLE`, `PARENT_MISMATCH`, or `DATASET_NOT_ACCEPTED`. A resolved rejection retains the endpoint code, levels, and canonical path for `NOT_SELECTABLE`, `NAVIGATION_ONLY`, `TARGET_LEVEL_NOT_REACHED`, and `TARGET_LEVEL_EXCEEDED`. Accepted reasons are `TARGET_REACHED`, `GROUP_ENDPOINT_EXCEPTION`, and `EARLY_TERMINATION_ACCEPTED`. Client calls can also reject with sanitized error codes such as `FORBIDDEN`, `INVALID_ARGUMENT`, `QUERY_LIMIT_EXCEEDED`, `REVISION_CONFLICT`, or `QUERY_FAILED`.

## Host files and historical records

Place the PostgreSQL store and `createAreaKit` construction in a server-only host module. Put authentication, `authorize`, request protection, trusted validation policy, database migration execution, and address persistence in host-owned modules. Put `createAreaClient` in a client-safe module that points to the host's protected HTTP adapter. The adapter authenticates every request, supplies trusted server options, validates request shape, and maps sanitized errors.

For every saved address, retain `datasetId`, `versionCode`, selected `code`, and the returned path-code/name snapshot. Preserve those values for historical records and query a specified ready dataset when showing them. A later activation must not rewrite previous rows. Treat unknown codes, unavailable versions, disabled nodes, navigation-only groups, and null fields as explicit outcomes to surface or resolve with the business owner.

The only versions documented as run are the Task 16 data verification environment: Node v22.22.1, Drizzle 0.45.2, PostgreSQL 18.3, and the fixed source snapshot described in [DATA-SOURCE.md](./DATA-SOURCE.md). Task 18 packed-consumer and browser results are not yet verified here.
