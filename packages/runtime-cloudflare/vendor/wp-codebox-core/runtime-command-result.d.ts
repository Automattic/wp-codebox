import { type RuntimeCommandResultEnvelope, type RuntimeCommandResultError, type RuntimeCommandResultStatus, type RuntimeEpisodeTraceRef } from "./runtime-contracts.js";
export declare function createRuntimeCommandResultEnvelope(result: Omit<RuntimeCommandResultEnvelope, "schema">): RuntimeCommandResultEnvelope;
export interface RuntimeCommandResultEnvelopeFromOutputInput {
    status?: RuntimeCommandResultStatus;
    stdout?: string;
    stderr?: string;
    diagnostics?: unknown;
    artifactRefs?: RuntimeEpisodeTraceRef[];
    error?: RuntimeCommandResultError;
}
export declare function runtimeCommandResultEnvelopeFromOutput(input: RuntimeCommandResultEnvelopeFromOutputInput): RuntimeCommandResultEnvelope;
//# sourceMappingURL=runtime-command-result.d.ts.map