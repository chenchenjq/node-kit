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
  smsOverviewDtoSchema,
  type TestSendInput,
  type UpdateProviderConfigInput,
} from "../types/index.js";

/** The narrowly scoped application services required by the configuration routes. */
export type SmsConfigRouteServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  config?: Pick<ConfigService<Actor>, "get" | "save" | "testConnection">;
  health?: Pick<HealthService, "getSnapshot">;
  send?: Pick<SendService, "enqueueNotification">;
}>;

function requireService<T>(value: T | undefined): T {
  if (value === undefined) throw new SmsKitError("STORAGE_FAILURE", "admin route service is unavailable");
  return value;
}

function date(value: Date): string {
  return value.toISOString();
}

/** Converts an opaque reference into a display identifier without retaining any reference path. */
function secretReference(reference: string) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(reference)?.[1]?.toLowerCase();
  if (scheme === undefined) throw new SmsKitError("STORAGE_FAILURE", "stored secret reference is invalid");
  const safeParts = reference.slice(reference.indexOf("://") + 3).match(/[A-Z0-9]{1,8}/g) ?? [];
  const first = safeParts[0];
  const last = safeParts.at(-1);
  const maskedName = first === undefined || last === undefined ? "***" : first === last ? `${first}_***` : `${first}_***_${last}`;
  return { scheme, maskedName, configured: true };
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
export function messageDto(message: Pick<Message, "id" | "phoneMasked" | "phoneLast4" | "templateKeySnapshot" | "purpose" | "acceptanceStatus" | "deliveryStatus" | "submittedAt" | "providerBizId" | "finalErrorCode"> & Readonly<{ attemptCount?: number }>) {
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
    ...(message.finalErrorCode === undefined ? {} : { finalErrorCode: message.finalErrorCode }),
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
      providerStatus: snapshot.status === "unconfigured" ? "unconfigured" : snapshot.status === "disabled" ? "disabled" : snapshot.status === "ready" ? "ready" : "degraded",
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
    // The application service owns the optimistic lock; its input calls the field expectedVersion.
    if (input.receiptCallbackTokenRef === undefined) throw new SmsKitError("CONFIG_INVALID", "receipt callback token reference is required");
    return providerConfigDto(await config.save(actor, {
      provider: input.provider ?? "aliyun", region: input.region, ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      accessKeyIdRef: input.accessKeyIdRef, accessKeySecretRef: input.accessKeySecretRef,
      receiptCallbackTokenRef: input.receiptCallbackTokenRef, enabled: input.enabled ?? false, expectedVersion: input.version,
    }));
  }

  if (path === "/config/test-connection") {
    const config = await requireService(services.config).testConnection(actor);
    const testedAt = config.status === "unconfigured" ? undefined : config.lastTestedAt;
    return connectionTestResultDtoSchema.parse({
      status: config.lastTestStatus === "succeeded" ? "succeeded" : "failed",
      testedAt: date(testedAt ?? new Date(0)), signatureCount: 0, templateCount: 0, config: providerConfigDto(config),
    });
  }

  if (path === "/config/test-send") {
    const input = body as TestSendInput;
    const message = await requireService(services.send).enqueueNotification({
      tenantId: actor.tenantId, phone: input.phone, templateKey: input.templateKey, variables: input.variables,
      purpose: input.purpose, idempotencyKey: input.idempotencyKey,
    });
    return messageDto(message);
  }
  return undefined;
}
