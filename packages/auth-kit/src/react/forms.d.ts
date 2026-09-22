import { type AuthClient } from "./client.js";
export type AuthFormView = "login" | "reset-password" | "change-password";
export type AuthFormSuccess = "sign-in" | "password-reset" | "password-change";
export type AuthFormsProps = {
    client?: AuthClient;
    basePath?: string;
    fetch?: typeof fetch;
    initialView?: AuthFormView;
    className?: string;
    onSuccess?: (action: AuthFormSuccess) => void;
};
export declare function AuthForms({ client: providedClient, basePath, fetch: requestFetch, initialView, className, onSuccess, }: AuthFormsProps): import("react").JSX.Element;
