import type { Readable } from "node:stream";
import type { Credentials, StorageSummary } from "../types.js";
export interface OssTransport {
    put(key: string, body: Buffer, mimeType: string, privateAccess: boolean): Promise<void>;
    get(key: string): Promise<Buffer>;
    read(key: string): Promise<Readable>;
    delete(key: string): Promise<void>;
    sign(key: string, expiresInSeconds: number): Promise<string>;
}
/** OSS network seam for integration tests/instrumentation, not a cloud-provider abstraction. */
export type OssTransportFactory = (storage: StorageSummary, credentials: Credentials, options: {
    timeoutMs: number;
    browser: boolean;
}) => OssTransport;
export declare const createAliyunTransport: OssTransportFactory;
