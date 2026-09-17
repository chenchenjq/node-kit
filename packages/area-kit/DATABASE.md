# Database integration

`area-kit` uses one PostgreSQL library with two tables. The host runs the migration explicitly and owns connection pooling, migration bookkeeping, backups, privileges, and any application address table.

```ts
import { areaMigrationSql, createAreaTables } from "area-kit/postgres";

export const sqlForHostMigration = areaMigrationSql("public");
export const tablesForHostQueries = createAreaTables("public");
```

## Schema and relationships

`area_dataset` is one immutable source identity plus mutable lifecycle/import metadata. `id` is the dataset identity; `version_code` is unique and stable for the pinned source rules.

| Field | PostgreSQL type | Null/default | Meaning |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key, `gen_random_uuid()` | dataset identity |
| `version_code`, `source`, `source_commit`, `rules_version`, `code_scheme` | `text` | not null | source identity and parsing rules |
| `data_as_of`, `source_published_at` | `date` | not null | source dates |
| `file_checksums`, `coverage` | `jsonb` | not null | input manifest and coverage |
| `level_counts` | `jsonb` | not null, `{}` | counts by level |
| `status` | `text` | not null, `importing` | lifecycle state |
| `is_active` | `boolean` | not null, `false` | selected read snapshot |
| `import_progress`, `import_report` | `jsonb` | not null, `{}` | bounded progress and audit result |
| `imported_at` | `timestamptz` | nullable | set exactly for ready data |
| `created_at`, `updated_at` | `timestamptz` | not null, `now()` | row timestamps |

`area_region` belongs to one dataset and keeps the original code/name plus host presentation state.

| Field | PostgreSQL type | Null/default | Meaning |
| --- | --- | --- | --- |
| `id` | `uuid` | primary key, `gen_random_uuid()` | node identity |
| `dataset_id` | `uuid` | not null | owning snapshot |
| `code`, `source_name` | `text` | not null | untouched source fields |
| `level` | `smallint` | not null | level 1 through 5 |
| `parent_id` | `uuid` | nullable | same-dataset direct parent; null only at level 1 |
| `node_kind` | `text` | not null | `region`, `group`, `statisticalUnit`, or `unknown` |
| `display_name` | `text` | nullable | host override; null uses source name |
| `sort` | `integer` | not null, `0` | host ordering |
| `enabled` | `boolean` | not null, `true` | host availability |
| `revision` | `integer` | not null, `1` | optimistic-write revision |
| `created_at`, `updated_at` | `timestamptz` | not null, `now()` | row timestamps |

```mermaid
erDiagram
  area_dataset ||--o{ area_region : contains
  area_region o|--o{ area_region : parent
  area_dataset {
    uuid id PK
    text version_code UK
    text source_commit
    text status
    boolean is_active
    jsonb file_checksums
  }
  area_region {
    uuid id PK
    uuid dataset_id FK
    text code
    smallint level
    uuid parent_id FK
    text source_name
    integer revision
  }
```

## Source-to-schema mapping

The importer retains the source code and name exactly and derives the `parent_id` from the source ancestor columns. It does not infer parentage from code prefixes or names.

| Source CSV | Level | Source columns used for ancestry | Persisted mapping |
| --- | ---: | --- | --- |
| `provinces.csv` | 1 | `code`, `name` | root `area_region` |
| `cities.csv` | 2 | `provinceCode`, `code`, `name` | parent province |
| `areas.csv` | 3 | `provinceCode`, `cityCode`, `code`, `name` | parent city |
| `streets.csv` | 4 | `provinceCode`, `cityCode`, `areaCode`, `code`, `name` | parent county/district |
| `villages.csv` | 5 | `provinceCode`, `cityCode`, `areaCode`, `streetCode`, `code`, `name` | parent township/street |

The only navigation-group classification is fixed, source-and-commit-specific evidence for nine level-2 tuples (`1101`, `1201`, `3101`, `5001`, `5002`, `4190`, `4290`, `4690`, `6590`). Other special-looking names remain `unknown`; a name alone never establishes administrative meaning. `versionCode` is the stable source identity `modood-administrative-divisions-of-china:c49d495b40ac73eb1a66f6eeae5f8fd10696f035:v1`, not a statement that the data is current.

Store address snapshots in host-owned records as `datasetId`, `versionCode`, validated endpoint `code`, and the returned `pathCodes`/`pathNames`. These snapshots preserve historical presentation even when a later dataset becomes active. Do not overwrite old addresses during activation; resolve them against their saved dataset when it remains available.

## Constraints and indexes

`area_dataset` has primary key `area_dataset_pkey`, unique `area_dataset_version_code`, and partial unique index `area_dataset_one_active` on a constant where `is_active`. Its checks are `area_dataset_status` (`importing`, `ready`, or `failed`), `area_dataset_active_ready` (an active row is ready), and `area_dataset_imported_ready` (ready status is equivalent to non-null `imported_at`).

`area_region` has primary key `area_region_pkey`; unique `area_region_dataset_id_pair` on `(dataset_id, id)`; and unique `area_region_dataset_code` on `(dataset_id, code)`. `area_region_dataset` references `area_dataset(id)` with `ON DELETE RESTRICT`. `area_region_same_dataset_parent` references `(dataset_id, id)` on `area_region`, also `ON DELETE RESTRICT`, preventing cross-dataset parents.

Its checks are `area_region_level` (1 through 5), `area_region_revision` (greater than zero), `area_region_code_nonblank` and `area_region_source_name_nonblank` (each matches `[^[:space:]]`), `area_region_node_kind` (the four values above), and `area_region_root` (level 1 has null parent; lower levels have non-null parent). Index `area_region_parent_sort_code` is `(dataset_id, parent_id, sort, code)` and `area_region_level_sort_code` is `(dataset_id, level, sort, code)`.

## Transaction and cache responsibilities

Import writes a full dataset, re-audits it, and marks it ready only after verification; activation chooses the one ready active dataset. `updatePresentation` checks the caller's `admin.write` authorization and exact revision inside a write transaction. The host must invalidate cache entries for every process after a successful presentation change. The package owns neither external caches nor host address writes.
