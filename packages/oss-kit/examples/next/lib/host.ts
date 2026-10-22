import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { CredentialProtector } from "oss-kit";
import { createOssKit, OssKitError } from "oss-kit/server";
import type { OssKit, OssKitOptions } from "oss-kit/server";
import { createDrizzleOssStore } from "./store";
import type { HostFileRepository } from "./files";
import type { OssTables } from "./schema";
export interface HostContext { userId: string; scope: string; admin: boolean; allowedStrategyCodes: readonly string[] }
export interface OssHost {
  kit: OssKit<HostContext>; scope: string; files: HostFileRepository;
  authenticate(request: Request): Promise<HostContext>;
  protectRequest(request: Request, context: HostContext): Promise<void>;
}
export interface HostDependencies {
  db: NodePgDatabase; tables: OssTables; scope: string; applicationPrefix: string;
  credentials: CredentialProtector; files: HostFileRepository;
  authenticate: OssHost["authenticate"]; protectRequest: OssHost["protectRequest"];
  testPrefixes: readonly string[]; timeZone?: string;
  /** Tests may inject only the OSS network seam. Production should omit it. */
  ossTransportFactory?: OssKitOptions<HostContext>["ossTransportFactory"];
}
export function createOssHost(deps: HostDependencies): OssHost {
  const kit = createOssKit<HostContext>({
    store: createDrizzleOssStore(deps.db, deps.tables, deps.scope), applicationPrefix: deps.applicationPrefix,
    credentials: deps.credentials, testPrefixes: deps.testPrefixes,
    ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
    ...(deps.ossTransportFactory ? { ossTransportFactory: deps.ossTransportFactory } : {}),
    async authorize(ctx, request) {
      if (!ctx.userId || ctx.scope !== deps.scope) return false;
      if (request.action === "admin") return ctx.admin;
      if (request.action === "strategy") return ctx.admin || ctx.allowedStrategyCodes.includes(request.code);
      const record = await deps.files.find(ctx.scope, request.reference);
      return !!record && (record.ownerId === ctx.userId || ctx.admin) && JSON.stringify(record.reference) === JSON.stringify(request.reference);
    },
  });
  return { kit, scope: deps.scope, files: deps.files, authenticate: deps.authenticate, protectRequest: deps.protectRequest };
}
let installed: OssHost | undefined;
/** Call from the HOST's server bootstrap/instrumentation; no secret/database default is invented. */
export function installOssHost(host: OssHost): void { installed = host; }
export function getOssHost(): OssHost { if (!installed) throw new OssKitError("INVALID_CONFIG"); return installed; }
