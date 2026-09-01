import { type ArtifactManifest, type ArtifactManifestFile, type ArtifactManifestFileOptions, type ArtifactViewerMetadata } from "./artifact-manifest.js";
export interface ManifestedArtifactFileInput {
    path: string;
    kind: ArtifactManifestFile["kind"];
    contentType: string;
    viewer?: ArtifactViewerMetadata;
    redaction?: ArtifactManifestFileOptions["redaction"];
    provenance?: ArtifactManifestFileOptions["provenance"];
}
export declare class ManifestedArtifactSet {
    private readonly entries;
    add(input: ManifestedArtifactFileInput): ArtifactManifestFile;
    files(): ArtifactManifestFile[];
}
export declare class ArtifactBundleWriter {
    private readonly directory;
    private readonly manifestPath;
    readonly artifacts: ManifestedArtifactSet;
    constructor(directory: string, manifestPath?: string);
    path(path: string): string;
    relativePath(path: string): string;
    write(path: string, contents: string | Buffer, manifest: Omit<ManifestedArtifactFileInput, "path">): Promise<void>;
    writeJson(path: string, value: unknown, manifest: Omit<ManifestedArtifactFileInput, "path" | "contentType"> & {
        contentType?: string;
    }): Promise<void>;
    writeJsonLines(path: string, records: unknown[], manifest: Omit<ManifestedArtifactFileInput, "path" | "contentType"> & {
        contentType?: string;
    }): Promise<void>;
    writeGenerated(path: string, manifest: Omit<ManifestedArtifactFileInput, "path">, write: (absolutePath: string) => Promise<void>): Promise<void>;
    importFile(path: string, sourcePath: string, manifest: Omit<ManifestedArtifactFileInput, "path">): Promise<void>;
    writeManifest<T extends ArtifactManifest>(manifest: T): Promise<T>;
}
export declare function artifactJson(value: unknown): string;
export declare function artifactJsonLines(records: unknown[]): string;
export declare function artifactManifestRelativePath(artifactRoot: string, path: string): string;
export declare function writeArtifactJson(path: string, value: unknown): Promise<void>;
export declare function writeArtifactManifestJson(directory: string, manifestPath: string, manifest: ArtifactManifest): Promise<void>;
//# sourceMappingURL=artifact-layout.d.ts.map