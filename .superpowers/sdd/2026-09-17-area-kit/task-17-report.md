# Task 17 report

## Delivered documentation

Added the four published package documents:

- `packages/area-kit/README.md` covers tgz installation, explicit host dependency injection, migration ownership, prepared-data workflow, dry-run/audit, batch import/resume/activation, authorization/request protection, cache invalidation, and a controlled React selection example.
- `packages/area-kit/DATABASE.md` documents the two-table PostgreSQL model, constraints and indexes, five-CSV ancestry mapping, exact fixed navigation-group evidence, stable `versionCode`, and host-owned historical address snapshots.
- `packages/area-kit/DATA-SOURCE.md` records the Task 16 source commit, dates, each verified count/byte/checksum, environment/batch-size evidence, coverage exclusions, full-audit versus sampling boundary, source update limit, and prepared-data/license handling.
- `packages/area-kit/AI-USAGE.md` states public query/validation parameters, defaults, results and rejection reasons; host integration placement; historical snapshot retention; and the required Chinese operating instruction verbatim.

The documentation deliberately says that Task 18 packed-consumer and browser results are not yet verified. It only lists the actual Task 16 environment evidence (Node v22.22.1, Drizzle 0.45.2, PostgreSQL 18.3 and the pinned source snapshot).

Copied the upstream WTFPL v2 text to `packages/area-kit/licenses/Administrative-divisions-of-China.LICENSE.txt`. Byte-for-byte comparison with the Task 16 prepared upstream `LICENSE` succeeded.

The Next example now explicitly returns the public `AreaAdminClient` type and passes a controlled level-3 cascader value/change handler. This keeps the read example usable by the administrative example page without adding internal imports or fabricated host wiring.

## Installed-consumer documentation check

Added `packages/area-kit/scripts/check-doc-examples.mjs`. It accepts only `--consumer-dir <absolute-dir>`, reads the four fixed document names from `<consumer>/node_modules/area-kit`, writes independent TS/TSX files to `<consumer>/doc-examples`, requires at least one block from every document, and invokes that consumer's own `node_modules/typescript/bin/tsc`. It uses NodeNext resolution from the consumer directory and removes `NODE_PATH`; it does not use workspace path aliases.

## Focused verification

All commands below exited 0.

```sh
cd packages/area-kit && npm run typecheck
node --check packages/area-kit/scripts/check-doc-examples.mjs
git diff --check
```

A fresh temporary consumer was initialized, installed with the locally packed `area-kit-0.0.0.tgz` plus its TypeScript/peer type dependencies, then checked with:

```sh
cd packages/area-kit
node scripts/check-doc-examples.mjs --consumer-dir /tmp/area-task17-consumer
```

It reported: `Compiled 7 documentation examples from installed area-kit.` The tarball contents included all four documents and the upstream license copy. Package build, unit tests, PostgreSQL tests, and browser checks were not rerun because this task only changes documentation, the consumer checker, and type-only Next example annotations; Task 18 remains the final packed-consumer/browser verification.

## Follow-up correction

The follow-up review corrected the validation result shape: `NOT_SELECTABLE` is a resolved rejection that retains code, level, and canonical path, not an unresolved null result. `AI-USAGE.md` now documents exact selector, paging, batch, search, tree, validation-version-policy, parameter, default, and return limits from the server contracts.

`README.md` now states that `AREA_KIT_DATABASE_URL` is required for both import and activation, that the import command's final `DatasetSummary` stdout supplies `datasetId`, and that `--activate` performs the equivalent activation in the import invocation. `DATABASE.md` now enumerates every field type/nullability/default, check, unique/partial index, and foreign key from the migration.

### Follow-up verification evidence

The focused follow-up commands exited 0:

```sh
cd packages/area-kit
npm run typecheck
node --check scripts/check-doc-examples.mjs
node scripts/check-doc-examples.mjs --consumer-dir /tmp/area-task17-followup-consumer.LkCIhr
git diff --check
```

The final command compiled 7 extracted examples from the newly packed, installed `area-kit` tarball. No implementation, unit, PostgreSQL, build, or browser checks were rerun because the follow-up changes documentation only.
