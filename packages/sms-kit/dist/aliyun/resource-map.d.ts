import type { ProviderPage, ProviderSignature, ProviderTemplate } from "../ports/provider.js";
import type { AliyunApi, AliyunSign, AliyunTemplate } from "./api.js";
export type AliyunResourceListOptions = Readonly<{
    pageSize: number;
}>;
export declare function toAliyunExternalKey(sign: AliyunSign): string;
export declare function mapSignature(sign: AliyunSign): ProviderSignature;
export declare function mapTemplate(template: AliyunTemplate): ProviderTemplate;
export declare function listAllAliyunSignatures(api: AliyunApi, options: AliyunResourceListOptions): Promise<ProviderPage<ProviderSignature>>;
export declare function listAllAliyunTemplates(api: AliyunApi, options: AliyunResourceListOptions): Promise<ProviderPage<ProviderTemplate>>;
