import type { CallInput, PlanSummary, StreamEvent } from "../types.js";
export interface TextGenerationExampleProps {
    listPlans(): Promise<PlanSummary[]>;
    stream(input: CallInput): AsyncIterable<StreamEvent>;
    className?: string | undefined;
}
export declare function TextGenerationExample({ listPlans, stream, className, }: TextGenerationExampleProps): import("react").JSX.Element;
