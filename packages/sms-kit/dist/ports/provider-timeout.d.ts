/** Only the winner can reach persistence; an eventual transport response has no continuation. */
export declare function withProviderTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T>;
