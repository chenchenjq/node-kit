/** Browser-safe contracts. Server inputs involving Buffer/Readable are declared in oss-kit/server. */
export type DateDirectory = "fixed" | "year-month" | "year-month-day";
export type FileNaming = "uuid" | "timestamp-random" | "original-random";
export interface Credentials {
    accessKeyId: string;
    accessKeySecret: string;
    stsToken?: string;
}
/** Empty credential fields preserve saved values. clearStsToken explicitly switches away from STS. */
export interface CredentialUpdate extends Credentials {
    clearStsToken?: boolean;
}
export interface CredentialProtector {
    seal(credentials: Credentials): Promise<string>;
    open(envelope: string): Promise<Credentials>;
}
export interface StorageInput {
    name: string;
    region: string;
    bucket: string;
    endpoint?: string;
    access?: "private" | "public";
    publicDomain?: string | null;
    enabled?: boolean;
}
export interface StorageSummary {
    id: string;
    name: string;
    region: string;
    bucket: string;
    endpoint: string;
    access: "private" | "public";
    publicDomain: string | null;
    enabled: boolean;
    isDefault: boolean;
    used: boolean;
    revision: number;
}
/** Host persistence only. Never serialize this to clients or logs. */
export interface StorageRecord extends StorageSummary {
    credentialEnvelope: string;
}
export interface StrategyInput {
    code: string;
    name: string;
    description: string;
    storageConfigId?: string | null;
    prefix: string;
    dateDirectory?: DateDirectory;
    naming?: FileNaming;
    allowedExtensions: string[];
    allowedMimeTypes: string[];
    maxSizeBytes?: number;
    enabled?: boolean;
}
export interface Strategy {
    code: string;
    name: string;
    description: string;
    storageConfigId: string | null;
    prefix: string;
    dateDirectory: DateDirectory;
    naming: FileNaming;
    allowedExtensions: string[];
    allowedMimeTypes: string[];
    maxSizeBytes: number;
    enabled: boolean;
    used: boolean;
}
export interface FileReference {
    storageConfigId: string;
    strategyCode: string;
    objectKey: string;
    originalName: string;
    size: number;
    mimeType: string;
}
export interface AccessLink {
    url: string;
    expiresAt: string | null;
    access: "private" | "public";
}
export type ErrorCode = "INVALID_CONFIG" | "INVALID_STRATEGY" | "INVALID_PATH" | "INVALID_FILE" | "FILE_TOO_LARGE" | "TYPE_MISMATCH" | "FORBIDDEN" | "NOT_FOUND" | "NO_DEFAULT_STORAGE" | "STORAGE_DISABLED" | "STRATEGY_DISABLED" | "IMMUTABLE_LOCATION" | "IMMUTABLE_ACCESS" | "CREDENTIAL_SECURITY_REQUIRED" | "CREDENTIAL_FAILURE" | "OSS_ERROR" | "TIMEOUT" | "STORE_ERROR";
export interface ErrorInfo {
    code: ErrorCode;
    message: string;
    ossCode?: string;
    requestId?: string;
}
export interface TestStep {
    status: "passed" | "failed" | "skipped";
    error?: ErrorInfo;
}
export interface ConnectionTestResult {
    objectKey: string;
    upload: TestStep;
    read: TestStep;
    delete: TestStep;
    cleanupRequired: boolean;
}
export type AuthorizationRequest = {
    action: "admin";
} | {
    action: "strategy";
    code: string;
} | {
    action: "file";
    operation: "link" | "read" | "delete";
    reference: FileReference;
};
/** All views are already scoped. transaction MUST serialize all writes across processes in this scope. */
export interface StoreView {
    getStorage(id: string): Promise<StorageRecord | null>;
    listStorage(): Promise<StorageRecord[]>;
    saveStorage(record: StorageRecord): Promise<void>;
    getStrategy(code: string): Promise<Strategy | null>;
    listStrategies(): Promise<Strategy[]>;
    saveStrategy(strategy: Strategy): Promise<void>;
}
export interface OssStore {
    read<T>(work: (view: StoreView) => Promise<T>): Promise<T>;
    transaction<T>(work: (view: StoreView) => Promise<T>): Promise<T>;
}
export interface PreviewInput {
    applicationPrefix: string;
    strategy: Pick<Strategy, "prefix" | "dateDirectory" | "naming" | "allowedExtensions">;
    originalName: string;
    timeZone?: string;
    now?: Date;
    randomId?: string;
}
