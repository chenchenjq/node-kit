export type {
  AliyunApi,
  AliyunQueryOutput,
  AliyunSendInput,
  AliyunSendOutput,
  AliyunSignPage,
  AliyunTemplatePage,
} from "./api.js";
export { AliyunSdkClientFactory } from "./client.js";
export type { AliyunClientCredentials, AliyunClientFactory } from "./client.js";
export { classifyAliyunError, classifyAliyunFailure } from "./error-map.js";
export type { AliyunFailureClass } from "./error-map.js";
export { AliyunSmsProvider, createAliyunProvider } from "./provider.js";
export type { AliyunSmsProviderOptions } from "./provider.js";
export {
  listAllAliyunSignatures,
  listAllAliyunTemplates,
  mapSignature,
  mapTemplate,
  toAliyunExternalKey,
} from "./resource-map.js";
export type { AliyunResourceListOptions } from "./resource-map.js";
export { parseAliyunReceiptBatch } from "./receipt.js";
export type { AliyunReceipt } from "./receipt.js";
