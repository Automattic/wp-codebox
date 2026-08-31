import type { ArtifactBundle, RuntimeEpisodeContentDigest, RuntimeEpisodeTraceRef } from "./runtime-contracts.js";
import type { ArtifactFileDigest, ArtifactManifestFile, ArtifactViewerMetadata } from "./artifact-manifest.js";
import type { RuntimeReferenceManifestArtifactBundleRef, RuntimeReferenceManifestFileRef } from "./runtime-reference.js";
import { BROWSER_SESSION_PRODUCT_DTO_SCHEMA, type RuntimeAccess } from "./runtime-boundary-contracts.js";
export declare const METADATA_ARTIFACT_PATH: "metadata.json";
export declare const REVIEW_ARTIFACT_PATH: "files/review.json";
export declare const RUNTIME_EPISODE_TRACE_ARTIFACT_PATH: "files/runtime-episode-trace.json";
export declare const RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH: "files/runtime-episode.jsonl";
export declare const RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH: "files/runtime-reference-manifest.json";
export declare const RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH: "files/runtime-replay-index.json";
export declare const RUNTIME_SNAPSHOT_ARTIFACT_PATH: "files/runtime-snapshot.json";
export declare const CHANGED_FILES_ARTIFACT_PATH: "files/changed-files.json";
export declare const PATCH_ARTIFACT_PATH: "files/patch.diff";
export declare const ARTIFACT_MANIFEST_PATH: "manifest.json";
export declare const PUBLIC_ARTIFACT_REF_DTO_SCHEMA: "wp-codebox/artifact-ref/v1";
export interface ArtifactReferenceDigestInput {
    algorithm?: string;
    value?: string;
    sha256?: string | ArtifactReferenceDigestInput;
    digest?: string | ArtifactReferenceDigestInput;
}
export interface ArtifactReferenceFileInput {
    path?: string;
    kind?: string;
    contentType?: string;
    content_type?: string;
    mimeType?: string;
    mime?: string;
    sha256?: string | ArtifactReferenceDigestInput;
    digest?: string | ArtifactReferenceDigestInput;
    viewer?: ArtifactViewerMetadata;
}
export interface ArtifactReferenceTraceInput extends ArtifactReferenceFileInput {
    id?: string;
    artifactId?: string;
}
export interface NormalizeRuntimeEpisodeTraceRefDefaults {
    kind?: RuntimeEpisodeTraceRef["kind"];
    id?: string;
    artifactId?: string;
    path?: string;
    digest?: string | ArtifactReferenceDigestInput;
}
export interface BrowserArtifactSummaryRef {
    probeIndex: number;
    field: string;
    kind: string;
    path: string;
    contentType?: string;
}
export interface PublicArtifactRefDTO {
    schema: typeof PUBLIC_ARTIFACT_REF_DTO_SCHEMA;
    kind: string;
    id?: string;
    path?: string;
    url?: string;
    contentType?: string;
    sha256?: string;
    digest?: RuntimeEpisodeContentDigest;
    size_bytes?: number;
    label?: string;
    metadata?: Record<string, unknown>;
}
export interface PublicArtifactRefGroups {
    all: PublicArtifactRefDTO[];
    artifact_bundles: PublicArtifactRefDTO[];
    changed_files: PublicArtifactRefDTO[];
    patches: PublicArtifactRefDTO[];
    browser: PublicArtifactRefDTO[];
    logs: PublicArtifactRefDTO[];
    transcripts: PublicArtifactRefDTO[];
}
export interface BrowserSessionProductDTO {
    schema: typeof BROWSER_SESSION_PRODUCT_DTO_SCHEMA;
    source_schema?: string;
    success: boolean;
    status?: string;
    execution?: string;
    execution_scope?: string;
    permission_model?: string;
    session_id?: string;
    contained_site?: Record<string, unknown>;
    task?: string;
    target?: Record<string, unknown>;
    agent?: string;
    provider?: string;
    model?: string;
    preview_boot?: Record<string, unknown>;
    runtime_access?: RuntimeAccess;
    signals?: Record<string, unknown>;
    artifacts?: Record<string, unknown>;
    artifact_refs: PublicArtifactRefGroups;
    error?: Record<string, unknown>;
}
type BrowserArtifactProbeSummary = Record<string, unknown>;
export declare function normalizeArtifactDigest(input: string | ArtifactReferenceDigestInput | undefined): RuntimeEpisodeContentDigest | undefined;
export declare function normalizeArtifactFileDigest(input: string | ArtifactReferenceDigestInput | undefined): ArtifactFileDigest | undefined;
export declare function normalizePublicArtifactRefDTO(input: unknown, defaults?: Partial<PublicArtifactRefDTO>): PublicArtifactRefDTO | undefined;
export declare function normalizePublicArtifactRefDTOs(input: unknown): PublicArtifactRefDTO[];
export declare function publicArtifactRefGroups(input: unknown): PublicArtifactRefGroups;
export declare function changedFilesArtifactRefs(input: unknown): PublicArtifactRefDTO[];
export declare function patchArtifactRefs(input: unknown): PublicArtifactRefDTO[];
export declare function findChangedFilesArtifactRef(input: unknown): PublicArtifactRefDTO | undefined;
export declare function findPatchArtifactRef(input: unknown): PublicArtifactRefDTO | undefined;
export declare function normalizeBrowserSessionProductDTO(input: unknown): BrowserSessionProductDTO;
export declare function normalizeArtifactContentType(input: ArtifactReferenceFileInput | undefined, fallback?: string): string;
export declare function normalizeRuntimeReferenceManifestFileRef(input: ArtifactReferenceFileInput | ArtifactManifestFile): RuntimeReferenceManifestFileRef | undefined;
export declare function normalizeRuntimeReferenceManifestFileRefs(inputs: Array<ArtifactReferenceFileInput | ArtifactManifestFile>): RuntimeReferenceManifestFileRef[];
export declare function runtimeReferenceManifestArtifactFiles(files: ArtifactManifestFile[]): ArtifactManifestFile[];
export declare function runtimeReplayReferenceIndexArtifactFiles(files: ArtifactManifestFile[]): ArtifactManifestFile[];
export declare function normalizeRuntimeEpisodeTraceRef(input: ArtifactReferenceTraceInput, defaults?: NormalizeRuntimeEpisodeTraceRefDefaults): RuntimeEpisodeTraceRef | undefined;
export declare function normalizeRuntimeEpisodeTraceRefs(inputs: ArtifactReferenceTraceInput[], defaults?: NormalizeRuntimeEpisodeTraceRefDefaults): RuntimeEpisodeTraceRef[];
export declare function normalizeObservationArtifactRefs(input: {
    artifactRefs?: ArtifactReferenceTraceInput[];
} | ArtifactReferenceTraceInput[] | undefined): RuntimeEpisodeTraceRef[];
export declare function normalizeArtifactBundleTraceRef(bundle: Pick<ArtifactBundle, "id" | "directory" | "contentDigest"> | undefined): RuntimeEpisodeTraceRef | undefined;
export declare function normalizeRuntimeReferenceArtifactBundleRef(input: {
    id?: string;
    digest?: string | ArtifactReferenceDigestInput;
    contentDigest?: string | ArtifactReferenceDigestInput;
} | Pick<ArtifactBundle, "id" | "contentDigest">): RuntimeReferenceManifestArtifactBundleRef | undefined;
export declare function normalizeBrowserArtifactSummaryRefs(summary: {
    probes?: BrowserArtifactProbeSummary[];
} | undefined): BrowserArtifactSummaryRef[];
export {};
//# sourceMappingURL=artifact-references.d.ts.map