import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";
import type { BetterAuthOptions } from "better-auth";
import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { PoolClient } from "pg";
import type { AuthSchema } from "./schema.js";

/** Password writes and server-side session revocation commit together, including failures. */
export function credentialAdapter(
  client: PoolClient,
  schema: AuthSchema
): (options: BetterAuthOptions) => DBAdapter {
  const factory = drizzleAdapter(drizzle(client), {
    provider: "pg",
    schema,
    transaction: true,
  });
  return (options: any) => {
    const base = factory(options);
    return {
      ...base,
      create: (async (input: any) => {
        if (
          input.model !== "account" ||
          input.data.providerId !== "credential" ||
          typeof input.data.password !== "string" ||
          typeof input.data.userId !== "string"
        )
          return base.create(input);
        const userId = input.data.userId;
        return base.transaction(async (tx: any) => {
          const result = await tx.create(input);
          await tx.deleteMany({
            model: "session",
            where: [{ field: "userId", value: userId }],
          });
          return result;
        });
      }) as any,
      async update(input: any) {
        if (
          input.model !== "account" ||
          typeof input.update.password !== "string"
        )
          return base.update(input);
        return base.transaction(async (tx: any) => {
          const existing = await tx.findOne({
            model: "account",
            where: input.where,
          });
          const result = await tx.update(input);
          if (existing)
            await tx.deleteMany({
              model: "session",
              where: [{ field: "userId", value: existing.userId }],
            });
          return result;
        });
      },
      async updateMany(input: any) {
        if (
          input.model !== "account" ||
          typeof input.update.password !== "string"
        )
          return base.updateMany(input);
        return base.transaction(async (tx: any) => {
          const accounts = await tx.findMany({
            model: "account",
            where: input.where,
          });
          const result = await tx.updateMany(input);
          for (const account of accounts)
            await tx.deleteMany({
              model: "session",
              where: [{ field: "userId", value: account.userId }],
            });
          return result;
        });
      },
    };
  };
}
