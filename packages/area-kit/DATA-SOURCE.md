# Data source and provenance

This package's fixed manifest describes the five CSV files from [modood/Administrative-divisions-of-China](https://github.com/modood/Administrative-divisions-of-China) at commit `c49d495b40ac73eb1a66f6eeae5f8fd10696f035`. The snapshot date is 2023-06-30 and the source publication date is 2023-09-11. It is a statistical-source snapshot, not a promise of current administrative status.

## Current county-level delivery-region source

For shipping-region restrictions, use the separate `area-kit/delivery-regions` adapter. Its source is the Ministry of Civil Affairs [Administrative Division Information Query Platform API](https://dmfw.mca.gov.cn/9095/xzqh/getList?code=&maxLevel=3), which returns the current province, prefecture, and county-level administrative tree with 12-digit codes. The adapter keeps the first six digits supplied by that API as the national six-digit code; it does not pad statistical codes or derive codes from names.

The response does not include a dataset tag (`tag` was `null` when checked on 2026-09-23). The adapter therefore pins each retrieval by the exact response SHA-256 and records both the HTTP `Date` header and local retrieval timestamp. For example, the response captured on 2026-09-23 had SHA-256 `a880ff2c2fc76f7e15c42dcef9476bd353fd48a2ce3ea397140358211636700e`, contained 31 mainland province roots and 3,213 descendant nodes, and included the six-digit-prefix records `653132` 岑岭县 and `659013` 草湖市. Treat the HTTP date as response metadata rather than a formal publication/effective date; retain the exact serialized response with every imported snapshot.

The national code baseline is [GB/T 2260-2007](https://std.samr.gov.cn/gb/search/gbDetailed?id=71F772D76EA3D3A7E05397BE0A0AB82A), listed as current by SAMR with a 2023 review conclusion of continued validity. The 2025 Administrative Division Code Management Measures (effective 2025-09-01) require the Ministry of Civil Affairs to publish the nationwide code set through the National Geographical Names Database every January, covering the previous year-end. The query API's response tag is absent, so its checksum proves which API response was captured but does not itself identify the formal nationwide publication. Before production activation, compare the API snapshot and every mapped six-digit code against that official full publication, then verify actual receiving-address representations from the Mall.

That exact 271,004-byte response is retained at [`snapshots/mca-xzqh-2026-09-23.json`](./snapshots/mca-xzqh-2026-09-23.json) and included in this package release so mapping results can be reproduced. Its SHA-256 is the value above; its HTTP `Date` was `Wed, 23 Sep 2026 16:09:41 GMT`.

The adapter excludes all non-mainland regions, including Hong Kong, Macao, and Taiwan. It synthesizes only nonselectable address grouping rows that are absent from the query tree (for example `110100` 北京市 and `469000` 省直辖县级行政区划). Those rows preserve the `city_code` parent expected in structured addresses; actual province, city, district, county, and county-level-city choices retain codes and names from the source response. Every transformed code is unique and six digits, every parent stays within the same province, and unsupported node levels, missing provinces, duplicate codes, malformed codes, or unknown direct-admin node types reject the entire snapshot.

The adapter's presence does not certify the returned data for production. Before activating a new OMS snapshot, review the exact response checksum and source HTTP date, compare changes with the preceding snapshot and the official six-digit-code policy, verify actual mall address fields/names (including municipality and direct-admin province formats), and run the full parent/name/order-address compatibility audit. The pinned five-level modood dataset above remains unchanged and must not be presented as the source for this delivery-region catalog.

```ts
import type { DatasetSummary } from "area-kit";

export function isPinnedSnapshot(dataset: DatasetSummary): boolean {
  return dataset.versionCode === "modood-administrative-divisions-of-china:c49d495b40ac73eb1a66f6eeae5f8fd10696f035:v1";
}
```

## Fixed input manifest

| CSV | Level | Rows verified in Task 16 | Bytes | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `dist/provinces.csv` | 1 | 31 | 532 | `b17e76dab634e24e0f56021f15737c0a526dc7f0c4e39d21abeba5a8668383cd` |
| `dist/cities.csv` | 2 | 342 | 7,580 | `a9c818e8a5120189173668b40882ce8bf59a7ec2b057c49d7a724a04bec727f2` |
| `dist/areas.csv` | 3 | 2,978 | 85,403 | `169b8d99654c28cbd285e771e00688837f77af8d50c2b703592146388d2a99ab` |
| `dist/streets.csv` | 4 | 41,352 | 1,630,789 | `831dc1c483079cee166717118e57f4b69ef6212c699dbd4bff868b59513ac14b` |
| `dist/villages.csv` | 5 | 620,573 | 37,730,558 | `31a824829aeef7b472fced6a3f9f8321cbd9fb26661052be98904f9763ec88ce` |

Task 16 independently checked 665,276 raw rows (39,454,862 bytes total), then audited, imported, activated, and re-imported the same source. Conflict, missing-parent, ancestor-mismatch, invalid, and duplicate counts were zero at every level. Its prepared-source retrieval timestamp was `2026-09-17T13:23:57.633Z`. The full run used Node v22.22.1, Drizzle 0.45.2, PostgreSQL 18.3, and import batches of 1,000. This is evidence for that pinned run, not a support matrix or production-capacity guarantee.

The source's README says its project is no longer updated and says that from October 2024 the underlying agency no longer publishes the concrete codes. Refreshing this package therefore requires a separately reviewed source, manifest, audit, import, and documentation update; do not silently substitute newer-looking files.

Coverage excludes Hong Kong, Macao, and Taiwan. In the verified source, `71`, `81`, and `82` returned `UNKNOWN_CODE`. The Task 16 sample cases exercised five levels, all nine fixed navigation groups, repeated names, and special-looking names; those samples do not replace the full five-file audit. A full audit verifies every row and ancestry link; sampling only supports the documented behavioral examples.

## License and prepared data

The upstream project states its license is WTFPL version 2. The unmodified upstream license text is included at [licenses/Administrative-divisions-of-China.LICENSE.txt](./licenses/Administrative-divisions-of-China.LICENSE.txt). `area-kit prepare --dir <directory>` retains the upstream README and LICENSE with the prepared CSVs and records their retrieval/checksum metadata in `prepared-source.json`. Keep prepared files, reports, and raw CSVs outside the published package; the published package contains the fixed manifest and source-license copy, not a duplicate nationwide dataset.

Task 18 completed actual packed-consumer acceptance on 2026-09-17. The core-only consumer ran the installed CLI preparation/check without PostgreSQL or React dependencies. The installed CLI then imported and activated this same full pinned snapshot in a fresh PostgreSQL 18.3 database: 31 provinces, 342 level-2 rows, 2,978 level-3 rows, 41,352 level-4 rows, and 620,573 level-5 rows (665,276 total). The successful runtime import reported 948,422 ms and peak RSS 257,924 KiB; this was artifact-integrity acceptance, not a repeated performance benchmark.

Real Node/Next queries and Chrome UI flows at 1280/390 widths used that database, including same-name paths, target levels, selection submission, and administrative updates. After setup, the restarted Node/Next processes passed queries and submissions under an external-network guard with zero external attempts; Chrome likewise attempted no external resources. This process-level check does not imply OS network isolation or data freshness beyond the pinned source date. The final documentation-only package was freshly installed and its non-document bytes matched the runtime-tested package.


### Acceptance evidence scope after subsequent fixes

The full nationwide-database, Chrome UI, and offline results above belong to the Task 18 runtime artifact with SHA-256 `5392a2cfabb025ef410d5063beaa5756be0a588b6c7254f3b8357d2bd673a12f` and its documentation-only successor `2013198e001fc04ab959308bf8b3f385263996fcb9fddf5404c09d2bab9d5249`. Later fixes changed controlled selection, manager request races, display-label handling, and custom-schema CLI routing. Those historical full-run results must not be read as full browser/offline acceptance of later package bytes. Current-package installation, type, boundary, and focused regression results are recorded separately by maintainers; the nationwide import/performance and complete browser/offline runs have not been repeated after those fixes.
