import { createHash } from "node:crypto";

import { SmsKitError } from "../core/errors.js";
import type { ProviderPage, ProviderSignature, ProviderTemplate } from "../ports/provider.js";
import type { AliyunApi, AliyunSign, AliyunSignPage, AliyunTemplate, AliyunTemplatePage } from "./api.js";

export type AliyunResourceListOptions = Readonly<{ pageSize: number }>;

function unavailable(): SmsKitError {
  return new SmsKitError("PROVIDER_UNAVAILABLE", "Alibaba Cloud SMS resources are unavailable", true);
}

function validatePageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new RangeError("Aliyun resource page size must be a positive integer");
  }
}

function resourceName(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid Aliyun resource response: missing ${field}`);
  }
  return value;
}

function optionalString(value: string | undefined, field: string): string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`invalid Aliyun resource response: invalid ${field}`);
  }
  return value;
}

export function toAliyunExternalKey(sign: AliyunSign): string {
  const signName = resourceName(sign.signName, "signName");
  const businessType = supportedSignatureType(sign.businessType);
  const orderId = optionalString(sign.orderId, "orderId");

  const fallback = createHash("sha256")
    .update(JSON.stringify([businessType, signName]), "utf8")
    .digest("base64url");
  return orderId === undefined || orderId.length === 0
    ? `aliyun:sign:${fallback}`
    : `aliyun:sign:${orderId}`;
}

function supportedSignatureType(value: string | undefined): "验证码类型" | "通用类型" {
  if (value !== "验证码类型" && value !== "通用类型") {
    throw new Error("unsupported signature business type");
  }
  return value;
}

export function mapSignature(sign: AliyunSign): ProviderSignature {
  const externalKey = toAliyunExternalKey(sign);
  const auditStatus = optionalString(sign.auditStatus, "auditStatus");
  return {
    externalKey,
    externalName: resourceName(sign.signName, "signName"),
    externalStatus: auditStatus ?? "unknown",
    externalType: supportedSignatureType(sign.businessType),
  };
}

export function mapTemplate(template: AliyunTemplate): ProviderTemplate {
  const templateType = template.templateType;
  const outerTemplateType = template.outerTemplateType;
  if (templateType === 0 && outerTemplateType === 1) {
    // The SDK's internal and external enums intentionally use different labels.
  } else if (templateType === 2 && outerTemplateType === 0) {
    // Only the consistent mainland verification pair is safe to import.
  } else {
    throw new Error("unsupported template type");
  }

  const templateCode = resourceName(template.templateCode, "templateCode");
  const templateName = resourceName(template.templateName, "templateName");
  const auditStatus = optionalString(template.auditStatus, "auditStatus");
  const content = optionalString(template.templateContent, "templateContent") ?? "";
  return {
    externalKey: `aliyun:template:${templateCode}`,
    externalCode: templateCode,
    externalName: templateName,
    externalStatus: auditStatus ?? "unknown",
    templateType: templateType === 0 ? "notification" : "verification",
    variableNames: [...content.matchAll(/\$\{([^}]+)\}/g)].flatMap((match) => match[1] === undefined ? [] : [match[1]]),
  };
}

async function fetchAll<TPage, TRaw, TMapped extends { externalKey: string }>(
  pageSize: number,
  request: (pageIndex: number, pageSize: number) => Promise<TPage>,
  getItems: (page: TPage) => readonly TRaw[] | undefined,
  getTotal: (page: TPage) => number | undefined,
  getCode: (page: TPage) => string | undefined,
  getCurrentPage: (page: TPage) => number | undefined,
  map: (resource: TRaw) => TMapped,
): Promise<ProviderPage<TMapped>> {
  validatePageSize(pageSize);
  const items: TMapped[] = [];
  const externalKeys = new Set<string>();
  let expectedTotal: number | undefined;
  try {
    for (let pageIndex = 1; ; pageIndex += 1) {
      const page = await request(pageIndex, pageSize);
      const responseItems = getItems(page);
      const totalCount = getTotal(page);
      if (
        getCode(page) !== "OK"
        || (getCurrentPage(page) !== undefined && getCurrentPage(page) !== pageIndex)
        || (responseItems === undefined && totalCount !== 0)
        || (responseItems !== undefined && !Array.isArray(responseItems))
        || (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || totalCount < 0))
      ) {
        throw new Error("invalid Aliyun resource page");
      }
      if (
        (expectedTotal !== undefined && totalCount !== expectedTotal)
        || (expectedTotal === undefined && totalCount !== undefined && totalCount < items.length)
      ) {
        throw new Error("inconsistent Aliyun resource total");
      }
      if (expectedTotal === undefined) {
        expectedTotal = totalCount;
      }
      const rawItems = responseItems ?? [];
      const mappedItems = rawItems.map(map);
      for (const item of mappedItems) {
        if (externalKeys.has(item.externalKey)) {
          throw new Error("duplicate Aliyun resource key");
        }
        externalKeys.add(item.externalKey);
      }
      items.push(...mappedItems);
      if (totalCount !== undefined && items.length > totalCount) {
        throw new Error("inconsistent Aliyun resource total");
      }
      if (rawItems.length === 0) {
        if (expectedTotal !== undefined && items.length < expectedTotal) {
          throw new Error("Aliyun resource page ended before the reported total");
        }
        break;
      }
      if (expectedTotal !== undefined && items.length >= expectedTotal) break;
      if (pageIndex >= 10_000) {
        throw new Error("Aliyun resource pagination limit exceeded");
      }
    }
  } catch {
    throw unavailable();
  }
  items.sort((left, right) => {
    if (left.externalKey !== right.externalKey) {
      return left.externalKey < right.externalKey ? -1 : 1;
    }
    const leftValue = JSON.stringify(left);
    const rightValue = JSON.stringify(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
  return { items };
}

export function listAllAliyunSignatures(
  api: AliyunApi,
  options: AliyunResourceListOptions,
): Promise<ProviderPage<ProviderSignature>> {
  return fetchAll(
    options.pageSize,
    (pageIndex, pageSize) => api.querySmsSignList({ pageIndex, pageSize }),
    (page: AliyunSignPage) => page.smsSignList,
    (page: AliyunSignPage) => page.totalCount,
    (page: AliyunSignPage) => page.code,
    (page: AliyunSignPage) => page.currentPage,
    mapSignature,
  );
}

export function listAllAliyunTemplates(
  api: AliyunApi,
  options: AliyunResourceListOptions,
): Promise<ProviderPage<ProviderTemplate>> {
  return fetchAll(
    options.pageSize,
    (pageIndex, pageSize) => api.querySmsTemplateList({ pageIndex, pageSize }),
    (page: AliyunTemplatePage) => page.smsTemplateList,
    (page: AliyunTemplatePage) => page.totalCount,
    (page: AliyunTemplatePage) => page.code,
    (page: AliyunTemplatePage) => page.currentPage,
    mapTemplate,
  );
}
