import "server-only";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DictionaryPort } from "ai-kit";
import { createAiKit, AiKitError } from "ai-kit/server";
import type { AiKit, AiKitOptions, SecretProtector } from "ai-kit/server";
import type { AiTables } from "./schema";
import { createDrizzleAiStore } from "./store";
export interface HostContext {
  userId: string;
  scope: string;
  admin: boolean;
  allowedCodes: readonly string[];
  allowSystem: boolean;
  allowOverrides: boolean;
}
export interface AiHost {
  kit: AiKit<HostContext>;
  origin: string;
  authenticate(request: Request): Promise<HostContext>;
  /** Existing host CSRF/session/request protection. Do not replace with a front-end-only check. */
  protectRequest(request: Request, context: HostContext): Promise<void>;
}
export interface HostDependencies {
  db: NodePgDatabase;
  tables: AiTables;
  scope: string;
  dictionary: DictionaryPort;
  secrets: SecretProtector;
  origin: string;
  authenticate: AiHost["authenticate"];
  protectRequest: AiHost["protectRequest"];
  rateLimit: AiKitOptions<HostContext>["rateLimit"];
  allowURL: AiKitOptions<HostContext>["allowURL"];
  limits?: AiKitOptions<HostContext>["limits"];
  resolveModelCapabilities?: AiKitOptions<HostContext>["resolveModelCapabilities"];
  log?: AiKitOptions<HostContext>["log"];
}
/** Wire in host bootstrap/instrumentation. This does not invent sessions, tenant IDs, credentials or DB connections. */
export function createAiHost(deps: HostDependencies): AiHost {
  if (new URL(deps.origin).origin !== deps.origin)
    throw new AiKitError("INVALID_CONFIG");
  const kit = createAiKit<HostContext>({
    scope: deps.scope,
    store: createDrizzleAiStore(deps.db, deps.tables, deps.scope),
    dictionary: deps.dictionary,
    secrets: deps.secrets,
    rateLimit: deps.rateLimit,
    allowURL: deps.allowURL,
    ...(deps.limits ? { limits: deps.limits } : {}),
    ...(deps.resolveModelCapabilities
      ? { resolveModelCapabilities: deps.resolveModelCapabilities }
      : {}),
    ...(deps.log ? { log: deps.log } : {}),
    async authorize(ctx, r) {
      if (!ctx.userId || ctx.scope !== deps.scope) return false;
      if (
        r.action === "admin" ||
        r.action === "test" ||
        r.action === "dictionary"
      )
        return ctx.admin;
      if (!("code" in r)) return false;
      const allowed = ctx.admin || ctx.allowedCodes.includes(r.code);
      if (r.action === "override")
        return allowed && (ctx.admin || ctx.allowOverrides);
      if (r.action === "system")
        return allowed && (ctx.admin || ctx.allowSystem);
      return allowed;
    },
  });
  return {
    kit,
    origin: deps.origin,
    authenticate: deps.authenticate,
    protectRequest: deps.protectRequest,
  };
}
let installed: AiHost | undefined;
export function installAiHost(host: AiHost): void {
  installed = host;
}
export function getAiHost(): AiHost {
  if (!installed) throw new AiKitError("INVALID_CONFIG");
  return installed;
}
