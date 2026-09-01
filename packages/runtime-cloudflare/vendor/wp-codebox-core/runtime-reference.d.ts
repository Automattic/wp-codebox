import type { ArtifactFileDigest, ArtifactViewerMetadata } from "./artifact-manifest.js";
import type { RuntimeEpisodeContentDigest, RuntimeEpisodeTrace, RuntimeEpisodeTraceRef, RuntimeInfo, Snapshot } from "./runtime-contracts.js";
export declare const RUNTIME_REFERENCE_MANIFEST_SCHEMA: "wp-codebox/runtime-reference-manifest/v1";
export declare const RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA: "wp-codebox/runtime-replay-reference-index/v1";
export type RuntimeSnapshotReplayStatus = "metadata-only" | "partial-replay" | "replayable-runtime-state" | "runtime-state-artifact" | "not-replayable" | (string & {});
export interface RuntimeReferenceManifestFileRef {
    path: string;
    kind: string;
    contentType: string;
    sha256: ArtifactFileDigest;
    viewer?: ArtifactViewerMetadata;
}
export interface RuntimeReferenceManifestArtifactBundleRef {
    kind: "artifact-bundle";
    id: string;
    digest: ArtifactFileDigest;
}
export interface RuntimeReferenceManifestSnapshotRef {
    id: string;
    semantics: string;
    digest: RuntimeEpisodeContentDigest;
    replay: {
        status: RuntimeSnapshotReplayStatus;
        limitations: string[];
    };
    artifactRefs: RuntimeEpisodeTraceRef[];
}
export interface RuntimeReferenceManifest {
    schema: typeof RUNTIME_REFERENCE_MANIFEST_SCHEMA;
    version: 1;
    id: string;
    createdAt: string;
    digest: RuntimeEpisodeContentDigest;
    runtime: RuntimeInfo;
    artifactBundle: RuntimeReferenceManifestArtifactBundleRef;
    files: RuntimeReferenceManifestFileRef[];
    trace?: RuntimeReferenceManifestFileRef;
    events?: RuntimeReferenceManifestFileRef;
    snapshots: RuntimeReferenceManifestSnapshotRef[];
}
export interface RuntimeReplayReferenceIndexActionRef {
    index: number;
    id: string;
    actionRef: RuntimeEpisodeTraceRef;
    executionRef: RuntimeEpisodeTraceRef;
    observationRef?: RuntimeEpisodeTraceRef;
}
export interface RuntimeReplayReferenceIndexObservationRef {
    id: string;
    type: string;
    ref: RuntimeEpisodeTraceRef;
    artifactRefs: RuntimeEpisodeTraceRef[];
}
export interface RuntimeReplayReferenceIndex {
    schema: typeof RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA;
    version: 1;
    id: string;
    createdAt: string;
    digest: RuntimeEpisodeContentDigest;
    runtime: RuntimeInfo;
    artifactBundle: RuntimeReferenceManifestArtifactBundleRef;
    references: {
        trace?: RuntimeReferenceManifestFileRef;
        events?: RuntimeReferenceManifestFileRef;
        runtimeReferenceManifest?: RuntimeReferenceManifestFileRef;
        observations?: RuntimeReferenceManifestFileRef;
        commands?: RuntimeReferenceManifestFileRef;
        runtimeEvents?: RuntimeReferenceManifestFileRef;
        blueprintAfter?: RuntimeReferenceManifestFileRef;
        blueprintAfterNotes?: RuntimeReferenceManifestFileRef;
        mountedFiles?: RuntimeReferenceManifestFileRef;
        mountDiffs?: RuntimeReferenceManifestFileRef;
        changedFiles?: RuntimeReferenceManifestFileRef;
        patch?: RuntimeReferenceManifestFileRef;
        testResults?: RuntimeReferenceManifestFileRef;
    };
    actions: RuntimeReplayReferenceIndexActionRef[];
    observations: RuntimeReplayReferenceIndexObservationRef[];
    snapshots: RuntimeReferenceManifestSnapshotRef[];
    replay: {
        status: "partial" | "runtime-state-artifact" | "metadata-only";
        instructions: string[];
        limitations: string[];
    };
}
export interface BuildRuntimeReferenceManifestInput {
    createdAt: string;
    runtime: RuntimeInfo;
    artifactBundle: RuntimeReferenceManifestArtifactBundleRef;
    files: RuntimeReferenceManifestFileRef[];
    trace?: RuntimeReferenceManifestFileRef;
    events?: RuntimeReferenceManifestFileRef;
    snapshots?: Snapshot[];
}
export interface BuildRuntimeReplayReferenceIndexInput {
    createdAt: string;
    runtime: RuntimeInfo;
    artifactBundle: RuntimeReferenceManifestArtifactBundleRef;
    files: RuntimeReferenceManifestFileRef[];
    trace?: RuntimeReferenceManifestFileRef;
    events?: RuntimeReferenceManifestFileRef;
    runtimeReferenceManifest?: RuntimeReferenceManifestFileRef;
    snapshots?: Snapshot[];
    episodeTrace?: RuntimeEpisodeTrace;
}
export declare function buildRuntimeReferenceManifest(input: BuildRuntimeReferenceManifestInput): RuntimeReferenceManifest;
export declare function runtimeReferenceManifestDigest(manifest: RuntimeReferenceManifest): RuntimeEpisodeContentDigest;
export declare function buildRuntimeReplayReferenceIndex(input: BuildRuntimeReplayReferenceIndexInput): RuntimeReplayReferenceIndex;
export declare function runtimeReplayReferenceIndexDigest(index: RuntimeReplayReferenceIndex): RuntimeEpisodeContentDigest;
//# sourceMappingURL=runtime-reference.d.ts.map