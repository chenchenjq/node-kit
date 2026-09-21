-- One library, two tables. Execute explicitly through the host migration system.
-- Custom schemas must already exist; areaMigrationSql validates and qualifies them.
CREATE TABLE "public"."area_dataset" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_code text NOT NULL,
  source text NOT NULL,
  source_commit text NOT NULL,
  rules_version text NOT NULL,
  code_scheme text NOT NULL,
  data_as_of date NOT NULL,
  source_published_at date NOT NULL,
  file_checksums jsonb NOT NULL,
  coverage jsonb NOT NULL,
  level_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'importing',
  is_active boolean NOT NULL DEFAULT false,
  import_progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  import_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "public"."area_dataset" ADD CONSTRAINT area_dataset_version_code UNIQUE (version_code);
ALTER TABLE "public"."area_dataset" ADD CONSTRAINT area_dataset_status CHECK (status IN ('importing', 'ready', 'failed'));
ALTER TABLE "public"."area_dataset" ADD CONSTRAINT area_dataset_active_ready CHECK (NOT is_active OR status = 'ready');
ALTER TABLE "public"."area_dataset" ADD CONSTRAINT area_dataset_imported_ready CHECK ((status = 'ready') = (imported_at IS NOT NULL));
CREATE UNIQUE INDEX area_dataset_one_active ON "public"."area_dataset" ((1)) WHERE is_active;

CREATE TABLE "public"."area_region" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  code text NOT NULL,
  source_name text NOT NULL,
  level smallint NOT NULL,
  parent_id uuid,
  node_kind text NOT NULL,
  display_name text,
  sort integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_dataset_id_pair UNIQUE (dataset_id, id);
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_dataset_code UNIQUE (dataset_id, code);
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_dataset
  FOREIGN KEY (dataset_id) REFERENCES "public"."area_dataset" (id) ON DELETE RESTRICT;
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_same_dataset_parent
  FOREIGN KEY (dataset_id, parent_id) REFERENCES "public"."area_region" (dataset_id, id) ON DELETE RESTRICT;
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_level CHECK (level BETWEEN 1 AND 5);
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_revision CHECK (revision > 0);
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_code_nonblank CHECK (code ~ '[^[:space:]]');
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_source_name_nonblank CHECK (source_name ~ '[^[:space:]]');
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_node_kind CHECK (node_kind IN ('region', 'group', 'statisticalUnit', 'unknown'));
ALTER TABLE "public"."area_region" ADD CONSTRAINT area_region_root
  CHECK ((level = 1 AND parent_id IS NULL) OR (level > 1 AND parent_id IS NOT NULL));
CREATE INDEX area_region_parent_sort_code ON "public"."area_region" (dataset_id, parent_id, sort, code);
CREATE INDEX area_region_level_sort_code ON "public"."area_region" (dataset_id, level, sort, code);
