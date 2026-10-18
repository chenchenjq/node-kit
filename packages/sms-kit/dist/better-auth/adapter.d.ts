import type { BetterAuthPasswordResetPreRouteGuard, BetterAuthSmsAdapterOptions, BetterAuthSmsCallbacks } from "./types.js";
/**
 * Bridges Better Auth's callbacks to SMS Kit without allowing account existence,
 * tenant identity, phones, or OTPs to leave this trusted server boundary.
 */
export declare function createBetterAuthSmsAdapter(options: BetterAuthSmsAdapterOptions): BetterAuthSmsCallbacks;
/**
 * Applies the trusted reset-request preflight around the complete Better Auth
 * route. Better Auth 1.7.4 skips `sendPasswordResetOTP` for unknown users, so
 * wrapping only that callback cannot provide a constant response envelope.
 */
export declare function createBetterAuthPasswordResetPreRouteGuard(options: BetterAuthSmsAdapterOptions): BetterAuthPasswordResetPreRouteGuard;
