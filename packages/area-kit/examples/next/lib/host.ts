import type { Pool, PoolClient } from "pg";
import { createDrizzleAreaStore } from "area-kit/postgres";
import { AreaKitError, createAreaKit, type AreaKitOptions } from "area-kit/server";
import type { ResolvedSelection, ValidationInput } from "area-kit";
import type { AreaHost } from "./http.js";
import { submitAreaSelection } from "./submission.js";
export type { AreaHost } from "./http.js";

export interface AreaSubmissionHost<C> extends AreaHost<C> {
  submit(request: Request, input: ValidationInput): Promise<ResolvedSelection>;
}

/** Call from server startup with the application's real authentication and persistence. */
export function createAreaHost<C>(deps: {
  pool: Pool; schemaName?: string; authorize: AreaKitOptions<C>["authorize"];
  authenticate: AreaHost<C>["authenticate"]; protectRequest: AreaHost<C>["protectRequest"];
  previewPolicy: AreaHost<C>["previewPolicy"]; submissionPolicy: AreaHost<C>["submissionPolicy"];
  persist(client: PoolClient, selection: ResolvedSelection): Promise<void>; origin: string;
}): AreaSubmissionHost<C> {
  try { if (new URL(deps.origin).origin !== deps.origin) throw new Error(); }
  catch { throw new AreaKitError("INVALID_CONFIG"); }
  const {pool, persist} = deps;
  const schemaName = deps.schemaName ?? "public";
  const host: AreaSubmissionHost<C> = {
    kit: createAreaKit({store: createDrizzleAreaStore(pool, {schemaName}), authorize: deps.authorize}),
    authorize: deps.authorize, authenticate: deps.authenticate, protectRequest: deps.protectRequest,
    previewPolicy: deps.previewPolicy, submissionPolicy: deps.submissionPolicy, origin: deps.origin,
    submit: (request, input) => submitAreaSelection({pool, schemaName, host, persist}, request, input),
  };
  return host;
}

// Symbol.for preserves installation across separately bundled route modules in one server process.
const hostKey = Symbol.for("area-kit.next.host");
const registry = globalThis as typeof globalThis & {[hostKey]?: AreaSubmissionHost<unknown>};

export function installAreaHost<C>(host: AreaSubmissionHost<C>): void {
  // Erase C using opaque handles: only this host's authentication can create a valid context.
  const contexts = new WeakMap<object, {value: C}>();
  function unwrap(ctx: unknown): C {
    if (typeof ctx !== "object" || ctx === null) throw new AreaKitError("FORBIDDEN");
    const entry = contexts.get(ctx);
    if (!entry) throw new AreaKitError("FORBIDDEN");
    return entry.value;
  }
  function operation<A extends unknown[], R>(fn: (ctx: C, ...args: A) => R): (ctx: unknown, ...args: A) => R {
    return (ctx, ...args) => fn(unwrap(ctx), ...args);
  }
  const kit = host.kit;
  registry[hostKey] = {
    origin: host.origin,
    async authenticate(request) {
      const value = await host.authenticate(request), handle = {};
      contexts.set(handle, {value}); return handle;
    },
    authorize: operation(host.authorize.bind(host)),
    protectRequest: (request, ctx) => host.protectRequest(request, unwrap(ctx)),
    previewPolicy: operation(host.previewPolicy.bind(host)),
    submissionPolicy: operation(host.submissionPolicy.bind(host)),
    submit: host.submit.bind(host),
    kit: {
      getDataset: operation(kit.getDataset.bind(kit)), listDatasets: operation(kit.listDatasets.bind(kit)),
      listProvinces: operation(kit.listProvinces.bind(kit)), listChildren: operation(kit.listChildren.bind(kit)),
      listRegions: operation(kit.listRegions.bind(kit)), getRegion: operation(kit.getRegion.bind(kit)),
      getRegions: operation(kit.getRegions.bind(kit)), getPath: operation(kit.getPath.bind(kit)),
      search: operation(kit.search.bind(kit)), getTree: operation(kit.getTree.bind(kit)),
      validateSelection: operation(kit.validateSelection.bind(kit)), updatePresentation: operation(kit.updatePresentation.bind(kit)),
      getDatasetReport: operation(kit.getDatasetReport.bind(kit)),
    },
  };
}

export function getAreaHost(): AreaSubmissionHost<unknown> {
  const host = registry[hostKey];
  if (!host) throw new AreaKitError("INVALID_CONFIG");
  return host;
}
