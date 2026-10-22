-- Reference only. Host must review/add this to its own migration system. Not run automatically.
CREATE TABLE oss_kit_storage (
  scope text NOT NULL, id text NOT NULL, name text NOT NULL,
  region text NOT NULL, bucket text NOT NULL, endpoint text NOT NULL,
  access text NOT NULL CHECK (access IN ('private', 'public')), public_domain text,
  credential_envelope text NOT NULL, enabled boolean NOT NULL, is_default boolean NOT NULL,
  used boolean NOT NULL, revision integer NOT NULL,
  PRIMARY KEY (scope, id), CONSTRAINT oss_kit_default_enabled CHECK (NOT is_default OR enabled)
);
CREATE UNIQUE INDEX oss_kit_one_default ON oss_kit_storage(scope) WHERE enabled AND is_default;
CREATE TABLE oss_kit_strategies (scope text NOT NULL, code text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(scope, code));
-- Example HOST business table; use your own file/attachment records instead when integrating.
CREATE TABLE oss_kit_files (id text PRIMARY KEY, scope text NOT NULL, owner_id text NOT NULL, reference jsonb NOT NULL);
