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
import { mapSignature, mapTemplate } from "./resource-map.js";

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
    const page = await this.withApi(input, (api) => api.querySmsSignList({
      pageIndex: this.pageIndex(input.cursor),
      pageSize: input.pageSize,
    }));
    this.assertSuccessfulResponse(page);
    const currentPage = page.currentPage ?? this.pageIndex(input.cursor);
    const totalCount = page.totalCount ?? 0;

    return {
      items: (page.smsSignList ?? []).map(mapSignature),
      nextCursor: currentPage * input.pageSize < totalCount ? String(currentPage + 1) : undefined,
    };
  }

  async listTemplates(input: ProviderListInput): Promise<ProviderPage<ProviderTemplate>> {
    const page = await this.withApi(input, (api) => api.querySmsTemplateList({
      pageIndex: this.pageIndex(input.cursor),
      pageSize: input.pageSize,
    }));
    this.assertSuccessfulResponse(page);
    const currentPage = page.currentPage ?? this.pageIndex(input.cursor);
    const totalCount = page.totalCount ?? 0;

    return {
      items: (page.smsTemplateList ?? []).map(mapTemplate),
      nextCursor: currentPage * input.pageSize < totalCount ? String(currentPage + 1) : undefined,
    };
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    try {
      const output = await this.withApi(input, (api) => api.sendSms({
        phoneNumbers: input.phoneNumber,
        signName: input.signatureName,
        templateCode: input.templateCode,
        templateParam: JSON.stringify(input.templateParams),
        outId: input.outId,
      }));
      if (output.code === "OK" && output.bizId !== undefined && output.requestId !== undefined) {
        return { kind: "accepted", bizId: output.bizId, requestId: output.requestId };
      }
      if (output.code !== undefined && output.code !== "OK") {
        return this.toSendResult(classifyAliyunError(output));
      }
      return { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
    } catch (error) {
      return this.toSendResult(classifyAliyunError(error));
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
      return this.toDeliveryResult(output);
    } catch {
      return { kind: "unknown", code: "DELIVERY_UNKNOWN" };
    }
  }

  parseReceipt(_input: unknown): ProviderReceiptBatch {
    return { items: [], acknowledgement: { code: 0, msg: "OK" } };
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
    if (response.code !== undefined && response.code !== "OK") {
      throw classifyAliyunError(response);
    }
  }

  private pageIndex(cursor: string | undefined): number {
    if (cursor === undefined) {
      return 1;
    }
    const value = Number(cursor);
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
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

  private toDeliveryResult(output: AliyunQueryOutput): ProviderDeliveryResult {
    const detail = output.smsSendDetailDTOs?.smsSendDetailDTO?.[0];
    if (detail === undefined || detail.sendStatus === undefined) {
      return { kind: "waiting" };
    }
    if (detail.sendStatus === 3) {
      return { kind: "delivered", ...(detail.outId === undefined ? {} : { bizId: detail.outId }) };
    }
    if (detail.sendStatus === 2) {
      return {
        kind: "failed",
        code: detail.errCode ?? "PROVIDER_FAILED",
        ...(detail.outId === undefined ? {} : { bizId: detail.outId }),
      };
    }
    return { kind: "waiting" };
  }
}

export function createAliyunProvider(options: AliyunSmsProviderOptions): AliyunSmsProvider {
  return new AliyunSmsProvider(options);
}
