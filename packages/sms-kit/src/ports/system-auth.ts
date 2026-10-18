import type { SmsErrorCode } from "../core/errors.js";
import type { ChallengeId, MessageId } from "../core/types.js";
import type { SmsTransaction } from "./store.js";

export type SystemAuthAction = "login.authenticate" | "password.reset";

export type SystemAuthChallenge = Readonly<{
  id: ChallengeId;
  idempotencyKey: string;
  subjectId: string;
  action: SystemAuthAction;
  phoneHash: string;
  codeHash: string;
  maxAttempts: number;
  attemptCount: number;
  expiresAt: Date;
  proofTtlSeconds: number;
  deliveryAcceptanceStatus: "pending" | "accepted" | "rejected" | "unknown";
  invalidatedAt?: Date;
  terminalErrorCode?: SmsErrorCode;
  verifiedAt?: Date;
  proofHash?: string;
  proofExpiresAt?: Date;
}>;

export interface SystemAuthRepository {
  getChallengeByIdempotency(
    input: Readonly<{ idempotencyKey: string }>,
    tx?: SmsTransaction,
  ): Promise<SystemAuthChallenge | undefined>;
  createChallenge(
    input: Readonly<{
      id: ChallengeId;
      idempotencyKey: string;
      subjectId: string;
      action: SystemAuthAction;
      purpose: "login_otp" | "password_reset";
      policyVersion: number;
      otpLength: number;
      otpTtlSeconds: number;
      proofTtlSeconds: number;
      phoneHash: string;
      codeHash: string;
      maxAttempts: number;
      expiresAt: Date;
    }>,
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge>;
  invalidateActiveChallenges(
    input: Readonly<{
      subjectId: string;
      action: SystemAuthAction;
      invalidatedAt: Date;
    }>,
    tx: SmsTransaction,
  ): Promise<void>;
  getChallengeForUpdate(
    input: Readonly<{ id: ChallengeId }>,
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge | undefined>;
  incrementChallengeAttempts(
    input: Readonly<{ id: ChallengeId }>,
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge>;
  verifyChallenge(
    input: Readonly<{
      id: ChallengeId;
      verifiedAt: Date;
      proofHash: string;
      proofExpiresAt: Date;
    }>,
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge>;
  consumeProof(
    input: Readonly<{
      subjectId: string;
      action: SystemAuthAction;
      proofHash: string;
      consumptionKey: string;
      now: Date;
    }>,
    tx: SmsTransaction,
  ): Promise<"consumed" | "replay" | "invalid">;
  markChallengeDelivery(
    input: Readonly<{
      id: ChallengeId;
      status: "accepted" | "rejected" | "unknown";
      invalidatedAt?: Date;
      terminalErrorCode?: SmsErrorCode;
    }>,
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge>;
  createMessage(
    input: Readonly<{
      id: MessageId;
      idempotencyKey: string;
      templateId: string;
      templateKey: string;
      templateCode: string;
      signatureName: string;
      purpose: string;
      phoneCiphertext: string;
      phoneKeyId: string;
      phoneHash: string;
      phoneLast4: string;
      phoneMasked: string;
      variableNames: readonly string[];
      submittedAt: Date;
    }>,
    tx: SmsTransaction,
  ): Promise<{ id: MessageId; created: boolean }>;
  markMessageAcceptance(
    input: Readonly<{
      id: MessageId;
      status: "accepted" | "rejected" | "unknown";
      occurredAt: Date;
      providerBizId?: string;
      providerRequestId?: string;
      errorCode?: string;
    }>,
    tx: SmsTransaction,
  ): Promise<void>;
}
