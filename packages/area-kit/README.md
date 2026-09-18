# area-kit

`area-kit` stores and serves a pinned five-level Chinese statistical-area snapshot. It exposes five public entry points only: `area-kit`, `area-kit/server`, `area-kit/postgres`, `area-kit/client`, and `area-kit/react`. The package does not ship the nationwide CSV files; a host prepares and imports them into PostgreSQL.

## Install and wire the host

Install the packed tarball with its peer dependencies in the consuming application. The host owns its database connection, migrations, authentication, authorization, request protection, and persistence.

```sh
npm install ./area-kit-0.0.0.tgz pg drizzle-orm react
```

The server factory is dependency injection only: it neither opens a connection nor executes a migration. Replace the sample context rule with the host's real permission rule.

```ts
import type { Pool } from "pg";
import { createDrizzleAreaStore } from "area-kit/postgres";
import { createAreaKit } from "area-kit/server";

export function connectAreaKit(pool: Pool) {
  return createAreaKit({
    store: createDrizzleAreaStore(pool),
    authorize: async (ctx: { canRead: boolean; canManage: boolean }, request) =>
      request.action === "read" ? ctx.canRead : ctx.canManage,
  });
}
```

Execute the SQL returned by `areaMigrationSql()` through the host migration system. It creates `area_dataset` and `area_region`; custom schemas must already exist. Importing and activating source data are explicit operations. `import` and `activate` both require the host to provide a non-empty `AREA_KIT_DATABASE_URL` PostgreSQL connection string. Keep that secret in the deployment environment, not source control or `.npmrc`.

```ts
import { areaMigrationSql } from "area-kit/postgres";

export const areaKitMigration = areaMigrationSql("public");
```

## Prepare, inspect, import, activate

Use a host-controlled directory outside the package for prepared inputs. `prepare` verifies existing pinned files and obtains missing fixed-source files. It also retains upstream `README.md` and `LICENSE` beside that prepared data. The package includes a copy of the source license and its fixed manifest, but not the raw national CSVs.

```sh
area-kit prepare --dir /srv/area-kit/prepared
area-kit check --dir /srv/area-kit/prepared --report-dir /srv/area-kit/reports/check
# The host has securely set AREA_KIT_DATABASE_URL before this command.
: "${AREA_KIT_DATABASE_URL:?set the host PostgreSQL connection string}"
area-kit import --dir /srv/area-kit/prepared --report-dir /srv/area-kit/reports/import
```

`check` is a dry run: it validates the manifest, CSV structure, duplicate/conflict and ancestry findings without changing the database. `import` creates or resumes the fixed dataset using batches of 1,000 and keeps locally edited presentation fields on an idempotent repeat import. Its final stdout JSON is the `DatasetSummary`; use its `datasetId` as `AREA_KIT_DATASET_ID` when activation is separate. A ready import is inactive until `activate` is explicitly called:

```sh
: "${AREA_KIT_DATABASE_URL:?set the host PostgreSQL connection string}"
area-kit activate --dataset-id "$AREA_KIT_DATASET_ID"
# Or activate the dataset returned by this import in the same database session:
area-kit import --dir /srv/area-kit/prepared --report-dir /srv/area-kit/reports/import --activate
```

Both database commands default to `public`. For a custom library, create its schema and run `areaMigrationSql("address_regions")` through the host migration system first, then pass the same trusted schema to every import and activation command and to the host's `schemaName` option:

```sh
area-kit import --schema address_regions --dir /srv/area-kit/prepared --report-dir /srv/area-kit/reports/import
area-kit activate --schema address_regions --dataset-id "$AREA_KIT_DATASET_ID"
# Combined import and activation use that same schema:
area-kit import --schema address_regions --dir /srv/area-kit/prepared --report-dir /srv/area-kit/reports/import --activate
```

`--schema` accepts a lowercase identifier matching `[a-z][a-z0-9_]{0,62}`. It is trusted operator configuration; never derive it from public HTTP inputs. Import inheritance also resolves its source dataset inside that selected schema.

Failed or interrupted imports have a report and cannot become active; resume with the same prepared directory after fixing the reported cause.

The migration, import, and activation are privileged host operations. Public reads must pass `authorize(..., { action: "read" })`; administration uses `admin.read` or `admin.write`. HTTP adapters must authenticate and protect every request, select the trusted validation policy on the server, bound request bodies, and return sanitized errors. `area-kit` has no cache: after `updatePresentation`, the host must invalidate every process's path, search, tree, and descendant-state caches.

## Browser and controlled selection

Create the browser client from the public client entry point. Its base URL is the host's protected adapter, not a database endpoint.

```ts
import { createAreaClient } from "area-kit/client";

export const areaClient = createAreaClient({ baseURL: "/api/area-kit" });
```

Use `AreaCascader` as a controlled component. Its status is an authoritative server validation response; only submit a value when `accepted` is true. The component's `policy` is for its local state only; the host must supply its trusted policy when validating the submitted address.

```tsx
"use client";

import { useState } from "react";
import { AreaCascader } from "area-kit/react";
import type { AreaValue, SelectionResult } from "area-kit";
import { createAreaClient } from "area-kit/client";

const client = createAreaClient({ baseURL: "/api/area-kit" });

export function AddressField() {
  const [value, setValue] = useState<AreaValue | null>(null);
  const [result, setResult] = useState<SelectionResult | null>(null);
  return <AreaCascader
    client={client}
    value={value}
    targetLevel={3}
    onChange={(nextValue) => setValue(nextValue)}
    onStatus={setResult}
  />;
}
```

See [DATABASE.md](./DATABASE.md), [DATA-SOURCE.md](./DATA-SOURCE.md), and [AI-USAGE.md](./AI-USAGE.md) before putting a snapshot into service.


## Verified packed acceptance

On 2026-09-17, the actual npm tarball was installed into independent core, Node, and Next consumers outside the repository. Core imports and CLI preparation/check worked without React, pg, or Drizzle; the Node consumer had no React. The installed CLI initialized and activated a fresh PostgreSQL database with all 665,276 rows of the pinned source. Installed documentation examples compiled, and the shipped Next example passed production build/start with `next build --webpack`. Browser-safe entries bundled successfully; importing either server entry from browser/Next client code failed as required.

Real Chrome flows passed at widths 1280 and 390: selection, keyboard operation, same-name search/path refill, clearing, transport retry, delayed-response races, business submission, and administrative save/disable/restore/pagination, with no page overflow or uncaught page errors. Node queries, Next routes, and submissions also passed under a process-level external-network guard with zero external attempts; this is not OS network isolation. The final documentation-only tarball was installed into three new consumers with empty npm caches, its seven documentation examples compiled, and every non-document file matched the runtime-tested tarball byte for byte. Maintainer JSON reports and screenshots remain outside the distributed package.

The tested baseline was Node 22.22.1, Next 16.3.5, React 19.3.0, TypeScript 7.0.2, pg 8.23.0, Drizzle 0.45.2, PostgreSQL 18.3, and Chrome 146.0.7680.164. This records one acceptance environment, not a general compatibility or capacity guarantee. The host still supplies production authentication, authorization, request protection/origin rules, trusted policies, persistence, migration execution, and dataset activation.


### Acceptance evidence scope after subsequent fixes

The full nationwide-database, Chrome UI, and offline results above belong to the Task 18 runtime artifact with SHA-256 `5392a2cfabb025ef410d5063beaa5756be0a588b6c7254f3b8357d2bd673a12f` and its documentation-only successor `2013198e001fc04ab959308bf8b3f385263996fcb9fddf5404c09d2bab9d5249`. Later fixes changed controlled selection, manager request races, display-label handling, and custom-schema CLI routing. Those historical full-run results must not be read as full browser/offline acceptance of later package bytes. Current-package installation, type, boundary, and focused regression results are recorded separately by maintainers; the nationwide import/performance and complete browser/offline runs have not been repeated after those fixes.
