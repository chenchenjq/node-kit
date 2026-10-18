import { createRequire } from "node:module";
import { RuntimeOptions } from "@alicloud/tea-util";
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
import { aliyunSdkEndpointAuthority } from "../core/provider-endpoint.js";

// The Aliyun SDK is CommonJS.  A stable require shape is required because
// OMS runs TypeScript through tsx, whose namespace-import interop differs
// from Node's native ESM wrapper.
const require = createRequire(import.meta.url);
const DysmsapiSdk = require("@alicloud/dysmsapi20170525") as typeof import("@alicloud/dysmsapi20170525");

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
      ...(credentials.endpoint === undefined ? {} : { endpoint: aliyunSdkEndpointAuthority(credentials.endpoint) }),
    };
    const client = new DysmsapiSdk.default(
      config as ConstructorParameters<typeof DysmsapiSdk.default>[0],
    );

    return new AliyunSdkApi(client);
  }
}

class AliyunSdkApi implements AliyunApi {
  constructor(private readonly client: InstanceType<typeof DysmsapiSdk.default>) {}

  async querySmsSignList(input: { pageIndex: number; pageSize: number }): Promise<AliyunSignPage> {
    const response = await this.client.querySmsSignList(new QuerySmsSignListRequest(input));
    return response.body ?? {};
  }

  async querySmsTemplateList(input: { pageIndex: number; pageSize: number }): Promise<AliyunTemplatePage> {
    const response = await this.client.querySmsTemplateList(new QuerySmsTemplateListRequest(input));
    return response.body ?? {};
  }

  async sendSms(input: AliyunSendInput): Promise<AliyunSendOutput> {
    const { timeoutMs = 10_000, ...request } = input;
    const response = await this.client.sendSmsWithOptions(new SendSmsRequest(request), new RuntimeOptions({ readTimeout: timeoutMs, connectTimeout: timeoutMs, autoretry: false, maxAttempts: 1 }));
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
