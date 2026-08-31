export interface ResolvedArtifactPath {
    root: string;
    relativePath: string;
    absolutePath: string;
}
export declare function safeArtifactRelativePath(path: string): string;
export declare function resolveArtifactPath(root: string, path: string): ResolvedArtifactPath;
//# sourceMappingURL=artifact-paths.d.ts.map