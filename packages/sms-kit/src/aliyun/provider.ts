import type { SmsProvider } from "../ports/provider.js";
import { SmsKitError } from "../core/errors.js";
import type {
  ProviderAuthInput,
  ProviderConnectionResult,
  ProviderDeliveryQuery,
  ProviderDeliveryResult,
  ProviderListInput,
  ProviderPage,
  ProviderReceiptBatch,
  ProviderSendInput,
  ProviderSendResult,
  ProviderSignature,
  ProviderTemplate,
} from "../ports/provider.js";
import type { SecretResolver } from "../ports/security.js";
import type { AliyunApi, AliyunQueryOutput } from "./api.js";
import { AliyunSdkClientFactory, type AliyunClientFactory } from "./client.js";
import { classifyAliyunError } from "./error-map.js";
import { listAllAliyunSignatures, listAllAliyunTemplates } from "./resource-map.js";
import { parseAliyunReceiptBatch } from "./receipt.js";
import { withProviderTimeout } from "../ports/provider-timeout.js";

export type AliyunSmsProviderOptions = Readonly<{
  secretResolver: SecretResolver;
  /** An injected API is for tests or an explicitly managed external client. */
  api?: AliyunApi;
  clientFactory?: AliyunClientFactory;
}>;

export class AliyunSmsProvider implements SmsProvider {
  private readonly clientFactory: AliyunClientFactory;

  constructor(private readonly options: AliyunSmsProviderOptions) {
    this.clientFactory = options.clientFactory ?? new AliyunSdkClientFactory();
  }

  async testConnection(input: ProviderAuthInput): Promise<ProviderConnectionResult> {
    const signatures = await this.withApi(input, (api) => api.querySmsSignList({ pageIndex: 1, pageSize: 50 }));
    const templates = await this.withApi(input, (api) => api.querySmsTemplateList({ pageIndex: 1, pageSize: 50 }));
    this.assertSuccessfulResponse(signatures);
    this.assertSuccessfulResponse(templates);

    return {
      status: "ready",
      signatureCount: signatures.totalCount ?? signatures.smsSignList?.length ?? 0,
      templateCount: templates.totalCount ?? templates.smsTemplateList?.length ?? 0,
    };
  }

  async listSignatures(input: ProviderListInput): Promise<ProviderPage<ProviderSignature>> {
    return this.withApi(input, (api) => listAllAliyunSignatures(api, { pageSize: input.pageSize }));
  }

  async listTemplates(input: ProviderListInput): Promise<ProviderPage<ProviderTemplate>> {
    return this.withApi(input, (api) => listAllAliyunTemplates(api, { pageSize: input.pageSize }));
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    try {
      const output = await withProviderTimeout((signal) => this.withApi(input, (api) => {
        signal.throwIfAborted();
        return api.sendSms({
          phoneNumbers: input.phoneNumber,
          signName: input.signatureName,
          templateCode: input.templateCode,
          templateParam: JSON.stringify(input.templateParams),
          outId: input.outId,
          timeoutMs: input.timeoutMs,
        });
      }), input.timeoutMs);
      if (output.code === "OK" && output.bizId !== undefined && output.requestId !== undefined) {
        return { kind: "accepted", bizId: output.bizId, requestId: output.requestId };
      }
      if (output.code !== undefined && output.code !== "OK") {
        return this.toSendResult(classifyAliyunError(output));
      }
      return { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
    } catch (error) {
      return this.toSendResult(error instanceof SmsKitError ? error : classifyAliyunError(error));
    }
  }

  async queryDelivery(input: ProviderDeliveryQuery): Promise<ProviderDeliveryResult> {
    try {
      const output = await this.withApi(input, (api) => api.querySendDetails({
        phoneNumber: input.phoneNumber,
        sendDate: input.sendDate,
        currentPage: input.currentPage,
        pageSize: input.pageSize,
        ...(input.bizId === undefined ? {} : { bizId: input.bizId }),
      }));
      this.assertSuccessfulResponse(output);
      return this.toDeliveryResult(output, input.currentPage, input.pageSize);
    } catch {
      return { kind: "unknown", code: "DELIVERY_UNKNOWN" };
    }
  }

  parseReceipt(input: unknown): ProviderReceiptBatch {
    if (typeof input !== "string" && !(input instanceof Uint8Array)) throw new SmsKitError("CONFIG_INVALID", "invalid Aliyun delivery receipt");
    return { items: parseAliyunReceiptBatch(input).map(({ providerMessage: _message, ...receipt }) => receipt), acknowledgement: { code: 0, msg: "成功" } };
  }

  private async withApi<T>(input: ProviderAuthInput, operation: (api: AliyunApi) => Promise<T>): Promise<T> {
    try {
      const accessKeyId = await this.options.secretResolver.resolve(input.accessKeyId);
      const accessKeySecret = await this.options.secretResolver.resolve(input.accessKeySecret);
      const api = this.options.api ?? this.clientFactory.create({
        region: input.region,
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
        accessKeyId,
        accessKeySecret,
      });
      return await operation(api);
    } catch (error) {
      throw error instanceof SmsKitError ? error : classifyAliyunError(error);
    }
  }

  private assertSuccessfulResponse(response: { code?: string }): void {
    if (response.code !== "OK") {
      throw classifyAliyunError(response);
    }
  }

  private toSendResult(error: ReturnType<typeof classifyAliyunError>): ProviderSendResult {
    if (error.code === "ACCEPTANCE_UNKNOWN") {
      return { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
    }
    return {
      kind: "rejected",
      code: error.causeCode ?? "PROVIDER_REJECTED",
      retryable: error.retryable,
    };
  }

  private toDeliveryResult(output: AliyunQueryOutput, currentPage: number, pageSize: number): ProviderDeliveryResult {
    const hasNextPage = Number(output.totalCount ?? 0) > currentPage * pageSize;
    const items = (output.smsSendDetailDTOs?.smsSendDetailDTO ?? []).map((detail) => ({
      ...(detail.outId === undefined ? {} : { outId: detail.outId }),
      status: detail.sendStatus === 3 ? "delivered" as const : detail.sendStatus === 2 ? "failed" as const : "waiting" as const,
      ...(detail.errCode === undefined ? {} : { providerCode: detail.errCode }),
    }));
    return { kind: "page", items, hasNextPage };
  }
}

export function createAliyunProvider(options: AliyunSmsProviderOptions): AliyunSmsProvider {
  return new AliyunSmsProvider(options);
}
