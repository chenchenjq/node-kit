import type { CallInput, GenerationResult, StreamEvent, TestResult, TestDraft } from "../types.js";
import type { Management } from "./management.js";
export declare function createGeneration<C>(m: Management<C>): {
    generate(ctx: C, input: CallInput): Promise<GenerationResult>;
    stream: (ctx: C, raw: CallInput) => AsyncGenerator<StreamEvent>;
    testPlan(ctx: C, code: string, signal?: AbortSignal): Promise<TestResult>;
    testDraft(ctx: C, raw: TestDraft, signal?: AbortSignal): Promise<TestResult>;
    refreshModels(ctx: C, connectionId: string, signal?: AbortSignal): Promise<string[]>;
};
