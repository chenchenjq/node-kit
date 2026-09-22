import { pgSchema, text, timestamp, boolean, index, uniqueIndex, } from "drizzle-orm/pg-core";
function validNamespace(name) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(name) || name === "public")
        throw new Error("Use a dedicated lowercase PostgreSQL schema");
}
/** Host owns these table instances and executes reviewed migrations. No SQL runs here. */
export function createAuthSchema(namespace = "auth_kit") {
    validNamespace(namespace);
    const schema = pgSchema(namespace);
    const times = () => ({
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    });
    const user = schema.table("user", {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        email: text("email").notNull().unique(),
        emailVerified: boolean("email_verified").notNull().default(false),
        image: text("image"),
        phoneNumber: text("phone_number").notNull().unique(),
        phoneNumberVerified: boolean("phone_number_verified")
            .notNull()
            .default(false),
        enabled: boolean("enabled").notNull().default(true),
        ...times(),
    });
    const session = schema.table("session", {
        id: text("id").primaryKey(),
        token: text("token").notNull().unique(),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        ipAddress: text("ip_address"),
        userAgent: text("user_agent"),
        ...times(),
    }, (t) => [index("session_user_idx").on(t.userId)]);
    const account = schema.table("account", {
        id: text("id").primaryKey(),
        accountId: text("account_id").notNull(),
        providerId: text("provider_id").notNull(),
        userId: text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        password: text("password"),
        accessToken: text("access_token"),
        refreshToken: text("refresh_token"),
        idToken: text("id_token"),
        accessTokenExpiresAt: timestamp("access_token_expires_at", {
            withTimezone: true,
        }),
        refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
            withTimezone: true,
        }),
        scope: text("scope"),
        ...times(),
    }, (t) => [
        uniqueIndex("account_provider_identity_idx").on(t.providerId, t.accountId),
        index("account_user_idx").on(t.userId),
    ]);
    const verification = schema.table("verification", {
        id: text("id").primaryKey(),
        identifier: text("identifier").notNull(),
        value: text("value").notNull(),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        ...times(),
    }, (t) => [uniqueIndex("verification_identifier_idx").on(t.identifier)]);
    return { user, session, account, verification };
}
/** Review then execute on an empty dedicated namespace; never called by createAuthKit. */
export function authSchemaSql(namespace = "auth_kit") {
    validNamespace(namespace);
    const s = `"${namespace}"`;
    return `CREATE SCHEMA ${s};
CREATE TABLE ${s}."user" (id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,phone_number text NOT NULL UNIQUE,phone_number_verified boolean NOT NULL DEFAULT false,enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ${s}.session (id text PRIMARY KEY,token text NOT NULL UNIQUE,user_id text NOT NULL REFERENCES ${s}."user"(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,ip_address text,user_agent text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX session_user_idx ON ${s}.session(user_id);
CREATE TABLE ${s}.account (id text PRIMARY KEY,account_id text NOT NULL,provider_id text NOT NULL,user_id text NOT NULL REFERENCES ${s}."user"(id) ON DELETE CASCADE,password text,access_token text,refresh_token text,id_token text,access_token_expires_at timestamptz,refresh_token_expires_at timestamptz,scope text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX account_provider_identity_idx ON ${s}.account(provider_id,account_id);
CREATE INDEX account_user_idx ON ${s}.account(user_id);
CREATE TABLE ${s}.verification (id text PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX verification_identifier_idx ON ${s}.verification(identifier);`;
}
