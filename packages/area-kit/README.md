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
