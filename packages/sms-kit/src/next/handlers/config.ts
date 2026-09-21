import type { ConfigService } from "../../application/config-service.js";
import type { HealthService } from "../../application/health-service.js";
import type { SendService } from "../../application/send-service.js";
import { SmsKitError } from "../../core/errors.js";
import type { AuthorizationActor } from "../../ports/security.js";
import type { Message, ProviderConfig } from "../../ports/store.js";
import {
  connectionTestResultDtoSchema,
  messageDtoSchema,
  providerConfigDtoSchema,
  secretRefDtoSchema,
  smsErrorCodeSchema,
  smsOverviewDtoSchema,
  type TestSendInput,
  type TestConnectionInput,
  type UpdateProviderConfigInput,
} from "../types/index.js";

/** The narrowly scoped application services required by the configuration routes. */
export type SmsConfigRouteServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  config?: Pick<ConfigService<Actor>, "get" | "patch" | "testConnection">;
  health?: Pick<HealthService, "getSnapshot">;
  send?: Pick<SendService, "enqueueTestNotification">;
}>;

function requireService<T>(value: T | undefined): T {
  if (value === undefined) throw new SmsKitError("STORAGE_FAILURE", "admin route service is unavailable");
  return value;
}

function date(value: Date): string {
  return value.toISOString();
}

function connectionCount(config: ProviderConfig, name: "signature" | "template"): number {
  if (config.status === "unconfigured") throw new SmsKitError("STORAGE_FAILURE", "connection test result is unavailable");
  const value = config.lastTestSummary?.counts?.find((count) => count.name === name)?.value;
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new SmsKitError("STORAGE_FAILURE", "connection test result is unavailable");
  }
  return value as number;
}

/** Converts an opaque reference into a display identifier without retaining any reference path. */
function secretReference(reference: string) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(reference)?.[1]?.toLowerCase();
  if (scheme === undefined) throw new SmsKitError("STORAGE_FAILURE", "stored secret reference is invalid");
  const safeParts = reference.slice(reference.indexOf("://") + 3).match(/[A-Z0-9]{1,8}/g) ?? [];
  const first = safeParts[0];
  const last = safeParts.at(-1);
  // A single identifier segment is legal input but is itself sensitive.  The
  // DTO intentionally has no one-label form, so never echo it in a mask.
  const candidate = first === undefined || last === undefined || first === last ? "***" : `${first}_***_${last}`;
  const projected = secretRefDtoSchema.safeParse({ scheme, maskedName: candidate, configured: true });
  if (projected.success) return projected.data;
  const fallback = secretRefDtoSchema.safeParse({ scheme, maskedName: "***", configured: true });
  if (fallback.success) return fallback.data;
  throw new SmsKitError("STORAGE_FAILURE", "stored secret reference is invalid");
}

/** Explicit allow-list projection: no raw secret reference may cross this function. */
export function providerConfigDto(config: ProviderConfig) {
  if (config.status === "unconfigured") {
    return providerConfigDtoSchema.parse({
      provider: "aliyun", status: "unconfigured", enabled: false, lastTestStatus: "never", version: config.version,
    });
  }
  return providerConfigDtoSchema.parse({
    provider: "aliyun", status: config.status, enabled: config.enabled, region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    accessKeyIdRef: secretReference(config.accessKeyIdRef),
    accessKeySecretRef: secretReference(config.accessKeySecretRef),
    receiptCallbackTokenRef: secretReference(config.receiptCallbackTokenRef),
    lastTestStatus: config.lastTestStatus,
    ...(config.lastTestedAt === undefined ? {} : { lastTestedAt: date(config.lastTestedAt) }),
    version: config.version,
  });
}

/** Explicit message projection drops ciphertext, hashes, parameters, and the full phone number. */
export function messageDto(message: Pick<Message, "id" | "phoneMasked" | "phoneLast4" | "templateKeySnapshot" | "purpose" | "acceptanceStatus" | "deliveryStatus" | "submittedAt" | "providerBizId" | "finalErrorCode"> & Readonly<{ attemptCount?: number | string }>) {
  const finalErrorCode = message.finalErrorCode === undefined
    ? undefined
    : smsErrorCodeSchema.safeParse(message.finalErrorCode);
  return messageDtoSchema.parse({
    id: message.id,
    phone: { masked: message.phoneMasked ?? null, last4Available: message.phoneLast4 !== undefined },
    templateKey: message.templateKeySnapshot,
    purpose: message.purpose,
    acceptanceStatus: message.acceptanceStatus,
    deliveryStatus: message.deliveryStatus,
    submittedAt: date(message.submittedAt),
    attemptCount: message.attemptCount ?? 0,
    ...(message.providerBizId === undefined ? {} : { providerBizId: message.providerBizId }),
    ...(finalErrorCode === undefined || !finalErrorCode.success ? {} : { finalErrorCode: finalErrorCode.data }),
  });
}

export async function configurationRoute<Actor extends AuthorizationActor>(
  services: SmsConfigRouteServices<Actor>,
  actor: Actor,
  path: string,
  body: unknown,
): Promise<unknown | undefined> {
  if (path === "/overview") {
    const snapshot = await requireService(services.health).getSnapshot({ tenantId: actor.tenantId });
    return smsOverviewDtoSchema.parse({
      status: snapshot.status,
      providerStatus: snapshot.providerStatus,
      pendingJobs: snapshot.pendingJobs,
      acceptanceUnknown: snapshot.acceptanceUnknown,
      deliveryUnknown: snapshot.finalUnknown,
      unmatchedCount: snapshot.unmatchedReceipts,
      systemBudgetRemaining: snapshot.systemBudgetRemaining,
      circuitOpen: snapshot.circuitOpen,
      warnings: snapshot.warnings,
    });
  }

  if (path === "/config") {
    const config = requireService(services.config);
    if (body === undefined) return providerConfigDto(await config.get(actor));
    const input = body as UpdateProviderConfigInput;
    return providerConfigDto(await config.patch(actor, {
      provider: input.provider ?? "aliyun", region: input.region, ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      accessKeyIdRef: input.accessKeyIdRef, accessKeySecretRef: input.accessKeySecretRef,
      ...(input.receiptCallbackTokenRef === undefined ? {} : { receiptCallbackTokenRef: input.receiptCallbackTokenRef }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      expectedVersion: input.version, idempotencyKey: input.idempotencyKey,
    }));
  }

  if (path === "/config/test-connection") {
    const input = body as TestConnectionInput;
    const config = await requireService(services.config).testConnection(actor, {
      expectedVersion: input.version,
      idempotencyKey: input.idempotencyKey,
    });
    const testedAt = config.status === "unconfigured" ? undefined : config.lastTestedAt;
    return connectionTestResultDtoSchema.parse({
      status: config.lastTestStatus === "succeeded" ? "succeeded" : "failed",
      testedAt: date(testedAt ?? new Date(0)), signatureCount: connectionCount(config, "signature"),
      templateCount: connectionCount(config, "template"), config: providerConfigDto(config),
    });
  }

  if (path === "/config/test-send") {
    const input = body as TestSendInput;
    const message = await requireService(services.send).enqueueTestNotification(actor, {
      expectedVersion: input.version, phone: input.phone, templateKey: input.templateKey, variables: input.variables,
      purpose: input.purpose, idempotencyKey: input.idempotencyKey,
    });
    return messageDto(message);
  }
  return undefined;
}
