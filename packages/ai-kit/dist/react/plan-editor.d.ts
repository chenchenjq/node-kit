import type { ConnectionSummary, Plan, PlanInput, TestResult } from "../types.js";
export interface PlanEditorProps {
    connections: ConnectionSummary[];
    plan?: Plan | undefined;
    save(input: PlanInput): Promise<void>;
    test?(input: PlanInput): Promise<TestResult>;
    className?: string | undefined;
}
export declare function PlanEditor({ connections, plan, save, test, className, }: PlanEditorProps): import("react").JSX.Element;
