import type { MainlandPhone } from "../core/phone.js";
import type { MessageId, TenantId } from "../core/types.js";

export interface SecretResolver {
  /** Resolves a reference for one operation. Implementations must not cache or emit its value. */
  resolve(reference: string): Promise<string>;
}

export type ProtectionContext = Readonly<{
  envelopeVersion: 1;
  purpose: "phone" | "render-params";
  tenantId: TenantId;
  recordId: MessageId;
  fieldName: "phone_ciphertext" | "render_params_ciphertext";
}>;

export interface MessagePayloadProtector {
  seal(
    value: Readonly<Record<string, string>>,
    context: ProtectionContext,
  ): Promise<{ ciphertext: string; keyId: string }>;
  open(
    input: { ciphertext: string; keyId: string },
    context: ProtectionContext,
  ): Promise<Readonly<Record<string, string>>>;
}

export interface PhoneNumberProtector {
  protect(phone: MainlandPhone, context: ProtectionContext): Promise<{
    ciphertext: string;
    keyId: string;
    lookupHash: string;
    masked: string;
    last4: string;
  }>;
  unprotect(
    input: { ciphertext: string; keyId: string },
    context: ProtectionContext,
  ): Promise<MainlandPhone>;
}

export interface OtpHasher {
  hash(value: string): Promise<string>;
  verify(value: string, hash: string): Promise<boolean>;
}

export type AuthorizationActor = Readonly<{
  id: string;
  tenantId: TenantId;
  permissions?: readonly string[];
}>;

export interface Authorizer<Actor = AuthorizationActor> {
  assert(actor: Actor, action: string): Promise<void> | void;
}
