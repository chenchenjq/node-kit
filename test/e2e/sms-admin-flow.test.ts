import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createAdminHost,
  fixtureTenantA,
  fixtureTenantB,
} from "../fixtures/admin-host.js";

describe.sequential("complete SMS administration flow", () => {
  let host: Awaited<ReturnType<typeof createAdminHost>> | undefined;

  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it("configures shared resources, delivers one tenant message, and fences identical tenant work", async () => {
    host = await createAdminHost();
    const tenantA = host.forTenant(fixtureTenantA);
    const tenantB = host.forTenant(fixtureTenantB);

    const initialConfig = await tenantA.patchConfig();
    expect(initialConfig).toMatchObject({ status: "untested", enabled: false, version: 1 });
    await expect(tenantA.getOverview()).resolves.toMatchObject({ status: "disabled", providerStatus: "untested" });

    const connection = await tenantA.testConnection(initialConfig.version);
    expect(connection).toMatchObject({
      status: "succeeded",
      signatureCount: 1,
      templateCount: 1,
      config: { status: "ready", enabled: false, version: 2 },
    });
    const enabledConfig = await tenantA.enableConfig(connection.config.version);
    expect(enabledConfig).toMatchObject({ status: "ready", enabled: true, version: 3 });

    const preview = await tenantA.syncPreview(enabledConfig.version);
    const signatureCandidate = preview.candidates.find((candidate) => candidate.resourceType === "signature");
    const templateCandidate = preview.candidates.find((candidate) => candidate.resourceType === "template");
    expect(signatureCandidate).toBeDefined();
    expect(templateCandidate).toMatchObject({
      externalKey: "aliyun:template:SMS_FIXTURE_NOTIFICATION",
      changeType: "new",
      snapshot: {
        kind: "template",
        externalName: "Fixture notification",
        externalStatus: "AUDIT_STATE_PASS",
        templateType: "notification",
        variableNames: ["orderNo", "otp", "proof"],
      },
    });
    expect(templateCandidate).not.toHaveProperty("templateKey");
    if (signatureCandidate === undefined || templateCandidate === undefined) throw new Error("fixture sync candidates are incomplete");

    const committed = await tenantA.syncCommit(enabledConfig.version, preview.id, [signatureCandidate]);
    expect(committed).toMatchObject({ status: "partial", importedCount: 1 });
    const signature = (await tenantA.listSignatures()).items[0];
    expect(signature).toMatchObject({ externalKey: signatureCandidate.externalKey, enabled: true, version: 1 });
    if (signature === undefined) throw new Error("fixture signature was not imported");

    const importedTemplate = await tenantA.importTemplate(signature.version, templateCandidate);
    const enabledTemplate = await tenantA.enableTemplate(importedTemplate);
    expect(enabledTemplate).toMatchObject({ templateKey: "notice.fixture", enabled: true, version: 2 });
    await expect(tenantB.listTemplates()).resolves.toMatchObject({
      total: 1,
      items: [{ id: enabledTemplate.id, templateKey: "notice.fixture", enabled: true }],
    });

    const sharedIdempotencyKey = "fixture:shared-idempotency-key";
    const messageA = await tenantA.enqueueFixtureNotification(sharedIdempotencyKey);
    const messageB = await tenantB.enqueueFixtureNotification(sharedIdempotencyKey);
    expect(messageA.id).not.toBe(messageB.id);
    expect(messageA).toMatchObject({ acceptanceStatus: "pending", deliveryStatus: "not_applicable" });
    expect(messageB).toMatchObject({ acceptanceStatus: "pending", deliveryStatus: "not_applicable" });
    expect(host.fakeAliyun.calls.sendSms).toBe(0);

    await expect(host.runTask("send-worker")).resolves.toMatchObject({ status: 200, data: 2 });
    expect(host.fakeAliyun.calls.sendSms).toBe(2);
    await expect(tenantA.getMessage(messageA.id)).resolves.toMatchObject({
      status: 200,
      data: { acceptanceStatus: "accepted", deliveryStatus: "waiting", attemptCount: 1 },
    });
    await expect(tenantB.getMessage(messageB.id)).resolves.toMatchObject({
      status: 200,
      data: { acceptanceStatus: "accepted", deliveryStatus: "waiting", attemptCount: 1 },
    });

    const jobA = await host.reconcileJobId(fixtureTenantA, messageA.id);
    const jobB = await host.reconcileJobId(fixtureTenantB, messageB.id);
    await expect(tenantA.getJob(jobA)).resolves.toMatchObject({ status: 200, data: { id: jobA, jobType: "reconcile" } });
    await expect(tenantA.getJob(jobB)).resolves.toMatchObject({ status: 404 });
    await expect(tenantA.getMessage(messageB.id)).resolves.toMatchObject({ status: 404 });

    await expect(host.postDeliveredReceipt(messageA.id)).resolves.toMatchObject({ status: 200, data: { code: 0, msg: "成功" } });
    await expect(host.runTask("daily-rollup")).resolves.toMatchObject({ status: 200, data: 2 });

    await expect(tenantA.getMessage(messageA.id)).resolves.toMatchObject({
      status: 200,
      data: { acceptanceStatus: "accepted", deliveryStatus: "delivered", attemptCount: 1 },
    });
    await expect(tenantB.getMessage(messageB.id)).resolves.toMatchObject({
      status: 200,
      data: { acceptanceStatus: "accepted", deliveryStatus: "waiting", attemptCount: 1 },
    });
    await expect(tenantA.getStats()).resolves.toMatchObject({
      submitted: 1,
      accepted: 1,
      acceptanceRejected: 0,
      acceptanceUnknown: 0,
      deliveryWaiting: 0,
      delivered: 1,
      deliveryFailed: 0,
      deliveryUnknownFinal: 0,
      retry: 0,
      acceptanceRate: 1,
      deliveryRate: 1,
    });
    await expect(tenantB.getStats()).resolves.toMatchObject({
      submitted: 1,
      accepted: 1,
      acceptanceRejected: 0,
      acceptanceUnknown: 0,
      deliveryWaiting: 1,
      delivered: 0,
      deliveryFailed: 0,
      deliveryUnknownFinal: 0,
      retry: 0,
      acceptanceRate: 1,
      deliveryRate: 0,
    });

    expect(host.events.map((event) => event.name)).toEqual(expect.arrayContaining([
      "config.saved",
      "config.connection_tested",
      "resource.sync.previewed",
      "resource.sync.committed",
      "resource.template.imported",
      "resource.template.updated",
      "sms.test.enqueued",
    ]));
    host.assertNoSensitiveData();
  }, 120_000);
});
