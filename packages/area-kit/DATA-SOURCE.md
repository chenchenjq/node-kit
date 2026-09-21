# Data source and provenance

This package's fixed manifest describes the five CSV files from [modood/Administrative-divisions-of-China](https://github.com/modood/Administrative-divisions-of-China) at commit `c49d495b40ac73eb1a66f6eeae5f8fd10696f035`. The snapshot date is 2023-06-30 and the source publication date is 2023-09-11. It is a statistical-source snapshot, not a promise of current administrative status.

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
