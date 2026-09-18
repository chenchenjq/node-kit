import {AreaKitError, sanitizeError} from "../errors.js";
import {evaluateSelection, unresolvedSelection, validateSelectionInput} from "../policy.js";
import type {VersionSelector} from "../types.js";
import type {AreaKit, AreaKitOptions, AuthorizationRequest} from "./contracts.js";
import {summarizeDataset, summarizeNodes} from "./summary.js";

export function createSelectionValidator<C>(options: AreaKitOptions<C>): AreaKit<C>["validateSelection"] {
  async function authorize(ctx: C, request: AuthorizationRequest): Promise<void> {
    if (await options.authorize(ctx, request) !== true) throw new AreaKitError("FORBIDDEN");
  }
  return async (ctx, input, validationOptions = {}) => {
    try {
      await authorize(ctx, {action: "read"});
      validateSelectionInput(input, validationOptions);
      return await options.store.read(async view => {
        const selector: VersionSelector = {};
        if (input.datasetId !== undefined) selector.datasetId = input.datasetId;
        if (input.versionCode !== undefined) selector.versionCode = input.versionCode;
        const dataset = await view.resolveDataset(selector);
        if (!dataset || dataset.status !== "ready") {
          return unresolvedSelection(input, input.datasetId === undefined && input.versionCode === undefined
            ? "NOT_INITIALIZED" : "VERSION_UNAVAILABLE");
        }
        const endpoint = input.pathCodes.at(-1)!;
        await authorize(ctx, {action: "read", datasetId: dataset.datasetId, versionCode: dataset.versionCode, code: endpoint});
        const summary = summarizeDataset(dataset);
        if (validationOptions.versionPolicy === "active-only" && !dataset.isActive) {
          return unresolvedSelection(input, "DATASET_NOT_ACCEPTED", summary);
        }
        const found = await view.findNodes(dataset.datasetId, input.pathCodes);
        const codes = new Set(found.map(node => node.code));
        if (input.pathCodes.some(code => !codes.has(code))) return unresolvedSelection(input, "UNKNOWN_CODE", summary);
        const path = (await view.getPaths(dataset.datasetId, [endpoint])).get(endpoint);
        // A found node without its canonical path is a store failure, not an unknown user code.
        if (!path?.length || path.at(-1)?.code !== endpoint) throw new AreaKitError("QUERY_FAILED");
        return evaluateSelection(summary, await summarizeNodes(view, dataset.datasetId, path), input, validationOptions);
      });
    } catch (error) { throw sanitizeError(error); }
  };
}
