export type MainlandPhone = string & {
    readonly __brand: "MainlandPhone";
};
/** Strict national storage representation; E.164 remains the provider/lookup contract. */
export declare function normalizeMainlandNationalPhone(input: string): string;
export declare function normalizeMainlandPhone(input: string): MainlandPhone;
export declare function maskMainlandPhone(phone: MainlandPhone): string;
