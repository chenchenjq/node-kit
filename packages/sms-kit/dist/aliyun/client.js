import { createRequire } from "node:module";
import { RuntimeOptions } from "@alicloud/tea-util";
import { QuerySendDetailsRequest, QuerySmsSignListRequest, QuerySmsTemplateListRequest, SendSmsRequest, } from "@alicloud/dysmsapi20170525";
import { aliyunSdkEndpointAuthority } from "../core/provider-endpoint.js";
// The Aliyun SDK is CommonJS.  A stable require shape is required because
// OMS runs TypeScript through tsx, whose namespace-import interop differs
// from Node's native ESM wrapper.
const require = createRequire(import.meta.url);
const DysmsapiSdk = require("@alicloud/dysmsapi20170525");
/** Creates a fresh SDK client for each provider operation; it intentionally has no credential state. */
export class AliyunSdkClientFactory {
    create(credentials) {
        const config = {
            regionId: credentials.region,
            accessKeyId: credentials.accessKeyId,
            accessKeySecret: credentials.accessKeySecret,
            ...(credentials.endpoint === undefined ? {} : { endpoint: aliyunSdkEndpointAuthority(credentials.endpoint) }),
        };
        const client = new DysmsapiSdk.default(config);
        return new AliyunSdkApi(client);
    }
}
class AliyunSdkApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async querySmsSignList(input) {
        const response = await this.client.querySmsSignList(new QuerySmsSignListRequest(input));
        return response.body ?? {};
    }
    async querySmsTemplateList(input) {
        const response = await this.client.querySmsTemplateList(new QuerySmsTemplateListRequest(input));
        return response.body ?? {};
    }
    async sendSms(input) {
        const { timeoutMs = 10_000, ...request } = input;
        const response = await this.client.sendSmsWithOptions(new SendSmsRequest(request), new RuntimeOptions({ readTimeout: timeoutMs, connectTimeout: timeoutMs, autoretry: false, maxAttempts: 1 }));
        return response.body ?? {};
    }
    async querySendDetails(input) {
        const response = await this.client.querySendDetails(new QuerySendDetailsRequest(input));
        return response.body ?? {};
    }
}
