export type NamedFileTreeSkipPolicy = "prepared-source" | "captured-mount";
export declare function normalizeRelativePath(path: string): string;
export declare function normalizeRootedPath(path: string, root?: string): string;
export declare function pathIsWithinRoot(path: string, root: string): boolean;
export declare function relativePathIsWithinRoot(path: string, root: string): boolean;
export declare function namedFileTreeSkipPolicy(policy: NamedFileTreeSkipPolicy): Set<string>;
export declare function namedFileTreeSkipPolicyNames(policy: NamedFileTreeSkipPolicy): string[];
export declare function fileTreeEntryNameSkipped(name: string, skipNames: ReadonlySet<string> | readonly string[]): boolean;
export declare function relativePathExcluded(relativePath: string, excludePaths: readonly string[]): boolean;
export declare function relativePathMatchesExcludePattern(relativePath: string, pattern: string): boolean;
export declare function phpStringArrayLiteral(values: readonly string[]): string;
//# sourceMappingURL=file-tree-policy.d.ts.map