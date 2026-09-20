import type { ConnectionInput, ConnectionSummary, DictionaryItem, Plan, PlanInput, TestDraft, TestResult } from "../types.js";
export interface AiManagerProps {
    load(): Promise<{
        providers: DictionaryItem[];
        connections: ConnectionSummary[];
        plans: Plan[];
    }>;
    saveConnection(input: ConnectionInput): Promise<unknown>;
    savePlan(input: PlanInput): Promise<unknown>;
    testDraft(input: TestDraft): Promise<TestResult>;
    testPlan(code: string): Promise<TestResult>;
    setDefault(code: string | null): Promise<void>;
    refreshModels?(connectionId: string): Promise<string[]>;
    className?: string | undefined;
}
export declare function AiManager(props: AiManagerProps): import("react").JSX.Element;
