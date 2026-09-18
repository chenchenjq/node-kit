import type { Pool, PoolClient } from "pg";
import { bindAreaStore, lockAreaLibrary } from "area-kit/postgres";
import { AreaKitError, createAreaKit } from "area-kit/server";
import type { ResolvedSelection, SelectionReason, ValidationInput } from "area-kit";
import { parseValidationInput, type AreaHost } from "./http.js";

class SelectionRejectionError extends AreaKitError {
  constructor(code: AreaKitError["code"], readonly reason: SelectionReason) { super(code); }
  override toJSON() { return {...super.toJSON(), reason: this.reason}; }
}

/** Keep the exact decision reason alongside the stable transport error code. */
export function selectionRejectionError(reason: SelectionReason): AreaKitError {
  switch (reason) {
    case "NOT_INITIALIZED": case "UNKNOWN_CODE": case "VERSION_UNAVAILABLE":
    case "PARENT_MISMATCH": case "NOT_SELECTABLE":
      return new SelectionRejectionError(reason, reason);
    case "DATASET_NOT_ACCEPTED": return new SelectionRejectionError("VERSION_UNAVAILABLE", reason);
    case "NAVIGATION_ONLY": case "TARGET_LEVEL_EXCEEDED": case "TARGET_LEVEL_NOT_REACHED":
      return new SelectionRejectionError("TARGET_LEVEL_NOT_REACHED", reason);
    default: return new SelectionRejectionError("INVALID_CONFIG", reason);
  }
}

export async function submitAreaSelection<C>(deps: {
  pool: Pool; schemaName: string; host: AreaHost<C>;
  persist(client: PoolClient, selection: ResolvedSelection): Promise<void>;
}, request: Request, input: ValidationInput): Promise<ResolvedSelection> {
  const {pool, schemaName, host, persist} = deps;
  if (request.method !== "POST") throw new AreaKitError("INVALID_ARGUMENT");
  if (request.headers.get("origin") !== host.origin) throw new AreaKitError("FORBIDDEN");
  const ctx = await host.authenticate(request);
  await host.protectRequest(request, ctx);
  const parsed = parseValidationInput(input);
  if (!parsed.datasetId && !parsed.versionCode) throw new AreaKitError("INVALID_ARGUMENT");
  const business = host.submissionPolicy(ctx);
  if (![1, 2, 3, 4, 5].includes(business.targetLevel) || !["active-only", "specified-ready"].includes(business.versionPolicy)) {
    throw new AreaKitError("INVALID_CONFIG");
  }
  const authorize = host.authorize.bind(host);
  const client = await pool.connect();
  let began = false;
  let discard: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    began = true;
    await lockAreaLibrary(client, schemaName, "shared");
    const kit = createAreaKit({store: bindAreaStore(client, {schemaName}), authorize});
    const result = await kit.validateSelection(ctx, {...parsed, targetLevel: business.targetLevel},
      {policy: business.policy, versionPolicy: business.versionPolicy});
    if (!result.accepted || result.code === null) throw selectionRejectionError(result.reason);
    await persist(client, result);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (began) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { discard = rollbackError instanceof Error ? rollbackError : new Error("Rollback failed"); }
    } else { discard = error instanceof Error ? error : new Error("Transaction failed"); }
    throw error;
  } finally { client.release(discard); }
}
