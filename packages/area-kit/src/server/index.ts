export { AreaKitError, sanitizeError } from "../errors.js";
export type * from "../types.js";
export { createAreaKit } from "./query.js";
export type { AreaKit, AreaReadKit, AreaKitOptions, AuthorizationRequest } from "./contracts.js";
export type { AreaStore, ReadView, WriteView, StoredRegion, DatasetRecord, PageKey, NodeQuery, ChildFacts } from "./ports.js";
export type { SourceFile } from "../source/manifest.js";
