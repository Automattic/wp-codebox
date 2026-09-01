export declare const RUNTIME_ARCHIVE_COMPONENT_SCHEMA: "wp-codebox/runtime-archive-component/v1";
export declare const RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA: "wp-codebox/runtime-archive-component-source/v1";
export interface RuntimeArchiveComponent {
    schema: typeof RUNTIME_ARCHIVE_COMPONENT_SCHEMA;
    id: string;
    package: {
        profile: string;
        root: string;
    };
    wordpress: {
        install_path: string;
        bootstrap_file: string;
        load: {
            mode: "mu-plugin-loader";
            loader_path: string;
        };
        version_constant?: string;
    };
    abilities: Record<string, string>;
    limits: {
        files: number;
        bytes: number;
    };
}
export interface RuntimeArchiveComponentSource {
    schema: typeof RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA;
    source: {
        url: string;
        version: string;
        identity: string;
        sha256: string;
    };
    component: RuntimeArchiveComponent;
}
export declare function runtimeArchiveComponent(value: unknown): RuntimeArchiveComponent;
export declare function runtimeArchiveComponentSource(value: unknown): RuntimeArchiveComponentSource;
export declare function runtimeArchiveComponentOwnedWpContentPaths(component: RuntimeArchiveComponent): string[];
//# sourceMappingURL=runtime-archive-component.d.ts.map