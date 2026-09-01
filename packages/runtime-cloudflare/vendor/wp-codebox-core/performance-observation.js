import { stripUndefined } from "./object-utils.js";
export const PERFORMANCE_OBSERVATION_SCHEMA = "wp-codebox/performance-observation/v1";
export function performanceObservation(input = {}) {
    return stripUndefined({
        schema: PERFORMANCE_OBSERVATION_SCHEMA,
        command: input.command,
        target: input.target,
        source: input.source,
        kind: input.kind,
        timing: input.timing,
        memory: input.memory,
        database: input.database,
        hooks: input.hooks,
        network: input.network,
        browser: input.browser,
        artifactRefs: input.artifactRefs,
        capture: input.capture,
        metadata: input.metadata,
    });
}
export function performanceObservationCaptureRequest(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {};
    }
    const record = input;
    return stripUndefined({
        queries: typeof record.queries === "boolean" ? record.queries : undefined,
    });
}
//# sourceMappingURL=performance-observation.js.map