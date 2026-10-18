/** Validates the credential-free HTTPS-origin representation stored by sms-kit. */
export declare function isProviderEndpointOrigin(value: string): boolean;
/**
 * Converts a stored HTTPS origin to the Aliyun SDK authority. A bare authority
 * remains accepted only for compatibility with direct provider compositions.
 */
export declare function aliyunSdkEndpointAuthority(value: string): string;
