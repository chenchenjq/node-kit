export type ParseKitErrorCode =
  | "E_INPUT_TYPE"
  | "E_INPUT_EMPTY"
  | "E_INPUT_TOO_LONG"
  | "E_BATCH_NOT_ARRAY"
  | "E_BATCH_TOO_LARGE"
  | "E_MAX_CANDIDATES"
  | "E_REGION_INIT"
  | "E_REGION_VERSION_MISMATCH"
  | "E_SNAPSHOT_INVALID";

export class ParseKitError extends Error {
  readonly code: ParseKitErrorCode;

  constructor(code: ParseKitErrorCode, message: string) {
    super(message);
    this.name = "ParseKitError";
    this.code = code;
  }
}
