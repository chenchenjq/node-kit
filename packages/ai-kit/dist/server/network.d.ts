export interface TransportDependencies {
    lookup?(hostname: string): Promise<{
        address: string;
        family: number;
    }[]>;
    fetch?: typeof globalThis.fetch;
}
export declare function isPublicAddress(address: string): boolean;
export declare function validateBaseURL(value: string): URL;
export interface SafeTransport {
    fetch: typeof globalThis.fetch;
    close(): Promise<void>;
}
/** DNS is checked once, then pinned in the TLS connection lookup; redirect handling is disabled. */
export declare function createSafeTransport(baseURL: string, allowURL: (url: URL) => Promise<boolean>, deps?: TransportDependencies, maxResponseBytes?: number): Promise<SafeTransport>;
