import type { ConnectionInput, ConnectionSummary, DictionaryItem, TestDraft, TestResult } from "../types.js";
export interface ConnectionEditorProps {
    providers: DictionaryItem[];
    connection?: ConnectionSummary | undefined;
    save(input: ConnectionInput): Promise<void>;
    test(input: TestDraft): Promise<TestResult>;
    className?: string | undefined;
}
export declare function ConnectionEditor({ providers, connection, save, test, className, }: ConnectionEditorProps): import("react").JSX.Element;
