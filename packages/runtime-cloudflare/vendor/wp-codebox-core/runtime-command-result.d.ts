export declare const RUNTIME_COMMAND_RESULT_SCHEMA: "wp-codebox/runtime-command-result/v1"
export interface RuntimeCommandResultEnvelope { schema: typeof RUNTIME_COMMAND_RESULT_SCHEMA; status: string; stdout?: string; stderr?: string; json?: unknown; diagnostics?: unknown; artifactRefs?: unknown[]; error?: unknown }
export declare function createRuntimeCommandResultEnvelope(result: Omit<RuntimeCommandResultEnvelope, "schema">): RuntimeCommandResultEnvelope
export declare function runtimeCommandResultEnvelopeFromOutput(input: { status?: string; stdout?: string; stderr?: string; diagnostics?: unknown; artifactRefs?: unknown[]; error?: unknown }): RuntimeCommandResultEnvelope
