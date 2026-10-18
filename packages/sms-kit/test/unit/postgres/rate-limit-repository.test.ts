import { describe, expect, it } from "vitest";

import { SYSTEM_SCOPE, tenantScope, type TenantId } from "../../../src/core/types.js";
import { PgRateLimitRepository } from "../../../src/postgres/repositories/rate-limit-repository.js";

type CapturedQuery = Readonly<{ sql: string; values: readonly unknown[] }>;

function repository(queries: CapturedQuery[]): PgRateLimitRepository {
  return new PgRateLimitRepository({
    query: async (sql: string, values: readonly unknown[]) => {
      queries.push({ sql, values });
      return { rows: [{ count: "4" }], rowCount: 1 };
    },
  } as never);
}

describe("PgRateLimitRepository ownership scopes", () => {
  it("persists a SYSTEM bucket with an intentional null tenant id", async () => {
    const queries: CapturedQuery[] = [];

    await repository(queries).increment({
      ownership: SYSTEM_SCOPE,
      scope: "phone_purpose",
      scopeHash: "phone:login",
      windowStart: new Date("2026-09-21T00:00:00.000Z"),
      windowSeconds: 60,
      expiresAt: new Date("2026-09-21T00:01:00.000Z"),
    });

    expect(queries[0]?.sql).toContain("scope_type, tenant_id");
    expect(queries[0]?.values.slice(0, 4)).toEqual(["SYSTEM", null, "phone_purpose", "phone:login"]);
  });

  it("keeps the tenant identity in the ownership predicate", async () => {
    const queries: CapturedQuery[] = [];
    const tenantId = "tenant-a" as TenantId;

    await repository(queries).countSince({
      ownership: tenantScope(tenantId),
      scope: "ip_purpose",
      scopeHash: "ip:1",
      since: new Date("2026-09-21T00:00:00.000Z"),
    });

    expect(queries[0]?.sql).toContain("tenant_id is not distinct from $2");
    expect(queries[0]?.values.slice(0, 4)).toEqual(["TENANT", tenantId, "ip_purpose", "ip:1"]);
  });
});
