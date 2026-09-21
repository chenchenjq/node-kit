import type { ReactNode } from "react";
import type { TestResult } from "../types.js";
export declare function Field({ label, children, hint, }: {
    label: string;
    children: (id: string) => ReactNode;
    hint?: string;
}): import("react").JSX.Element;
export declare function safeMessage(error: unknown): string;
export declare function useOperation(): {
    busy: string | null;
    message: string;
    failed: boolean;
    run: (name: string, work: () => Promise<void>) => Promise<void>;
};
export declare function Feedback({ message, failed, }: {
    message: string;
    failed: boolean;
}): import("react").JSX.Element;
export declare function TestFeedback({ value }: {
    value: TestResult | null;
}): import("react").JSX.Element | null;
