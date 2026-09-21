# Task 16 report

## Result and implementation

Task 16's real five-level verification completed successfully. Implementation commit: `a0b2ebc9` (`test(area-kit): verify the complete source snapshot and database import`). The required full run exited **0**, with `passed: true` and `synthetic: false`. This documentation-only follow-up records the existing evidence; it does not rerun the nationwide import.

Implemented:

- `packages/area-kit/scripts/verify-full.mjs`: explicit existing source directory, external report directory, current CLI build, pinned disposable PostgreSQL, scrubbed PostgreSQL environment, observed container metadata, and cleanup through `withPostgres`.
- `packages/area-kit/scripts/full-check.ts`: independent CSV sample extraction and checksum/count verification; actual CLI import/activation/replay; database management report comparison; independent SQL counts and parent checks; actual source query/selection cases; 10 query benchmarks with real SQL capture and EXPLAIN.
- `packages/area-kit/test/fixtures/actual-samples.json` and `test/actual-samples.test.ts`: a small checked-in actual-source fixture and five pure policy/provenance tests. Ordinary unit tests do not import national data or start PostgreSQL.
- CLI/source/import progress on stderr, preparation timing persistence, import process peak RSS, and TypeScript checking of verification scripts. CLI JSON results remain on stdout.

## RED / negative / GREEN evidence

**No completed functional RED run of an intentionally unfinished full verifier was recorded.** A temporary unfinished checker existed during authoring, but source preparation had not succeeded before implementation proceeded. The planned first functional RED from Task 16 Step 2 was therefore not demonstrated. This report does not reclassify a network/environment failure as a functional test RED, and does not claim a RED-to-GREEN transition that was not observed.

Observed negative evidence:

1. Initial explicit `data:prepare` attempts exited 1 with `IMPORT_CONFLICT`. Four CSVs were present after the first attempt; the village CSV was not complete. The fixed village URL subsequently took 79 seconds through curl, whereas the downloader has a 30-second deadline. A separate direct Node fetch of README timed out at 15 seconds. These are preparation/network observations, not full verification assertion failures; the CLI's sanitized error did not preserve a transport traceback proving the exact cause of every failed attempt.
2. The nonexistent-data guard command below exited 1 with ENOENT, before any database run or download. Its report says `passed: false`, `verified: false`, `phase: environment`.
3. During the successful full run, activation of an intentionally injected failed dataset was rejected with `VERSION_UNAVAILABLE`. The active actual dataset was unchanged. The injected metadata row was then removed; nationwide region rows always came from the real source.

GREEN evidence:

- Actual full verification command: exit 0, all assertions and all ten benchmarks completed.
- `npm --prefix packages/area-kit run test -- test/actual-samples.test.ts`: **1 file, 5 tests passed** (221 ms overall Vitest duration; tests 9 ms).
- `npm --prefix packages/area-kit run build`: passed.
- `npm --prefix packages/area-kit run typecheck`: passed, including `scripts/**/*.ts`.
- `node --check packages/area-kit/scripts/verify-full.mjs`: passed.
- `git diff --check`: passed.
- Direct percentile checks passed: median of `[30,10,20]` is 20, nearest-rank p95 of 1–30 is 29, empty samples throw.
- After adding preparation telemetry, cached `data:prepare` exited 0 and recorded 293.311449 ms, peak RSS 68,440 KiB. This is cache verification timing, not a fresh download benchmark.

Only the focused new unit test and required full-data run were executed; unrelated package suites were not rerun.

## Commands and preparation provenance

Working directory for the following npm commands: `/home/node-kit/.worktrees/area-kit`.

```sh
npm --prefix packages/area-kit run data:prepare -- --dir /tmp/area-kit-source-c49d495b
```

After preparation failed, the exact pinned village file was retrieved separately:

```sh
curl -L --fail --max-time 180 \
  --output /tmp/area-kit-source-c49d495b/dist/villages.csv.download \
  https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/c49d495b40ac73eb1a66f6eeae5f8fd10696f035/dist/villages.csv
```

The downloaded file was renamed to `villages.csv` only after independent verification of its 37,730,558-byte length and SHA-256. No source transformation or replacement snapshot was used.

This environment supplies lowercase HTTP proxy settings. An uncommitted `/tmp/area-kit-proxy-preload.mjs` used the already installed `undici` `EnvHttpProxyAgent` and `setGlobalDispatcher` so Node fetch could use that environment proxy; it contained no credentials. The successful explicit preparation invocation, run from a Python timing wrapper, was equivalent to:

```sh
NODE_OPTIONS='--import /tmp/area-kit-proxy-preload.mjs' \
  npm --prefix packages/area-kit run data:prepare -- --dir /tmp/area-kit-source-c49d495b
```

It exited 0 in **3,732.525441 ms**, verifying existing raw CSVs and fetching README/LICENSE. That measurement is retained inside the full report's `preparationMeasurement`. It does not represent downloading all five files from an empty directory. The prepared provenance record's retrieval timestamp is `2026-09-17T13:23:57.633Z`.

Full verification:

```sh
npm --prefix packages/area-kit run test:full -- \
  --data-dir /tmp/area-kit-source-c49d495b \
  --report-dir /tmp/area-kit-full-report
```

Missing-source negative check:

```sh
node packages/area-kit/scripts/verify-full.mjs \
  --data-dir /tmp/area-kit-source-does-not-exist \
  --report-dir /tmp/area-kit-full-missing-source
```

The full verifier never downloads source data automatically. All database connection settings came from the newly created pinned test container, with database restricted to `area_kit_ephemeral_test`.

## Source and database evidence

Source: `https://github.com/modood/Administrative-divisions-of-China`.
Pinned commit: `c49d495b40ac73eb1a66f6eeae5f8fd10696f035`.
Snapshot date: `2023-06-30`; source publication date: `2023-09-11`.
Version: `modood-administrative-divisions-of-china:c49d495b40ac73eb1a66f6eeae5f8fd10696f035:v1`.

The standalone raw reader independently verified every file's byte count, SHA-256, and CSV row count. The actual CLI then audited the source, re-audited a private normalized snapshot, imported it, and computed database digests. The resulting import report was compared with the database management API report. Each level's source and database digest matched.

| CSV | Level | Rows | Bytes | Raw SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `dist/provinces.csv` | 1 | 31 | 532 | `b17e76dab634e24e0f56021f15737c0a526dc7f0c4e39d21abeba5a8668383cd` |
| `dist/cities.csv` | 2 | 342 | 7,580 | `a9c818e8a5120189173668b40882ce8bf59a7ec2b057c49d7a724a04bec727f2` |
| `dist/areas.csv` | 3 | 2,978 | 85,403 | `169b8d99654c28cbd285e771e00688837f77af8d50c2b703592146388d2a99ab` |
| `dist/streets.csv` | 4 | 41,352 | 1,630,789 | `831dc1c483079cee166717118e57f4b69ef6212c699dbd4bff868b59513ac14b` |
| `dist/villages.csv` | 5 | 620,573 | 37,730,558 | `31a824829aeef7b472fced6a3f9f8321cbd9fb26661052be98904f9763ec88ce` |

Total: **665,276 rows**. Raw CSV bytes: **39,454,862**. Normalized bytes for one complete audit: **109,735,500**.

For every level, conflict, missing-parent, ancestor-mismatch, invalid, and duplicate counts were zero. Independent SQL counted all five levels and LEFT JOINed parents to check missing parents, cross-dataset parents, and wrong parent levels; all three defect counts were zero at every level.

The empty database returned `NOT_INITIALIZED`. Initial import returned ready/inactive and default reads still returned `NOT_INITIALIZED`; the explicit dataset was readable. Explicit CLI activation then made it active. Failed-version activation was rejected without changing the active version.

Dataset ID for this run: `3567a72c-87da-42de-8c11-ea6316749c30`. A local presentation update changed display name, sort and enabled state before repeating the real import. Repeated import returned the same dataset ID and active state. A database fingerprint over **all region IDs, codes, display names, sort values, enabled flags, and revisions** remained `286d88a3fd9c6316b0e50927178641aa`. The fixture presentation update was restored after the check. The fingerprint is an MD5 equality check for the test's complete settings snapshot; source provenance and canonical source/database digests use SHA-256.

## Actual source samples

The oracle reads original CSV ancestor fields and names; it never calls `getPath` to construct its expected result.

- Ordinary five-level path: `13 → 1301 → 130102 → 130102001 → 130102001001`, 河北省 / 石家庄市 / 长安区 / 建北街道 / 棉一东社区居民委员会.
- Nine exact navigation groups: `1101`, `1201`, `3101`, `5001`, `5002`, `4190`, `4290`, `4690`, `6590`. Source names and parent paths matched; selection endpoints remained `NAVIGATION_ONLY`.
- Same-name city/county pairs for 东莞市、中山市、儋州市 retain separate codes and levels; repeated county names are also sampled and searchable.
- Six names matching special-looking vocabulary were selected from raw CSV only for coverage. Their kinds remained `unknown`; names did not create classification evidence.
- Coverage excludes HK/MO/TW, and codes `71`, `81`, `82` returned `UNKNOWN_CODE`.

The full run checked five-level path names/codes, each level's list and code search, a valid level-5 submission, wrong-ancestry rejection, all group samples, same-name results, and unknown classification. Sample selection criteria and raw-backed ancestor nodes are stored with the fixture.

## Runtime and performance

Run start: `2026-09-17T13:24:20.112Z`; completed: `2026-09-17T13:40:33.014Z`.

| Phase | Milliseconds |
| --- | ---: |
| rawVerificationAndSampleExtraction | 4924.391 |
| import | 505806.339 |
| activate | 2307.493 |
| repeat-import | 414854.408 |
| total | 972902.244 |

The import times include source audits and database verification, not just INSERT execution. First import's initial source audit was 35,919 ms; repeated import's initial source audit was 94,983 ms. Database digest pagination was a substantial component of the runtime; the observed implementation repeatedly orders/scans village rows. No import/index optimization was introduced to alter the measured baseline, and no earlier 58.6-second figure was reused.

Environment: Intel Core i5-7300HQ @ 2.50 GHz, 4 CPUs reported, 20,817,633,280 RAM bytes; Linux `6.8.0-138-generic`; Node `v22.22.1`; Drizzle `0.45.2`; PostgreSQL `18.3` on Alpine/musl x86_64. Batch size: 1,000.

Pinned image: `postgres@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7`. Docker inspect observed memory limit 0 and NanoCPU limit 0 (no explicit container limits), with `/var/lib/postgresql` on tmpfs. The verifier's attempted cgroup-v2 files were unavailable (`null`), so they are not presented as measured host cgroup limits.

Peak RSS: verifier **207,096 KiB**; first import CLI **355,764 KiB**; repeated import CLI **267,016 KiB**. Activation child peak RSS was not collected and remains null.

Each benchmark recorded its first request, ran three warmups, then 30 measured requests. SQL capture counts include BEGIN, transaction setup and COMMIT. Every captured SELECT/WITH statement from the first request has an actual `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan in the report. No guessed plans or hardcoded timings were used.

| Query | First ms | p50 ms | p95 ms | DB statements/request |
| --- | ---: | ---: | ---: | ---: |
| single-code | 25.698 | 16.675 | 19.033 | 7 |
| batch-code | 15.479 | 13.995 | 16.078 | 7 |
| five-level-path | 18.122 | 15.520 | 17.048 | 8 |
| township-children-first | 14.359 | 14.686 | 17.735 | 9 |
| township-children-tail | 17.152 | 14.397 | 19.271 | 9 |
| village-children-first | 30.380 | 15.804 | 16.933 | 9 |
| village-children-tail | 15.863 | 13.714 | 16.391 | 9 |
| ancestor-range | 30.668 | 23.820 | 24.722 | 9 |
| same-name-search | 151.626 | 250.744 | 401.015 | 9 |
| code-search | 344.051 | 269.775 | 322.755 | 9 |

First-request timing is the first request **of that benchmark after functional verification**, not a cold-cache claim. These are single-environment observations with no production latency promise or concurrency/load-test claim. Search is materially slower than indexed code/path requests in this run.

## Artifacts and cleanup

Artifacts are outside the package and were not committed or added to package contents:

- `/tmp/area-kit-full-report/full-verification.json`: success, environment, timing, dataset, repeated-import fingerprint, sample count SQL, per-request samples, query counts, and execution plans.
- `/tmp/area-kit-full-report/source-audit.json`: all five file checksums, actual import report, canonical source/database digests, independent SQL counts/relationships.
- `/tmp/area-kit-full-report/source-samples.json`: source-derived oracle and selection basis.
- `/tmp/area-kit-full-report/container-environment.json`: actual Docker inspect result.
- `/tmp/area-kit-full-report/import.log`, `activate.log`, `failed-activation.log`, `repeat-import.log`: CLI progress/results and expected failed activation.
- `/tmp/area-kit-full-report/first-import/` and `repeat-import/`: source reports, import reports, and five normalized files per audit.
- `/tmp/area-kit-source-c49d495b/`: raw source CSVs, README/LICENSE, prepared provenance record, and latest preparation measurement.
- `/tmp/area-kit-full-missing-source/environment-failure.json`: missing-source negative evidence.

The specific temporary container `area-kit-test-04a90464-e649-45ea-b512-57625dd22a96` was removed by `withPostgres` cleanup; a filtered `docker ps` check returned no matching container. No application database was used, no package was published, and no credentials were committed.

## Evidence limits and final small changes

- Functional preimplementation RED was not recorded; preparation failures and the deliberate unavailable-dataset rejection are separately described above.
- The successful full run used the implemented import/query verification logic. During/following that run, runner preflight/report-path protections, current-build enforcement, automatic container metadata recording, report notes, and preparation timing persistence were finalized. These do not change the imported dataset or query assertions. Current build/typecheck and focused missing-source/cached-preparation checks passed afterward; the 16-minute full run was not repeated for those safety/telemetry changes.
- Docker metadata was captured while the container was alive and merged with explanatory measurement notes into the final report afterward. The final runner automates the same metadata capture; benchmark numbers and test outcomes were not edited.
- The full report retains the 3.733-second successful preparation measurement taken before that run. The source directory's `preparation-measurement.json` was later updated by the 293-ms cached-preparation telemetry check; those are different invocations.
- The `/tmp` artifacts remain inspectable in this environment but are not durable repository content. The committed small actual-source fixture retains provenance/checksums and source-backed samples. Full performance and import results should be regenerated on the deployment environment when production capacity decisions require them.
