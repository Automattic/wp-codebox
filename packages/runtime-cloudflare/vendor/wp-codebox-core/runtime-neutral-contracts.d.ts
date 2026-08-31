export type BackendNeutralRuntimeBackendKind = string & {};
export type RuntimeWordPressComponentIntentKind = "wordpress-core" | "plugin" | "mu-plugin" | "theme" | "runtime-overlay" | (string & {});
export type RuntimeWordPressFilesystemIntentType = "directory" | "file" | (string & {});
export type RuntimeWordPressFilesystemIntentMode = "readonly" | "readwrite" | "generated" | (string & {});
export interface RuntimeWordPressComponentIntent {
    kind: RuntimeWordPressComponentIntentKind;
    slug?: string;
    source?: string;
    target?: string;
    activate?: boolean;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
}
export interface RuntimeWordPressFilesystemIntent {
    type?: RuntimeWordPressFilesystemIntentType;
    source?: string;
    target: string;
    mode?: RuntimeWordPressFilesystemIntentMode;
    purpose?: string;
    metadata?: Record<string, unknown>;
}
/**
 * Bytes materialized into a WordPress runtime before caller-provided Blueprint
 * steps execute. Backends must reject targets outside the WordPress root.
 */
export interface RuntimeWordPressFilesystemOverlay {
    target: string;
    content?: string;
    contentBase64?: string;
    overwrite: boolean;
    purpose?: string;
    metadata?: Record<string, unknown>;
}
export interface RuntimeWordPressSetupPlanIntent {
    schema: "wp-codebox/wordpress-runtime-setup-plan/v1";
    backend?: BackendNeutralRuntimeBackendKind;
    components?: RuntimeWordPressComponentIntent[];
    filesystem?: RuntimeWordPressFilesystemIntent[];
    filesystemOverlays?: RuntimeWordPressFilesystemOverlay[];
    metadata?: Record<string, unknown>;
}
export interface BackendNeutralRuntimeAssetSpec {
    directory?: string;
    archive?: string;
    metadata?: Record<string, unknown>;
}
export interface BackendNeutralEnvironmentSpec {
    kind: string;
    name?: string;
    version?: string;
    assets?: BackendNeutralRuntimeAssetSpec;
    metadata?: Record<string, unknown>;
}
export type RuntimeWordPressInstallModeContract = "install-from-existing-files" | "install-from-existing-files-if-needed" | "do-not-attempt-installing";
export type RuntimeWordPressDatabaseSetupContract = "runtime-managed" | "external" | "custom-drop-in";
export type RuntimeWorkerCount = number | "auto";
export interface RuntimeWordPressAssetSpec extends BackendNeutralRuntimeAssetSpec {
    wordpressDirectory?: string;
    wordpressZip?: string;
}
/** A startup-time PHP.wasm extension manifest. External extensions are JSPI-only. */
export interface RuntimePHPWasmExtensionManifest {
    manifest: string;
}
export declare const RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS: readonly ["intl", "redis", "memcached", "xdebug"];
export type RuntimePHPWasmBundledExtension = typeof RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS[number];
export interface RuntimeWordPressEnvironmentSpec extends BackendNeutralEnvironmentSpec {
    blueprint?: unknown;
    phpVersion?: string;
    workers?: RuntimeWorkerCount;
    assets?: RuntimeWordPressAssetSpec;
    wordpressInstallMode?: RuntimeWordPressInstallModeContract;
    databaseSetup?: RuntimeWordPressDatabaseSetupContract;
    extensions?: RuntimePHPWasmExtensionManifest[];
    bundledExtensions?: RuntimePHPWasmBundledExtension[];
}
export type BackendNeutralReplayStatus = "metadata-only" | "partial-replay" | "replayable-runtime-state" | "runtime-state-artifact" | "not-replayable" | (string & {});
export interface BackendNeutralReplaySpec {
    status: BackendNeutralReplayStatus;
    environment?: BackendNeutralEnvironmentSpec;
    artifactRefs?: BackendNeutralArtifactRef[];
    metadata?: Record<string, unknown>;
}
export interface BackendNeutralArtifactRef {
    path: string;
    kind: string;
    contentType?: string;
    sha256?: string;
    metadata?: Record<string, unknown>;
}
export interface BackendNeutralRuntimeProvenance {
    backend: BackendNeutralRuntimeBackendKind;
    version?: string;
    backendPackage?: Record<string, unknown>;
    environment?: BackendNeutralEnvironmentSpec;
    metadata?: Record<string, unknown>;
}
export interface RuntimeWordPressProvenance extends BackendNeutralRuntimeProvenance {
    wordpressVersion?: string;
}
export declare function normalizeBackendNeutralEnvironmentSpec(input: unknown): BackendNeutralEnvironmentSpec;
export declare function normalizeRuntimeWordPressEnvironmentSpec(input: unknown): RuntimeWordPressEnvironmentSpec;
export declare function normalizeBackendNeutralReplaySpec(input: unknown): BackendNeutralReplaySpec;
export declare function wordpressEnvironmentToBackendNeutral(input: RuntimeWordPressEnvironmentSpec): BackendNeutralEnvironmentSpec;
export declare const normalizeEnvironmentSpec: typeof normalizeRuntimeWordPressEnvironmentSpec;
//# sourceMappingURL=runtime-neutral-contracts.d.ts.map