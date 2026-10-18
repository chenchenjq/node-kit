import { describe, expect, it } from "vitest";
import { authSchemaSql, createAuthSchema } from "../src/server/schema.js";

describe("schema baseline", () => {
  it("rejects public or invalid namespace", () => {
    expect(() => createAuthSchema("public")).toThrow(
      "Use a dedicated lowercase PostgreSQL schema"
    );
    expect(() => createAuthSchema("INVALID-UPPER")).toThrow(
      "Use a dedicated lowercase PostgreSQL schema"
    );
    expect(() => authSchemaSql("123bad")).toThrow(
      "Use a dedicated lowercase PostgreSQL schema"
    );
  });

  it("creates schema tables and generates DDL SQL", () => {
    const schema = createAuthSchema("custom_auth");
    expect(schema.user).toBeDefined();
    expect(schema.session).toBeDefined();
    expect(schema.account).toBeDefined();
    expect(schema.verification).toBeDefined();

    const sql = authSchemaSql("custom_auth");
    expect(sql).toContain('CREATE SCHEMA "custom_auth";');
    expect(sql).toContain('CREATE TABLE "custom_auth"."user"');
    expect(sql).toContain('CREATE TABLE "custom_auth".session');
    expect(sql).toContain('CREATE TABLE "custom_auth".account');
    expect(sql).toContain('CREATE TABLE "custom_auth".verification');
  });
});

