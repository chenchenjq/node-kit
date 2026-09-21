export declare function validatePassword(password: string): void;
/** Use for first-time credential preparation; importing an existing hash must not call this. */
export declare function hashPassword(password: string): Promise<string>;
/** Login verification deliberately does not apply new-password policy. */
export declare function verifyPassword(input: {
    hash: string;
    password: string;
}): Promise<boolean>;
