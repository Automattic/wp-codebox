import type { FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js";
export declare const FUZZ_COVERAGE_PLAN_SCHEMA: "wp-codebox/fuzz-coverage-plan/v1";
export interface FuzzCoveragePlanReason {
    code: string;
    message: string;
    data?: Record<string, unknown>;
}
export interface FuzzCoveragePlanParameterGenerationHook {
    id: string;
    label?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface FuzzCoveragePlanParameterGenerationPlaceholder {
    hook: string;
    requiredInputs?: string[];
    metadata?: Record<string, unknown>;
}
export interface FuzzCoveragePlanItem {
    id: string;
    target?: FuzzSuiteTargetRef;
    description?: string;
    input?: unknown;
    reason?: FuzzCoveragePlanReason;
    parameterGeneration?: FuzzCoveragePlanParameterGenerationPlaceholder;
    metadata?: Record<string, unknown>;
}
export interface FuzzCoveragePlanSummary {
    discovered: number;
    generated: number;
    executable: number;
    executed: number;
    skipped: number;
    untested: number;
    caseIds: string[];
    targetIds: string[];
}
export interface FuzzCoveragePlanContract {
    schema: typeof FUZZ_COVERAGE_PLAN_SCHEMA;
    id: string;
    version?: string;
    discovered: FuzzCoveragePlanItem[];
    generated: FuzzCoveragePlanItem[];
    executable: FuzzCoveragePlanItem[];
    executed: FuzzCoveragePlanItem[];
    skipped: FuzzCoveragePlanItem[];
    untested: FuzzCoveragePlanItem[];
    parameterGenerationHooks?: FuzzCoveragePlanParameterGenerationHook[];
    summary: FuzzCoveragePlanSummary;
    metadata?: Record<string, unknown>;
}
export declare function fuzzCoveragePlanContract(input: {
    id: string;
    version?: string;
    discovered?: FuzzCoveragePlanItem[];
    generated?: FuzzCoveragePlanItem[];
    executable?: FuzzCoveragePlanItem[];
    executed?: FuzzCoveragePlanItem[];
    skipped?: FuzzCoveragePlanItem[];
    untested?: FuzzCoveragePlanItem[];
    parameterGenerationHooks?: FuzzCoveragePlanParameterGenerationHook[];
    metadata?: Record<string, unknown>;
}): FuzzCoveragePlanContract;
//# sourceMappingURL=fuzz-coverage-plan-contracts.d.ts.map