import type { RuntimeInfo } from "./runtime-contracts.js";
export interface ArtifactSpec {
    includeFiles?: boolean;
    includeLogs?: boolean;
    includePatch?: boolean;
    includeScreenshots?: boolean;
    includeObservations?: boolean;
    includeRuntimeSnapshotBundles?: boolean;
    previewHoldSeconds?: number;
}
export interface ArtifactManifestFile {
    path: string;
    kind: "manifest" | "metadata" | "events" | "commands" | "observations" | "log" | "mounts" | "file" | "diagnostics" | "test-results" | "tool-call-transcript" | "tool-call-input" | "tool-call-output" | (string & {});
    contentType: string;
    sha256: ArtifactFileDigest;
    redaction?: ArtifactRedactionMetadata;
    provenance?: ArtifactProvenanceMetadata;
    viewer?: ArtifactViewerMetadata;
}
export interface ArtifactRedactionMetadata {
    policy: "none" | "required" | "applied" | (string & {});
    reason?: string;
    sensitive?: boolean;
}
export interface ArtifactProvenanceMetadata {
    source: string;
    operation?: string;
    id?: string;
    metadata?: Record<string, unknown>;
}
export interface ArtifactViewerMetadata {
    kind: string;
    base: string;
    query: {
        parameter: string;
        value: {
            source: "public-artifact-url" | (string & {});
            path: string;
            kind?: string;
            contentType?: string;
            sha256?: ArtifactFileDigest;
        };
        encoding: "url" | (string & {});
    };
    replay: {
        status: "full" | "partial" | "unavailable" | (string & {});
        limitations: string[];
    };
}
export interface ArtifactManifestCaseArtifactRef {
    path: string;
    kind: string;
    contentType?: string;
    sha256?: ArtifactFileDigest;
    publicUrl?: string;
    redaction?: ArtifactRedactionMetadata;
    provenance?: ArtifactProvenanceMetadata;
    metadata?: Record<string, unknown>;
}
export interface ArtifactManifestCaseVerificationMetadata {
    status: "passed" | "failed" | "skipped" | "unknown" | (string & {});
    verifiedAt?: string;
    verifier?: string;
    diagnostics?: string[];
    metadata?: Record<string, unknown>;
}
export interface ArtifactManifestCase {
    id: string;
    hash?: ArtifactFileDigest;
    digest?: ArtifactFileDigest;
    artifacts: ArtifactManifestCaseArtifactRef[];
    redaction?: ArtifactRedactionMetadata;
    verification?: ArtifactManifestCaseVerificationMetadata;
    metadata?: Record<string, unknown>;
}
export interface ArtifactFileDigest {
    algorithm: "sha256";
    value: string;
}
export interface ArtifactManifest {
    id: string;
    contentDigest: ArtifactContentDigest;
    createdAt: string;
    runtime: RuntimeInfo;
    files: ArtifactManifestFile[];
    cases?: ArtifactManifestCase[];
}
export interface ArtifactContentDigest {
    algorithm: "sha256";
    inputs: string[];
    value: string;
}
export declare function artifactFileDigest(contents: string | Buffer): ArtifactFileDigest;
export interface ArtifactManifestFileOptions {
    viewer?: ArtifactViewerMetadata;
    redaction?: ArtifactRedactionMetadata;
    provenance?: ArtifactProvenanceMetadata;
}
export declare function artifactManifestFile(path: string, kind: ArtifactManifestFile["kind"], contentType: string, sha256?: ArtifactFileDigest, viewerOrOptions?: ArtifactViewerMetadata | ArtifactManifestFileOptions): ArtifactManifestFile;
export declare function artifactManifestFileWithSha256(path: string, kind: ArtifactManifestFile["kind"], contentType: string, sha256: string): ArtifactManifestFile;
export declare function placeholderArtifactFileDigest(): ArtifactFileDigest;
export declare function calculateArtifactContentDigest(directory: string, inputs: string[]): Promise<string>;
export declare function calculateArtifactManifestFileListDigest(files: ArtifactManifestFile[]): string;
export declare function calculateArtifactManifestFileSha256(directory: string, manifest: ArtifactManifest, file: ArtifactManifestFile, manifestFileName?: string): Promise<string>;
export declare function calculateArtifactManifestSelfSha256(manifest: ArtifactManifest, manifestFileName?: string): string;
export declare function upsertArtifactManifestFiles(manifest: ArtifactManifest, files: ArtifactManifestFile[]): void;
export declare function refreshArtifactManifestFileSha256s(directory: string, manifest: ArtifactManifest, manifestFileName?: string): Promise<void>;
//# sourceMappingURL=artifact-manifest.d.ts.map