import type {
  QuerySendDetailsResponseBody,
  QuerySendDetailsResponseBodySmsSendDetailDTOs,
  QuerySendDetailsResponseBodySmsSendDetailDTOsSmsSendDetailDTO,
  QuerySmsSignListResponseBody,
  QuerySmsSignListResponseBodySmsSignList,
  QuerySmsTemplateListResponseBody,
  QuerySmsTemplateListResponseBodySmsTemplateList,
  SendSmsResponseBody,
} from "@alicloud/dysmsapi20170525";

export type AliyunSign = Readonly<Pick<
  QuerySmsSignListResponseBodySmsSignList,
  "auditStatus" | "businessType" | "orderId" | "signName"
>>;

export type AliyunSignPage = Readonly<Pick<
  QuerySmsSignListResponseBody,
  "code" | "currentPage" | "requestId" | "totalCount"
> & { smsSignList?: readonly AliyunSign[] }>;

export type AliyunTemplate = Readonly<Pick<
  QuerySmsTemplateListResponseBodySmsTemplateList,
  "auditStatus" | "outerTemplateType" | "templateCode" | "templateContent" | "templateName" | "templateType"
>>;

export type AliyunTemplatePage = Readonly<Pick<
  QuerySmsTemplateListResponseBody,
  "code" | "currentPage" | "requestId" | "totalCount"
> & { smsTemplateList?: readonly AliyunTemplate[] }>;

export type AliyunSendOutput = Readonly<Pick<
  SendSmsResponseBody,
  "bizId" | "code" | "requestId"
>>;

export type AliyunDeliveryDetail = Readonly<Pick<
  QuerySendDetailsResponseBodySmsSendDetailDTOsSmsSendDetailDTO,
  "errCode" | "outId" | "receiveDate" | "sendDate" | "sendStatus"
>>;

export type AliyunQueryOutput = Readonly<Pick<
  QuerySendDetailsResponseBody,
  "code" | "requestId" | "totalCount"
> & { smsSendDetailDTOs?: Readonly<Pick<
  QuerySendDetailsResponseBodySmsSendDetailDTOs,
  never
> & { smsSendDetailDTO?: readonly AliyunDeliveryDetail[] }> }>;

export type AliyunSendInput = Readonly<{
  phoneNumbers: string;
  signName: string;
  templateCode: string;
  templateParam: string;
  outId: string;
  timeoutMs?: number;
}>;

/** The narrow boundary that keeps the Alibaba SDK outside the core provider port. */
export interface AliyunApi {
  querySmsSignList(input: { pageIndex: number; pageSize: number }): Promise<AliyunSignPage>;
  querySmsTemplateList(input: { pageIndex: number; pageSize: number }): Promise<AliyunTemplatePage>;
  sendSms(input: AliyunSendInput): Promise<AliyunSendOutput>;
  querySendDetails(input: {
    phoneNumber: string;
    sendDate: string;
    currentPage: number;
    pageSize: number;
    bizId?: string;
  }): Promise<AliyunQueryOutput>;
}
