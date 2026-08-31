import type { ObservationResult, RuntimeEpisodeActionRecord, RuntimeEpisodeActionSpec, RuntimeEpisodeContentDigest, RuntimeEpisodeTraceValidationResult, Snapshot } from "./runtime-contracts.js";
export declare const RUNTIME_EPISODE_TRACE_SCHEMA: "wp-codebox/runtime-episode-trace/v1";
export declare const RUNTIME_EPISODE_ACTION_SCHEMA: "wp-codebox/runtime-episode-action/v1";
export declare const RUNTIME_EPISODE_OBSERVATION_SCHEMA: "wp-codebox/runtime-episode-observation/v1";
export declare const RUNTIME_EPISODE_SNAPSHOT_SCHEMA: "wp-codebox/runtime-episode-snapshot/v1";
export declare const RUNTIME_EPISODE_TRACE_JSON_SCHEMA: {
    readonly $id: "wp-codebox/runtime-episode-trace/v1";
    readonly type: "object";
    readonly required: readonly ["schema", "version", "id", "createdAt", "runtime", "reset", "steps", "snapshots"];
    readonly properties: {
        readonly schema: {
            readonly const: "wp-codebox/runtime-episode-trace/v1";
        };
        readonly version: {
            readonly const: 1;
        };
        readonly id: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly createdAt: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly runtime: {
            readonly type: "object";
            readonly required: readonly ["id", "backend", "environment", "createdAt", "status"];
        };
        readonly reset: {
            readonly type: "object";
            readonly required: readonly ["id", "runtime", "observations", "observationRefs"];
        };
        readonly steps: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["id", "index", "action", "actionRef", "execution", "executionRef"];
                readonly properties: {
                    readonly action: {
                        readonly type: "object";
                        readonly required: readonly ["schema", "id", "kind", "command", "args", "digest"];
                        readonly properties: {
                            readonly schema: {
                                readonly const: "wp-codebox/runtime-episode-action/v1";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly kind: {
                                readonly enum: readonly ["command", "filesystem", "http", "browser"];
                            };
                            readonly command: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly args: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                            readonly cwd: {
                                readonly type: "string";
                            };
                            readonly timeoutMs: {
                                readonly type: "number";
                                readonly minimum: 0;
                            };
                            readonly method: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly url: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly path: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly operation: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly selector: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly description: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly metadata: {
                                readonly type: "object";
                            };
                            readonly digest: {
                                readonly type: "object";
                                readonly required: readonly ["algorithm", "value"];
                                readonly properties: {
                                    readonly algorithm: {
                                        readonly const: "sha256";
                                    };
                                    readonly value: {
                                        readonly type: "string";
                                        readonly pattern: "^[a-f0-9]{64}$";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly observation: {
                        readonly type: "object";
                        readonly required: readonly ["schema", "id", "type", "data", "observedAt", "digest"];
                    };
                };
            };
        };
        readonly snapshots: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["schema", "id", "createdAt", "semantics", "metadata", "digest"];
            };
        };
        readonly artifacts: {
            readonly type: "object";
        };
        readonly artifactRef: {
            readonly type: "object";
            readonly required: readonly ["kind", "id"];
        };
    };
    readonly additionalProperties: true;
};
export declare function runtimeEpisodeDigest(value: unknown): RuntimeEpisodeContentDigest;
export declare function runtimeEpisodeActionDigestPayload(action: RuntimeEpisodeActionRecord | RuntimeEpisodeActionSpec): Record<string, unknown>;
export declare function runtimeEpisodeObservationDigestPayload(observation: ObservationResult): Record<string, unknown>;
export declare function runtimeEpisodeSnapshotDigestPayload(snapshot: Snapshot): Record<string, unknown>;
export declare function validateRuntimeEpisodeTrace(trace: unknown): RuntimeEpisodeTraceValidationResult;
//# sourceMappingURL=runtime-episode-contracts.d.ts.map