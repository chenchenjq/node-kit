import type { AliyunApi } from "./api.js";
export type AliyunClientCredentials = Readonly<{
    region: string;
    endpoint?: string;
    accessKeyId: string;
    accessKeySecret: string;
}>;
export interface AliyunClientFactory {
    create(credentials: AliyunClientCredentials): AliyunApi;
}
/** Creates a fresh SDK client for each provider operation; it intentionally has no credential state. */
export declare class AliyunSdkClientFactory implements AliyunClientFactory {
    create(credentials: AliyunClientCredentials): AliyunApi;
}
