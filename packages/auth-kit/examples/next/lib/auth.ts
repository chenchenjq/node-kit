import "server-only";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { createAuthKit, type AuthKit } from "auth-kit/server";
import { createAuthSchema } from "auth-kit/schema";
import type { TenantId } from "sms-kit/core";

let kit: AuthKit | undefined;
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing demo configuration: ${name}`);
  return value;
}
/** Explicit local-only Mock. Replace this host module with the README's injected real sms-kit composition. */
export function getDemoAuth(): AuthKit {
  if (kit) return kit;
  if (process.env.AUTH_KIT_DEMO !== "1")
    throw new Error("Set AUTH_KIT_DEMO=1 only for the local Mock example");
  const baseURL = process.env.PUBLIC_AUTH_ORIGIN ?? "http://localhost:3000";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Mock example requires a loopback origin");
  kit = createAuthKit({
    appId: "demo",
    baseURL,
    secret: required("AUTH_SECRET"),
    pool: new Pool({
      connectionString: required("DATABASE_URL"),
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    }),
    redis: new Redis(required("REDIS_URL"), {
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    }),
    schema: createAuthSchema(),
    resolveClientIp: () => "loopback-demo",
    sms: {
      tenantId: "demo" as TenantId,
      sendService: {
        async sendOtpNow() {
          // No provider/network call and no OTP logging. Password login works after host user preparation.
          throw new Error(
            "Mock SMS is disabled in this local page; configure the host SendService for SMS delivery",
          );
        },
      },
    },
  });
  return kit;
}
