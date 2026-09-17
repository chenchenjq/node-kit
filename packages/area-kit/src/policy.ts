import {AreaKitError} from "./errors.js";
import type {DatasetSummary, RegionSummary, RejectionReason, ResolvedSelection, SelectionReason,
  SelectionResult, UnresolvedSelection, ValidationInput, ValidationOptions} from "./types.js";

function invalid(): never { throw new AreaKitError("INVALID_ARGUMENT"); }
function object(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
}
function code(value: unknown): void {
  if (typeof value !== "string" || !value.length) invalid();
}

/** Shared runtime boundary for the pure evaluator and the server entry point. */
export function validateSelectionInput(input: ValidationInput, options: ValidationOptions): void {
  object(input);
  if (!Array.isArray(input.pathCodes) || input.pathCodes.length < 1 || input.pathCodes.length > 5) invalid();
  for (const value of input.pathCodes) code(value);
  if (input.datasetId !== undefined) code(input.datasetId);
  if (input.versionCode !== undefined) code(input.versionCode);
  if (input.targetLevel !== undefined && (!Number.isInteger(input.targetLevel) || input.targetLevel < 1 || input.targetLevel > 5)) invalid();
  object(options);
  if (options.versionPolicy !== undefined && options.versionPolicy !== "active-only" && options.versionPolicy !== "specified-ready") invalid();
  if (options.policy !== undefined) {
    object(options.policy);
    const policy = options.policy;
    if (policy.allowEarlyTermination !== undefined && typeof policy.allowEarlyTermination !== "boolean") invalid();
    if (policy.groupEndpointExceptions !== undefined) {
      if (!Array.isArray(policy.groupEndpointExceptions)) invalid();
      for (const rule of policy.groupEndpointExceptions) {
        object(rule); code(rule.source); code(rule.versionCode);
        if (!Array.isArray(rule.codes)) invalid();
        for (const value of rule.codes) code(value);
      }
    }
  }
}

export function unresolvedSelection(input: ValidationInput, reason: RejectionReason, dataset?: DatasetSummary): UnresolvedSelection {
  return {datasetId: dataset?.datasetId ?? input.datasetId ?? null,
    versionCode: dataset?.versionCode ?? input.versionCode ?? null,
    code: null, level: null, actualLevel: null, pathCodes: null, pathNames: null,
    candidatePathCodes: [...input.pathCodes], targetLevel: input.targetLevel ?? 3,
    reachedTargetLevel: false, accepted: false, reason};
}

/** The dataset and canonical path must come from a trusted source; input carries codes only. */
export function evaluateSelection(dataset: DatasetSummary, path: readonly RegionSummary[], input: ValidationInput,
  options: ValidationOptions = {}): SelectionResult {
  validateSelectionInput(input, options);
  const last = path.at(-1), target = input.targetLevel ?? 3;
  function unresolved(reason: RejectionReason): UnresolvedSelection {
    return unresolvedSelection(input, reason, dataset);
  }
  function resolved(accepted: boolean, reason: SelectionReason): ResolvedSelection {
    return {datasetId: dataset.datasetId, versionCode: dataset.versionCode,
      code: last!.code, level: last!.level, actualLevel: last!.level,
      pathCodes: path.map(node => node.code), pathNames: path.map(node => node.label),
      candidatePathCodes: [...input.pathCodes], targetLevel: target,
      reachedTargetLevel: last!.level === target, accepted, reason};
  }
  if (dataset.status !== "ready" || input.datasetId !== undefined && input.datasetId !== dataset.datasetId
    || input.versionCode !== undefined && input.versionCode !== dataset.versionCode) return unresolved("VERSION_UNAVAILABLE");
  if (options.versionPolicy === "active-only" && !dataset.isActive) return unresolved("DATASET_NOT_ACCEPTED");
  if (!last) return unresolved("UNKNOWN_CODE");
  // Source levels and parent links determine ancestry; names and code prefixes never do.
  if (path.length !== input.pathCodes.length || new Set(path.map(node => node.code)).size !== path.length
    || path.some((node, index) => node.code !== input.pathCodes[index] || node.level !== index + 1
      || node.parentCode !== (index === 0 ? null : path[index - 1]!.code))) return unresolved("PARENT_MISMATCH");
  if (path.some(node => !node.effectiveEnabled)) return resolved(false, "NOT_SELECTABLE");
  const exception = options.policy?.groupEndpointExceptions?.some(rule => rule.source === dataset.source
    && rule.versionCode === dataset.versionCode && rule.codes.includes(last.code));
  if (last.nodeKind === "group") {
    return target === 2 && last.level === 2 && exception
      ? resolved(true, "GROUP_ENDPOINT_EXCEPTION") : resolved(false, "NAVIGATION_ONLY");
  }
  if (last.level > target) return resolved(false, "TARGET_LEVEL_EXCEEDED");
  if (last.level === target) return resolved(true, "TARGET_REACHED");
  return options.policy?.allowEarlyTermination && last.childrenState === "NONE_IN_SNAPSHOT"
    ? resolved(true, "EARLY_TERMINATION_ACCEPTED") : resolved(false, "TARGET_LEVEL_NOT_REACHED");
}
