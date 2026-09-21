import { describe, expect, it } from "vitest";
import type {
  QuerySmsSignListResponseBodySmsSignList,
  QuerySmsTemplateListResponseBodySmsTemplateList,
} from "@alicloud/dysmsapi20170525";

import type { AliyunApi, AliyunQueryOutput, AliyunSendInput, AliyunSendOutput, AliyunSignPage, AliyunTemplatePage } from "../../../src/aliyun/api.js";
import { createAliyunProvider } from "../../../src/aliyun/provider.js";
import {
  listAllAliyunSignatures,
  listAllAliyunTemplates,
  mapTemplate,
  toAliyunExternalKey,
} from "../../../src/aliyun/resource-map.js";
import { FakeAliyunApi } from "../../../src/testing/fake-aliyun-api.js";

const authInput = {
  region: "cn-hangzhou",
  accessKeyId: "access-key-id-reference",
  accessKeySecret: "access-key-secret-reference",
};

function signFixture(
  signName: string,
  businessType: string,
  orderId?: string,
): Pick<QuerySmsSignListResponseBodySmsSignList, "signName" | "auditStatus" | "businessType" | "orderId"> {
  return {
    signName,
    auditStatus: "AUDIT_STATE_PASS",
    businessType,
    ...(orderId === undefined ? {} : { orderId }),
  };
}

function templateFixture(
  types: Pick<QuerySmsTemplateListResponseBodySmsTemplateList, "templateType" | "outerTemplateType">,
  templateCode = "SMS_123456",
): Pick<QuerySmsTemplateListResponseBodySmsTemplateList, "templateCode" | "templateName" | "auditStatus" | "templateContent" | "templateType" | "outerTemplateType"> {
  return {
    templateCode,
    templateName: "Example",
    auditStatus: "AUDIT_STATE_PASS",
    templateContent: "Your code is ${code}",
    ...(types.templateType === undefined ? {} : { templateType: types.templateType }),
    ...(types.outerTemplateType === undefined ? {} : { outerTemplateType: types.outerTemplateType }),
  };
}

class PagedAliyunApi implements AliyunApi {
  readonly calls = { signatures: 0, templates: 0 };
  readonly signatureRequests: { pageIndex: number; pageSize: number }[] = [];
  readonly templateRequests: { pageIndex: number; pageSize: number }[] = [];

  constructor(
    private readonly signaturePages: readonly AliyunSignPage[],
    private readonly templatePages: readonly AliyunTemplatePage[] = [],
    private readonly failedSignaturePage?: number,
    private readonly failedTemplatePage?: number,
  ) {}

  async querySmsSignList(input: { pageIndex: number; pageSize: number }): Promise<AliyunSignPage> {
    this.calls.signatures += 1;
    this.signatureRequests.push(input);
    if (input.pageIndex === this.failedSignaturePage) {
      throw Object.assign(new Error("temporary provider failure"), { code: "InternalError" });
    }
    return this.signaturePages[input.pageIndex - 1] ?? { code: "OK", smsSignList: [] };
  }

  async querySmsTemplateList(input: { pageIndex: number; pageSize: number }): Promise<AliyunTemplatePage> {
    this.calls.templates += 1;
    this.templateRequests.push(input);
    if (input.pageIndex === this.failedTemplatePage) {
      throw Object.assign(new Error("temporary provider failure"), { code: "InternalError" });
    }
    return this.templatePages[input.pageIndex - 1] ?? { code: "OK", smsTemplateList: [] };
  }

  async sendSms(_input: AliyunSendInput): Promise<AliyunSendOutput> {
    return {};
  }

  async querySendDetails(_input: { phoneNumber: string; sendDate: string; currentPage: number; pageSize: number; bizId?: string }): Promise<AliyunQueryOutput> {
    return {};
  }
}

describe("Aliyun resource discovery", () => {
  it("reads every signature page using page indexes and maps its complete resource set", async () => {
    const api = new PagedAliyunApi([
      { code: "OK", currentPage: 1, totalCount: 2, smsSignList: [signFixture("Alpha", "通用类型", "order-a")] },
      { code: "OK", currentPage: 2, totalCount: 2, smsSignList: [signFixture("Beta", "验证码类型", "order-b")] },
    ]);

    const result = await listAllAliyunSignatures(api, { pageSize: 1 });

    expect(result.items.map((item) => item.externalName)).toEqual(["Alpha", "Beta"]);
    expect(api.signatureRequests).toEqual([
      { pageIndex: 1, pageSize: 1 },
      { pageIndex: 2, pageSize: 1 },
    ]);
  });

  it("does not return a partial signature snapshot when a later page fails", async () => {
    const api = new PagedAliyunApi([
      { code: "OK", currentPage: 1, totalCount: 2, smsSignList: [signFixture("Seen", "通用类型")] },
    ], [], 2);

    await expect(listAllAliyunSignatures(api, { pageSize: 1 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(api.calls.signatures).toBe(2);
  });

  it("rejects repeated external signature keys even when the reported total is reached", async () => {
    const repeated = signFixture("Repeated", "通用类型", "order-duplicate");
    const api = new PagedAliyunApi([
      { code: "OK", currentPage: 1, totalCount: 2, smsSignList: [repeated] },
      { code: "OK", currentPage: 2, totalCount: 2, smsSignList: [repeated] },
    ]);

    await expect(listAllAliyunSignatures(api, { pageSize: 1 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("rejects a repeated or mismatched provider current page", async () => {
    const api = new PagedAliyunApi([
      { code: "OK", currentPage: 1, totalCount: 2, smsSignList: [signFixture("Alpha", "通用类型")] },
      { code: "OK", currentPage: 1, totalCount: 2, smsSignList: [signFixture("Beta", "验证码类型")] },
    ]);

    await expect(listAllAliyunSignatures(api, { pageSize: 1 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("maps unsupported signature resources in provider list methods to PROVIDER_UNAVAILABLE", async () => {
    const provider = createAliyunProvider({
      api: new FakeAliyunApi().withSignatures([{ ...signFixture("Unsupported", "General") }]),
      secretResolver: { resolve: async (reference) => `resolved:${reference}` },
    });

    await expect(provider.listSignatures({ ...authInput, pageSize: 20 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("maps unsupported template resources in provider list methods to PROVIDER_UNAVAILABLE", async () => {
    const provider = createAliyunProvider({
      api: new FakeAliyunApi().withTemplates([templateFixture({ templateType: 1, outerTemplateType: 2 })]),
      secretResolver: { resolve: async (reference) => `resolved:${reference}` },
    });

    await expect(provider.listTemplates({ ...authInput, pageSize: 20 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("does not return a partial template snapshot when a later page fails", async () => {
    const api = new PagedAliyunApi([], [
      { code: "OK", currentPage: 1, totalCount: 2, smsTemplateList: [templateFixture({ templateType: 0, outerTemplateType: 1 })] },
    ], undefined, 2);

    await expect(listAllAliyunTemplates(api, { pageSize: 1 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(api.calls.templates).toBe(2);
  });

  it("continues through pages without a total count until the provider returns an empty page", async () => {
    const api = new PagedAliyunApi([
      { code: "OK", currentPage: 1, smsSignList: [signFixture("Alpha", "通用类型")] },
      { code: "OK", currentPage: 2, smsSignList: [signFixture("Beta", "验证码类型")] },
    ]);

    const result = await listAllAliyunSignatures(api, { pageSize: 1 });

    expect(result.items.map((item) => item.externalName).sort()).toEqual(["Alpha", "Beta"]);
    expect(api.calls.signatures).toBe(3);
  });

  it("reads every template page before returning a snapshot", async () => {
    const api = new PagedAliyunApi([], [
      { code: "OK", currentPage: 1, totalCount: 2, smsTemplateList: [templateFixture({ templateType: 0, outerTemplateType: 1 }, "SMS_1")] },
      { code: "OK", currentPage: 2, totalCount: 2, smsTemplateList: [templateFixture({ templateType: 2, outerTemplateType: 0 }, "SMS_2")] },
    ]);

    const result = await listAllAliyunTemplates(api, { pageSize: 1 });

    expect(result.items.map((item) => item.templateType)).toEqual(["notification", "verification"]);
    expect(api.templateRequests).toEqual([
      { pageIndex: 1, pageSize: 1 },
      { pageIndex: 2, pageSize: 1 },
    ]);
  });

  it.each([
    [{ templateType: 0, outerTemplateType: 1 }, "notification"],
    [{ templateType: 2, outerTemplateType: 0 }, "verification"],
  ] as const)("maps only consistent mainland template enums %j", (raw, expected) => {
    expect(mapTemplate(templateFixture(raw)).templateType).toBe(expected);
  });

  it.each([
    { templateType: 1, outerTemplateType: 2 },
    { templateType: 6, outerTemplateType: 3 },
    { templateType: 0, outerTemplateType: 0 },
    { templateType: undefined, outerTemplateType: 1 },
    { templateType: 2, outerTemplateType: undefined },
  ])("rejects marketing, international, conflicting, or incomplete template enums %j", (raw) => {
    expect(() => mapTemplate(templateFixture(raw as { templateType?: number; outerTemplateType?: number })))
      .toThrowError(/unsupported template type/i);
  });

  it("keeps same-name signatures with different business types under distinct stable keys", async () => {
    const general = signFixture("Same Name", "通用类型");
    const verification = signFixture("Same Name", "验证码类型");
    const api = new PagedAliyunApi([
      { code: "OK", totalCount: 2, smsSignList: [general, verification] },
    ]);

    const result = await listAllAliyunSignatures(api, { pageSize: 20 });

    expect(result.items.map((item) => item.externalKey)).toEqual([
      "aliyun:sign:j1iPSNU7-xd5mXiNDS0y32tTBk7an5pCT_7bPmK7AA8",
      "aliyun:sign:rVuOg5CmLK8xFl9g18OqOJOdP058RjV_qy4rBJb_B00",
    ]);
    expect(new Set(result.items.map((item) => item.externalKey)).size).toBe(2);
  });

  it("uses the provider order ID as the stable signature key when present", () => {
    expect(toAliyunExternalKey(signFixture("Renamed", "通用类型", "order-123")))
      .toBe("aliyun:sign:order-123");
  });
});
