import * as DysmsapiSdk from "@alicloud/dysmsapi20170525";
import {
  QuerySendDetailsRequest,
  QuerySmsSignListRequest,
  QuerySmsTemplateListRequest,
  SendSmsRequest,
} from "@alicloud/dysmsapi20170525";

import type {
  AliyunApi,
  AliyunQueryOutput,
  AliyunSendInput,
  AliyunSendOutput,
  AliyunSignPage,
  AliyunTemplatePage,
} from "./api.js";

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
export class AliyunSdkClientFactory implements AliyunClientFactory {
  create(credentials: AliyunClientCredentials): AliyunApi {
    const config = {
      regionId: credentials.region,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      ...(credentials.endpoint === undefined ? {} : { endpoint: credentials.endpoint }),
    };
    const client = new DysmsapiSdk.default.default(
      config as ConstructorParameters<typeof DysmsapiSdk.default.default>[0],
    );

    return new AliyunSdkApi(client);
  }
}

class AliyunSdkApi implements AliyunApi {
  constructor(private readonly client: InstanceType<typeof DysmsapiSdk.default.default>) {}

  async querySmsSignList(input: { pageIndex: number; pageSize: number }): Promise<AliyunSignPage> {
    const response = await this.client.querySmsSignList(new QuerySmsSignListRequest(input));
    return response.body ?? {};
  }

  async querySmsTemplateList(input: { pageIndex: number; pageSize: number }): Promise<AliyunTemplatePage> {
    const response = await this.client.querySmsTemplateList(new QuerySmsTemplateListRequest(input));
    return response.body ?? {};
  }

  async sendSms(input: AliyunSendInput): Promise<AliyunSendOutput> {
    const response = await this.client.sendSms(new SendSmsRequest(input));
    return response.body ?? {};
  }

  async querySendDetails(input: {
    phoneNumber: string;
    sendDate: string;
    currentPage: number;
    pageSize: number;
    bizId?: string;
  }): Promise<AliyunQueryOutput> {
    const response = await this.client.querySendDetails(new QuerySendDetailsRequest(input));
    return response.body ?? {};
  }
}
