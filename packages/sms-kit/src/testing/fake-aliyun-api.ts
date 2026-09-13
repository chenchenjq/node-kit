import type {
  AliyunApi,
  AliyunQueryOutput,
  AliyunSendInput,
  AliyunSendOutput,
  AliyunSignPage,
  AliyunTemplatePage,
} from "../aliyun/api.js";

export function signFixture(): NonNullable<AliyunSignPage["smsSignList"]>[number] {
  return {
    signName: "Example",
    auditStatus: "AUDIT_STATE_PASS",
    businessType: "通用类型",
  };
}

export function templateFixture(): NonNullable<AliyunTemplatePage["smsTemplateList"]>[number] {
  return {
    templateCode: "SMS_123456",
    templateName: "Example",
    auditStatus: "AUDIT_STATE_PASS",
    templateType: 2,
    outerTemplateType: 0,
    templateContent: "Your code is ${code}",
  };
}

export class FakeAliyunApi implements AliyunApi {
  readonly calls = {
    querySmsSignList: 0,
    querySmsTemplateList: 0,
    sendSms: 0,
    querySendDetails: 0,
  };
  lastQueryInput: Parameters<AliyunApi["querySendDetails"]>[0] | undefined;

  private signatures: AliyunSignPage = { code: "OK", smsSignList: [] };
  private templates: AliyunTemplatePage = { code: "OK", smsTemplateList: [] };
  private sendOutput: AliyunSendOutput = { code: "OK", bizId: "biz-1", requestId: "request-1" };
  private queryOutput: AliyunQueryOutput = { code: "OK" };
  private signatureListFailure: unknown;

  withSignatures(signatures: NonNullable<AliyunSignPage["smsSignList"]>): this {
    this.signatures = { code: "OK", totalCount: signatures.length, smsSignList: signatures };
    return this;
  }

  withTemplates(templates: NonNullable<AliyunTemplatePage["smsTemplateList"]>): this {
    this.templates = { code: "OK", totalCount: templates.length, smsTemplateList: templates };
    return this;
  }

  failSignatureList(error: unknown): this {
    this.signatureListFailure = error;
    return this;
  }

  async querySmsSignList(_input: { pageIndex: number; pageSize: number }): Promise<AliyunSignPage> {
    this.calls.querySmsSignList += 1;
    if (this.signatureListFailure !== undefined) {
      throw this.signatureListFailure;
    }
    return this.signatures;
  }

  async querySmsTemplateList(_input: { pageIndex: number; pageSize: number }): Promise<AliyunTemplatePage> {
    this.calls.querySmsTemplateList += 1;
    return this.templates;
  }

  async sendSms(_input: AliyunSendInput): Promise<AliyunSendOutput> {
    this.calls.sendSms += 1;
    return this.sendOutput;
  }

  async querySendDetails(_input: {
    phoneNumber: string;
    sendDate: string;
    currentPage: number;
    pageSize: number;
    bizId?: string;
  }): Promise<AliyunQueryOutput> {
    this.calls.querySendDetails += 1;
    this.lastQueryInput = _input;
    return this.queryOutput;
  }
}
