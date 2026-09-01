export interface RuntimePackageManifest {
    schema: string;
    package: string;
    package_root: string;
    profiles: Record<string, RuntimePackageProfile>;
}
export interface RuntimePackageProfile {
    description?: string;
    abilities: string[];
    selectors: Array<{
        type: "file" | "prefix";
        path: string;
    }>;
    required_files: string[];
}
export interface RuntimePackageFileSelection {
    sourcePath: string;
    targetPath: string;
}
export declare function parseRuntimePackageManifest(source: string): RuntimePackageManifest;
export declare function selectRuntimePackageProfileFiles(manifest: RuntimePackageManifest, profileName: string, archivePaths: string[], manifestPath: string): RuntimePackageFileSelection[];
//# sourceMappingURL=runtime-package-profile.d.ts.map