import type { RuntimeBackend, RuntimeEpisode, RuntimeEpisodeSpec } from "./runtime-contracts.js";
export { RUNTIME_EPISODE_ACTION_SCHEMA, RUNTIME_EPISODE_OBSERVATION_SCHEMA, RUNTIME_EPISODE_SNAPSHOT_SCHEMA, RUNTIME_EPISODE_TRACE_JSON_SCHEMA, RUNTIME_EPISODE_TRACE_SCHEMA, runtimeEpisodeDigest, validateRuntimeEpisodeTrace, } from "./runtime-episode-contracts.js";
export declare function createRuntimeEpisode(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<RuntimeEpisode>;
//# sourceMappingURL=runtime-episode.d.ts.map