import type { PreviewInput } from "../types.js";
export { OssKitError, errorInfo } from "./errors.js";
export declare const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export declare const DEFAULT_MAX_SIZE_BYTES: number;
export declare const HARD_MAX_SIZE_BYTES: number;
export declare function validatePrefix(value: string): string;
export declare function validateObjectKey(value: string, applicationPrefix: string): string;
export declare function validatedExtension(originalName: string, allowed: readonly string[]): string;
export declare function validateTimeZone(value: string): string;
/** Also used by uploads. randomId is supplied by the server for real uploads; never accept it from HTTP input. */
export declare function previewObjectKey(input: PreviewInput): string;
