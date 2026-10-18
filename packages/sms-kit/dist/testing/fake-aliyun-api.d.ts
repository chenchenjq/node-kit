import type { AliyunApi, AliyunQueryOutput, AliyunSendInput, AliyunSendOutput, AliyunSignPage, AliyunTemplatePage } from "../aliyun/api.js";
export declare function signFixture(): NonNullable<AliyunSignPage["smsSignList"]>[number];
export declare function templateFixture(): NonNullable<AliyunTemplatePage["smsTemplateList"]>[number];
export declare class FakeAliyunApi implements AliyunApi {
    readonly calls: {
        querySmsSignList: number;
        querySmsTemplateList: number;
        sendSms: number;
        querySendDetails: number;
    };
    lastQueryInput: Parameters<AliyunApi["querySendDetails"]>[0] | undefined;
    private signatures;
    private templates;
    private sendOutput;
    private queryOutput;
    private signatureListFailure;
    withSignatures(signatures: NonNullable<AliyunSignPage["smsSignList"]>): this;
    withTemplates(templates: NonNullable<AliyunTemplatePage["smsTemplateList"]>): this;
    failSignatureList(error: unknown): this;
    querySmsSignList(_input: {
        pageIndex: number;
        pageSize: number;
    }): Promise<AliyunSignPage>;
    querySmsTemplateList(_input: {
        pageIndex: number;
        pageSize: number;
    }): Promise<AliyunTemplatePage>;
    sendSms(_input: AliyunSendInput): Promise<AliyunSendOutput>;
    querySendDetails(_input: {
        phoneNumber: string;
        sendDate: string;
        currentPage: number;
        pageSize: number;
        bizId?: string;
    }): Promise<AliyunQueryOutput>;
}
