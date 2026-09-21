# Task 18 — packed consumers, real browser and process-level offline acceptance

Status: complete, verified on 2026-09-17. No publication or push was performed.

## Delivered implementation

- `scripts/verify-pack.mjs`: actual SHA-addressed npm tarball and inventory, independent core/Node/Next consumers, lazy installed CLI preparation/check, installed documentation compiler, real fresh PostgreSQL initialization/activation, esbuild and Next browser boundaries, production Next build/start/routes, live same-session Playwright callback, offline process restart and JSON evidence. Services and the disposable database are stopped in finally blocks.
- `scripts/verify-browser.mjs`: public `--data-dir` starts a fresh real consumer/database acceptance; internal `--consumer-dir` checks the live parent session and service before executing consumer-owned Playwright/tsx with an explicit browser executable.
- `scripts/offline-guard.mjs`: test-only exact loopback/DB-host socket, TLS, DNS and fetch guard; logs only PID/host and is excluded from the tgz.
- `test/browser/area-flow.test.ts`: real database selection, protected business submission, native keyboard, same-name search/path fill, clear, transport recovery, delayed actual-response race, management label save/disable/restore/pagination, screenshots and overflow/page-error/external-resource assertions at 1280 and 390 widths.
- Four public documents now record actual results and the tested environment; package remains private and its existing explicit file/bin lists already contained every required asset.

## Actual findings and repairs

1. TypeScript 7 rejected installed-document explicit-file compilation alongside consumer tsconfig (TS5112). Added `--ignoreConfig`; all seven installed-document examples now compile.
2. The shipped Next example needed `.js` → `.ts`/`.tsx`/`.js` extension aliases for its NodeNext-style source imports. The verifier consumes that installed configuration and adds only test output-directory/CPU settings. Production builds explicitly use `next build --webpack`.
3. Next unexpectedly accepted a client import of the server entry. The browser sentinel now imports `server-only` and retains an explicit empty export table. Next and esbuild both reject server and postgres imports, with actual boundary diagnostics rather than missing dependencies/database errors.
4. A 390px viewport diagnostic found an 872px document caused by the dataset version select. Example form controls now constrain width; both actual browser pages at both widths passed no-overflow assertions. Narrow screenshots were visually inspected.
5. Independently bundled Next instrumentation/route modules had distinct `AreaKitError` constructors: valid 403/503 errors became QUERY_FAILED/500. Genuine errors now carry a shared symbol marker with validated public codes; foreign bundle subclass reasons remain intact and unbranded lookalikes remain sanitized. A real duplicate-module regression failed first and passed after the fix. The live production Next adapter subsequently returned both expected 403 and 503 responses before source import.
6. The initial browser transport-failure fixture aborted only one request and raced with controlled-component re-fetch. The final fixture sustains the outage until the retry button appears, then restores transport and clicks retry. Its first failure was retained in `debugAttempts`; the subsequent complete two-viewport browser run passed using the same live real DB/Next and unchanged runtime artifact. No synthetic API payload replaced the database.

## Accepted artifacts and consumers

Runtime artifact SHA-256: `5392a2cfabb025ef410d5063beaa5756be0a588b6c7254f3b8357d2bd673a12f`.
Runtime tgz: `/home/node-kit/.worktrees/area-kit/packages/area-kit/artifacts/5392a2cfabb025ef410d5063beaa5756be0a588b6c7254f3b8357d2bd673a12f.tgz`.
Runtime consumers: `/tmp/area-kit-pack-6ercjT/node` and `/tmp/area-kit-pack-6ercjT/next`, physically installed outside the repository (no source aliases or symlinks).

Final documentation artifact SHA-256: `2013198e001fc04ab959308bf8b3f385263996fcb9fddf5404c09d2bab9d5249`.
Final tgz: `/home/node-kit/.worktrees/area-kit/packages/area-kit/artifacts/2013198e001fc04ab959308bf8b3f385263996fcb9fddf5404c09d2bab9d5249.tgz`.
Final fresh consumers: `/tmp/area-kit-final-Luaul7/core`, `/tmp/area-kit-final-Luaul7/node`, `/tmp/area-kit-final-Luaul7/next`.
Each final install used its own previously empty `.npm-cache`; no previous consumer lockfile was reused. The final inventory exactly matches the runtime inventory. Every one of 102 non-document files matched the runtime-tested installed artifact byte for byte. Final core/server denied-read imports pass without React/pg/Drizzle, final Node imports pass without React, and final installed documentation compilation passes: `Compiled 7 documentation examples from installed area-kit.`. Final installation/document verification took 72084 ms.

## Database, HTTP, browser and offline evidence

- Source: `/tmp/area-kit-source-c49d495b`, pinned commit `c49d495b40ac73eb1a66f6eeae5f8fd10696f035`. Fresh PostgreSQL 18.3 import/activation reached ready+active with counts 31 / 342 / 2,978 / 41,352 / 620,573 (665,276 total).
- Successful installed CLI import reported elapsedMs=948422 and peakRssKiB=257924. This is package-integrity acceptance, not a repeated capacity benchmark.
- Real Node and production HTTP reads covered active dataset/provinces/children/five-level paths/same-name cursor pages/target levels 1–5/navigation-group rejection. Actual business submissions were validated and persisted through the example's same-connection host transaction; persisted records were checked in PostgreSQL.
- Both esbuild and Next accepted client-safe imports and rejected server/postgres Client Component imports. Next production build/start and authorization-before-initialization checks passed.
- Chrome 146.0.7680.164 (consumer Playwright 1.51.1) passed all six recorded viewport flow groups. Four success screenshots: `artifacts/selection-1280.png`, `manager-1280.png`, `selection-390.png`, `manager-390.png`. No horizontal page overflow, uncaught page errors, or external resource attempts.
- Offline preflight rejected nine independent external fetch/HTTP/HTTPS/socket/named ESM/DNS/TLS operations and allowed a real local request. After normal Next stopped, the new Next process and Node queries inherited the guard through NODE_OPTIONS. Full query/validation/business-submit/UI flows succeeded; `offline-requests.jsonl` is empty. This is process-level enforcement, **not OS network isolation**.
- Successful runtime runner elapsed 2093054 ms. Disposable acceptance PostgreSQL and Next processes were cleaned up; unrelated existing containers were untouched.
- Tested baseline: Node 22.22.1, Next 16.3.5, React 19.3.0, TypeScript 7.0.2, pg 8.23.0, Drizzle 0.45.2, PostgreSQL 18.3, Chrome 146.0.7680.164.

## Commands and test scope

- Initial `npm --prefix packages/area-kit run test:pack -- --data-dir /tmp/area-kit-source-c49d495b` created `/tmp/area-kit-pack-Q36rgl/{core,node,next}`. Core no-peer CLI prepare/full check, installed docs, consumer types, initial esbuild checks, full installed CLI import/activation and Node reads passed; the Next negative test correctly failed the overall attempt and triggered the production boundary fix. Initial import elapsed 694481 ms / peak RSS 245740 KiB. Its first-attempt JSON/log remains local history, not success evidence.
- The next early Next probe exposed the cross-bundle error and was deliberately stopped; it is not accepted evidence.
- `AREA_PACK_DEBUG=1 npm --prefix packages/area-kit run test:browser -- --data-dir /tmp/area-kit-source-c49d495b` passed the fresh complete runtime acceptance after the fixes. This public browser mode re-creates Node/Next/database and runs build boundaries, full source initialization, routes, offline checks and both browser viewports. It intentionally omits previously passed core preparation/document checks. The opt-in debug mechanism retained the real services for the one browser fixture correction; its failure remains recorded. Log: `/tmp/area-kit-task18-final-browser3.log`.
- `node /tmp/area-kit-finalize.mjs` passed final npm pack, inventory, three clean empty-cache installations, optional-peer checks, every non-document byte comparison and installed-doc compilation. Log: `/tmp/area-kit-task18-final-pack.log`. The committed main pack runner remains the normal all-in-one reproducible command; this finalization avoided repeating the already passing full database/browser run for Markdown-only changes.
- Final `npm --prefix packages/area-kit run typecheck` passed (`/tmp/area-kit-task18-typecheck-final.log`). Build passed in the accepted runtime preparation, and no production runtime source changed afterward.
- Initial package unit run: 122/124 passed; two CLI subprocess tests exceeded their existing 5s timeouts under simultaneous installation load. Only those cases were retried with `npm --prefix packages/area-kit test -- --maxWorkers=1 test/cli-import.test.ts test/source-audit.test.ts -t 'accepts import options|CLI check writes'`: 2 passed (24 tests in the files, 22 deliberately skipped), 4.30s.
- After the error fix, 27 affected contracts/HTTP/Next-route tests passed, including the newly added duplicate-module regression (`/tmp/area-kit-task18-cross-bundle-green.log`; prior red result in `...cross-bundle-red.log`). Thus all original 124 cases and the new regression were covered across the initial run and necessary targeted reruns, without claiming one final full-suite green execution. PostgreSQL/full-source implementation did not change, so earlier broad suites were not repeated; fresh full imports above verify the actual tgz.
- Final Node syntax checks for all three new `.mjs` tools, final git diff whitespace check, package inventory/private-package/credential review passed. No other package was changed.

## Committed evidence and remaining host work

Compact success evidence is committed at `packages/area-kit/artifacts/pack-verification.json`, `browser-verification.json`, `final-pack-verification.json`, and `verification.json`. Tarballs, screenshots, raw nationwide data, local logs, consumer lockfiles/caches and temporary databases are not committed or included in the tgz. JSON records retain actual local paths for this run; the package documents make no machine-specific links.

No required Task 18 functional acceptance remains unverified. This does not claim other runtime versions, OS network isolation, current source freshness, or production load capacity. The host must still configure its production PostgreSQL connection, migration/activation workflow, real authentication and authorization, request/origin protections, trusted selection policy, business persistence, and cache invalidation. No publishing, pushing, production authentication fixture, credentials, or second nationwide dataset was introduced.
