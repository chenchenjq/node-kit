import { Readable } from "node:stream";
import type { AccessLink, AuthorizationRequest, ConnectionTestResult, CredentialProtector, Credentials, CredentialUpdate, FileReference, OssStore, StorageInput, StorageSummary, Strategy, StrategyInput } from "../types.js";
import type { OssTransportFactory } from "./aliyun.js";
export interface OssKitOptions<Context> {
    store: OssStore;
    applicationPrefix: string;
    authorize(context: Context, request: AuthorizationRequest): Promise<boolean>;
    credentials?: CredentialProtector;
    timeZone?: string;
    maxBufferedBytes?: number;
    timeoutMs?: number;
    /** Server-approved prefixes in this bucket under which admins may run connection tests. Empty disables testing. */
    testPrefixes?: readonly string[];
    ossTransportFactory?: OssTransportFactory;
}
export interface UploadInput {
    strategyCode: string;
    originalName: string;
    mimeType: string;
    body: Buffer | Readable;
}
export interface StorageTestInput {
    input: StorageInput;
    credentials?: CredentialUpdate;
    storageConfigId?: string;
    prefix: string;
}
export interface OssKit<Context> {
    createStorage(ctx: Context, input: StorageInput, credentials: Credentials): Promise<StorageSummary>;
    updateStorage(ctx: Context, id: string, input: StorageInput, credentials?: CredentialUpdate): Promise<StorageSummary>;
    listStorage(ctx: Context): Promise<StorageSummary[]>;
    setDefaultStorage(ctx: Context, id: string): Promise<void>;
    setStorageEnabled(ctx: Context, id: string, enabled: boolean): Promise<void>;
    testStorage(ctx: Context, input: StorageTestInput): Promise<ConnectionTestResult>;
    saveStrategy(ctx: Context, input: StrategyInput): Promise<Strategy>;
    listStrategies(ctx: Context): Promise<Strategy[]>;
    getStrategy(ctx: Context, code: string): Promise<Strategy>;
    previewStrategy(ctx: Context, input: StrategyInput, originalName: string): Promise<string>;
    upload(ctx: Context, input: UploadInput): Promise<FileReference>;
    getAccessLink(ctx: Context, reference: FileReference, options?: {
        expiresInSeconds?: number;
    }): Promise<AccessLink>;
    read(ctx: Context, reference: FileReference): Promise<Readable>;
    delete(ctx: Context, reference: FileReference): Promise<void>;
}
export declare function createOssKit<Context>(options: OssKitOptions<Context>): OssKit<Context>;
