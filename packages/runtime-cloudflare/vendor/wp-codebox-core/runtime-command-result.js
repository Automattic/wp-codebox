import { RUNTIME_COMMAND_RESULT_SCHEMA } from "./runtime-contracts.js";
export function createRuntimeCommandResultEnvelope(result) {
    return {
        schema: RUNTIME_COMMAND_RESULT_SCHEMA,
        ...result,
    };
}
export function runtimeCommandResultEnvelopeFromOutput(input) {
    const stdout = input.stdout ?? "";
    const json = parseRuntimeCommandJsonStdout(stdout);
    return createRuntimeCommandResultEnvelope({
        status: input.status ?? "ok",
        stdout,
        stderr: input.stderr ?? "",
        ...(json === undefined ? {} : { json }),
        ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
        ...(input.artifactRefs?.length ? { artifactRefs: input.artifactRefs } : {}),
        ...(input.error ? { error: input.error } : {}),
    });
}
function parseRuntimeCommandJsonStdout(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=runtime-command-result.js.map