-- Reference only. Adapt table names through the host migration system. Never automatically run in production.
CREATE TABLE ai_kit_connections (
 scope text NOT NULL, id text NOT NULL, name text NOT NULL, provider_code text NOT NULL,
 protocol text NOT NULL CHECK (protocol IN ('openai-chat','openai-responses','anthropic-messages')),
 base_url text NOT NULL, credential_envelope text NOT NULL, enabled boolean NOT NULL,
 revision integer NOT NULL CHECK (revision>0), tested_revision integer,
 PRIMARY KEY(scope,id)
);
CREATE TABLE ai_kit_plans (
 scope text NOT NULL, id text NOT NULL, code text NOT NULL, name text NOT NULL,
 connection_id text NOT NULL, model_id text NOT NULL, enabled boolean NOT NULL,
 is_default boolean NOT NULL CHECK (NOT is_default OR enabled), system_prompt text,
 parameters jsonb NOT NULL, revision integer NOT NULL CHECK (revision>0),
 PRIMARY KEY(scope,code), UNIQUE(scope,id),
 FOREIGN KEY(scope,connection_id) REFERENCES ai_kit_connections(scope,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ai_kit_one_enabled_default ON ai_kit_plans(scope) WHERE enabled AND is_default;
-- Optional fallback dictionary tables; omit these if the host already provides DictionaryPort.
CREATE TABLE ai_kit_dictionary_types(scope text NOT NULL, code text NOT NULL, name text NOT NULL, PRIMARY KEY(scope,code));
CREATE TABLE ai_kit_dictionary_items(scope text NOT NULL, type text NOT NULL, code text NOT NULL, name text NOT NULL, sort integer NOT NULL, enabled boolean NOT NULL,
 PRIMARY KEY(scope,type,code), FOREIGN KEY(scope,type) REFERENCES ai_kit_dictionary_types(scope,code) ON DELETE RESTRICT);
