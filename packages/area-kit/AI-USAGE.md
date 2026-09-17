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

The host chooses `targetLevel` from 1 through 5; its default is 3 when omitted. Use `listProvinces`, `listChildren`, `getPath`, and `search` to display data. `search` returns paths so same display names remain distinguishable by code and ancestry. `getRegion`/`getRegions` use exact code, and list/search APIs return pages with `hasMore` and `nextCursor`.

Use `validateSelection({ datasetId, pathCodes, targetLevel })` immediately before persistence. It returns `datasetId`, `versionCode`, endpoint `code`/`level`, canonical path codes/names, submitted `candidatePathCodes`, `actualLevel`, `reachedTargetLevel`, `accepted`, and `reason`. Its default is strict target-level acceptance. The trusted server may separately allow an exact source/version/code group exception at level 2 or early termination only for a snapshot leaf. Do not take a policy from the browser request.

Validation can return an unresolved result with null endpoint/path fields and reasons including `NOT_INITIALIZED`, `UNKNOWN_CODE`, `VERSION_UNAVAILABLE`, `PARENT_MISMATCH`, `NOT_SELECTABLE`, or `DATASET_NOT_ACCEPTED`. A resolved rejection can be `NAVIGATION_ONLY`, `TARGET_LEVEL_NOT_REACHED`, or `TARGET_LEVEL_EXCEEDED`. Accepted reasons are `TARGET_REACHED`, `GROUP_ENDPOINT_EXCEPTION`, and `EARLY_TERMINATION_ACCEPTED`. Client calls can also reject with sanitized error codes such as `FORBIDDEN`, `INVALID_ARGUMENT`, `QUERY_LIMIT_EXCEEDED`, `REVISION_CONFLICT`, or `QUERY_FAILED`.

## Host files and historical records

Place the PostgreSQL store and `createAreaKit` construction in a server-only host module. Put authentication, `authorize`, request protection, trusted validation policy, database migration execution, and address persistence in host-owned modules. Put `createAreaClient` in a client-safe module that points to the host's protected HTTP adapter. The adapter authenticates every request, supplies trusted server options, validates request shape, and maps sanitized errors.

For every saved address, retain `datasetId`, `versionCode`, selected `code`, and the returned path-code/name snapshot. Preserve those values for historical records and query a specified ready dataset when showing them. A later activation must not rewrite previous rows. Treat unknown codes, unavailable versions, disabled nodes, navigation-only groups, and null fields as explicit outcomes to surface or resolve with the business owner.

The only versions documented as run are the Task 16 data verification environment: Node v22.22.1, Drizzle 0.45.2, PostgreSQL 18.3, and the fixed source snapshot described in [DATA-SOURCE.md](./DATA-SOURCE.md). Task 18 packed-consumer and browser results are not yet verified here.
