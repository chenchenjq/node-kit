import type { SmsProvider } from "../ports/provider.js";
import type { ProviderAuthInput, ProviderConnectionResult, ProviderDeliveryQuery, ProviderDeliveryResult, ProviderListInput, ProviderPage, ProviderReceiptBatch, ProviderSendInput, ProviderSendResult, ProviderSignature, ProviderTemplate } from "../ports/provider.js";
import type { SecretResolver } from "../ports/security.js";
import type { AliyunApi } from "./api.js";
import { type AliyunClientFactory } from "./client.js";
export type AliyunSmsProviderOptions = Readonly<{
    secretResolver: SecretResolver;
    /** An injected API is for tests or an explicitly managed external client. */
    api?: AliyunApi;
    clientFactory?: AliyunClientFactory;
}>;
export declare class AliyunSmsProvider implements SmsProvider {
    private readonly options;
    private readonly clientFactory;
    constructor(options: AliyunSmsProviderOptions);
    testConnection(input: ProviderAuthInput): Promise<ProviderConnectionResult>;
    listSignatures(input: ProviderListInput): Promise<ProviderPage<ProviderSignature>>;
    listTemplates(input: ProviderListInput): Promise<ProviderPage<ProviderTemplate>>;
    send(input: ProviderSendInput): Promise<ProviderSendResult>;
    queryDelivery(input: ProviderDeliveryQuery): Promise<ProviderDeliveryResult>;
    parseReceipt(input: unknown): ProviderReceiptBatch;
    private withApi;
    private assertSuccessfulResponse;
    private toSendResult;
    private toDeliveryResult;
}
export declare function createAliyunProvider(options: AliyunSmsProviderOptions): AliyunSmsProvider;
