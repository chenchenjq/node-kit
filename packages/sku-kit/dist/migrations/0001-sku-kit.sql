-- The host reviews and executes this migration explicitly. The Drizzle schema is the typed reference.
CREATE TABLE IF NOT EXISTS sku_scope_config (
  scope_key varchar(128) PRIMARY KEY,
  currency varchar(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  inventory_authority_kind text NOT NULL,
  authority_key text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sku_product_config (
  scope_key varchar(128) NOT NULL,
  spu_id varchar(128) NOT NULL,
  registered_spu_code varchar(126) NOT NULL,
  structure_version bigint NOT NULL DEFAULT 0,
  next_sequence smallint NOT NULL DEFAULT 0 CHECK (next_sequence BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_key, spu_id),
  UNIQUE (scope_key, registered_spu_code)
);

CREATE TABLE IF NOT EXISTS sku_dimension (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key varchar(128) NOT NULL,
  spu_id varchar(128) NOT NULL,
  label varchar(64) NOT NULL,
  normalized_label varchar(64) NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  FOREIGN KEY (scope_key, spu_id) REFERENCES sku_product_config(scope_key, spu_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sku_dimension_active_name
  ON sku_dimension(scope_key, spu_id, normalized_label) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sku_dimension_owner_id ON sku_dimension(scope_key, spu_id, id);

CREATE TABLE IF NOT EXISTS sku_value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension_id uuid NOT NULL REFERENCES sku_dimension(id),
  scope_key varchar(128) NOT NULL,
  spu_id varchar(128) NOT NULL,
  label varchar(128) NOT NULL,
  normalized_label varchar(128) NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  FOREIGN KEY (scope_key, spu_id) REFERENCES sku_product_config(scope_key, spu_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sku_value_active_name
  ON sku_value(dimension_id, normalized_label) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sku_value_owner_id ON sku_value(scope_key, spu_id, id);

CREATE TABLE IF NOT EXISTS sku_sku (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key varchar(128) NOT NULL,
  spu_id varchar(128) NOT NULL,
  sku_code varchar(128) NOT NULL,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 0 AND 99),
  combination_key text NOT NULL,
  suggested_retail_price numeric(18,2) CHECK (suggested_retail_price >= 0),
  supply_price numeric(18,2) CHECK (supply_price >= 0),
  image_adapter varchar(64),
  image_value text,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'enabled', 'archived')),
  config_version bigint NOT NULL DEFAULT 1 CHECK (config_version > 0),
  archived_at timestamptz,
  FOREIGN KEY (scope_key, spu_id) REFERENCES sku_product_config(scope_key, spu_id),
  UNIQUE (scope_key, sku_code),
  UNIQUE (scope_key, spu_id, sequence),
  UNIQUE (scope_key, spu_id, combination_key),
  UNIQUE (scope_key, spu_id, id)
);

CREATE TABLE IF NOT EXISTS sku_selection (
  sku_id uuid NOT NULL REFERENCES sku_sku(id),
  scope_key varchar(128) NOT NULL,
  spu_id varchar(128) NOT NULL,
  dimension_id uuid NOT NULL REFERENCES sku_dimension(id),
  value_id uuid NOT NULL REFERENCES sku_value(id),
  PRIMARY KEY (sku_id, dimension_id),
  FOREIGN KEY (scope_key, spu_id, sku_id) REFERENCES sku_sku(scope_key, spu_id, id),
  FOREIGN KEY (scope_key, spu_id, dimension_id) REFERENCES sku_dimension(scope_key, spu_id, id),
  FOREIGN KEY (scope_key, spu_id, value_id) REFERENCES sku_value(scope_key, spu_id, id)
);

CREATE TABLE IF NOT EXISTS sku_local_inventory (
  sku_id uuid PRIMARY KEY REFERENCES sku_sku(id),
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sku_command_receipt (
  scope_key varchar(128) NOT NULL,
  spu_id varchar(128) NOT NULL,
  command_id varchar(128) NOT NULL,
  command_type varchar(64) NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope_key, spu_id, command_id)
);
