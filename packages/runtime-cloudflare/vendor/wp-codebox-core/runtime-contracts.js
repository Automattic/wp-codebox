import { assertRuntimePolicy } from "./runtime-policy.js";
export const RUNTIME_COMMAND_RESULT_SCHEMA = "wp-codebox/runtime-command-result/v1";
export class RuntimeCheckpointError extends Error {
    diagnostic;
    constructor(diagnostic) {
        super(diagnostic.message);
        this.name = "RuntimeCheckpointError";
        this.diagnostic = diagnostic;
    }
    toJSON() {
        return { ...this.diagnostic, name: this.name };
    }
}
export function runtimeCheckpointUnsupportedDiagnostic(operation, runtime, name) {
    const backend = runtime?.backend;
    return {
        schema: "wp-codebox/runtime-checkpoint-failure/v1",
        status: "unsupported",
        operation,
        ...(backend ? { backend } : {}),
        ...(name ? { name } : {}),
        code: "runtime-checkpoints-unsupported",
        message: backend ? `Runtime backend does not support checkpoints: ${backend}` : "Runtime backend does not support checkpoints.",
        supported: false,
    };
}
export async function createRuntime(spec, backend) {
    assertRuntimePolicy(spec.policy);
    if (backend.kind !== spec.backend) {
        throw new Error(`Backend ${backend.kind} cannot create runtime ${spec.backend}`);
    }
    return backend.create(spec);
}
export async function restoreRuntime(snapshot, backend, spec) {
    if (!backend.restore) {
        throw new Error(`Backend ${backend.kind} does not support runtime snapshot restore`);
    }
    return backend.restore(snapshot, spec);
}
//# sourceMappingURL=runtime-contracts.js.map