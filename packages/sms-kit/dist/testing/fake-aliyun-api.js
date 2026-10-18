export function signFixture() {
    return {
        signName: "Example",
        auditStatus: "AUDIT_STATE_PASS",
        businessType: "通用类型",
    };
}
export function templateFixture() {
    return {
        templateCode: "SMS_123456",
        templateName: "Example",
        auditStatus: "AUDIT_STATE_PASS",
        templateType: 2,
        outerTemplateType: 0,
        templateContent: "Your code is ${code}",
    };
}
export class FakeAliyunApi {
    calls = {
        querySmsSignList: 0,
        querySmsTemplateList: 0,
        sendSms: 0,
        querySendDetails: 0,
    };
    lastQueryInput;
    signatures = { code: "OK", smsSignList: [] };
    templates = { code: "OK", smsTemplateList: [] };
    sendOutput = { code: "OK", bizId: "biz-1", requestId: "request-1" };
    queryOutput = { code: "OK" };
    signatureListFailure;
    withSignatures(signatures) {
        this.signatures = { code: "OK", totalCount: signatures.length, smsSignList: signatures };
        return this;
    }
    withTemplates(templates) {
        this.templates = { code: "OK", totalCount: templates.length, smsTemplateList: templates };
        return this;
    }
    failSignatureList(error) {
        this.signatureListFailure = error;
        return this;
    }
    async querySmsSignList(_input) {
        this.calls.querySmsSignList += 1;
        if (this.signatureListFailure !== undefined) {
            throw this.signatureListFailure;
        }
        return this.signatures;
    }
    async querySmsTemplateList(_input) {
        this.calls.querySmsTemplateList += 1;
        return this.templates;
    }
    async sendSms(_input) {
        this.calls.sendSms += 1;
        return this.sendOutput;
    }
    async querySendDetails(_input) {
        this.calls.querySendDetails += 1;
        this.lastQueryInput = _input;
        return this.queryOutput;
    }
}
