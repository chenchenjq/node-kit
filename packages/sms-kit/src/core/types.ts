export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type TenantId = Brand<string, "TenantId">;
export type MessageId = Brand<string, "MessageId">;
export type TemplateId = Brand<string, "TemplateId">;
export type ChallengeId = Brand<string, "ChallengeId">;
