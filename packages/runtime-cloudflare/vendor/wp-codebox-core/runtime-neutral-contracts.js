export const RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS = ["intl", "redis", "memcached", "xdebug"];
export function normalizeBackendNeutralEnvironmentSpec(input) {
    const value = requireObject(input, "Runtime environment");
    const assets = normalizeBackendNeutralAssetSpec(value.assets);
    return stripUndefined({
        kind: requiredString(value.kind, "environment.kind"),
        name: optionalString(value.name, "environment.name"),
        version: optionalString(value.version, "environment.version"),
        assets,
        metadata: normalizeOptionalObject(value.metadata, "environment.metadata"),
    });
}
export function normalizeRuntimeWordPressEnvironmentSpec(input) {
    const value = requireObject(input, "Runtime environment");
    const neutral = normalizeBackendNeutralEnvironmentSpec(value);
    return stripUndefined({
        ...neutral,
        blueprint: value.blueprint,
        phpVersion: optionalString(value.phpVersion, "environment.phpVersion"),
        workers: normalizeRuntimeWorkerCount(value.workers),
        assets: normalizeRuntimeWordPressAssetSpec(value.assets),
        wordpressInstallMode: optionalString(value.wordpressInstallMode, "environment.wordpressInstallMode"),
        databaseSetup: optionalString(value.databaseSetup, "environment.databaseSetup"),
        extensions: normalizeRuntimePHPWasmExtensionManifests(value.extensions),
        bundledExtensions: normalizeRuntimePHPWasmBundledExtensions(value.bundledExtensions),
    });
}
function normalizeRuntimeWorkerCount(value) {
    if (value === undefined)
        return undefined;
    if (value === "auto")
        return value;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 64) {
        throw new Error("environment.workers must be an integer from 1 to 64 or auto.");
    }
    return value;
}
function normalizeRuntimePHPWasmExtensionManifests(input) {
    if (input === undefined)
        return undefined;
    if (!Array.isArray(input))
        throw new Error("environment.extensions must be an array.");
    return input.map((entry, index) => {
        const value = requireObject(entry, `environment.extensions[${index}]`);
        const manifest = requiredString(value.manifest, `environment.extensions[${index}].manifest`);
        if (manifest.includes("\0"))
            throw new Error(`environment.extensions[${index}].manifest must not contain a null byte.`);
        return { manifest };
    });
}
function normalizeRuntimePHPWasmBundledExtensions(input) {
    if (input === undefined)
        return undefined;
    if (!Array.isArray(input))
        throw new Error("environment.bundledExtensions must be an array.");
    return input.map((extension, index) => {
        if (!RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS.includes(extension)) {
            throw new Error(`environment.bundledExtensions[${index}] must be one of: ${RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS.join(", ")}.`);
        }
        return extension;
    });
}
export function normalizeBackendNeutralReplaySpec(input) {
    const value = requireObject(input, "Runtime replay");
    return stripUndefined({
        status: requiredString(value.status, "replay.status"),
        environment: value.environment === undefined ? undefined : normalizeBackendNeutralEnvironmentSpec(value.environment),
        artifactRefs: normalizeArtifactRefs(value.artifactRefs, "replay.artifactRefs"),
        metadata: normalizeOptionalObject(value.metadata, "replay.metadata"),
    });
}
export function wordpressEnvironmentToBackendNeutral(input) {
    return normalizeBackendNeutralEnvironmentSpec(input);
}
export const normalizeEnvironmentSpec = normalizeRuntimeWordPressEnvironmentSpec;
function normalizeRuntimeWordPressAssetSpec(input) {
    const value = normalizeBackendNeutralAssetSpec(input);
    if (input === undefined)
        return value;
    const source = requireObject(input, "environment.assets");
    return stripUndefined({
        ...value,
        wordpressDirectory: optionalString(source.wordpressDirectory, "environment.assets.wordpressDirectory"),
        wordpressZip: optionalString(source.wordpressZip, "environment.assets.wordpressZip"),
    });
}
function normalizeBackendNeutralAssetSpec(input) {
    if (input === undefined)
        return undefined;
    const value = requireObject(input, "environment.assets");
    return stripUndefined({
        directory: optionalString(value.directory, "environment.assets.directory"),
        archive: optionalString(value.archive, "environment.assets.archive"),
        metadata: normalizeOptionalObject(value.metadata, "environment.assets.metadata"),
    });
}
function normalizeArtifactRefs(input, label) {
    if (input === undefined)
        return undefined;
    if (!Array.isArray(input))
        throw new Error(`${label} must be an array.`);
    return input.map((entry, index) => normalizeArtifactRef(entry, `${label}[${index}]`));
}
function normalizeArtifactRef(input, label) {
    const value = requireObject(input, label);
    return stripUndefined({
        path: requiredString(value.path, `${label}.path`),
        kind: requiredString(value.kind, `${label}.kind`),
        contentType: optionalString(value.contentType, `${label}.contentType`),
        sha256: optionalString(value.sha256, `${label}.sha256`),
        metadata: normalizeOptionalObject(value.metadata, `${label}.metadata`),
    });
}
function normalizeOptionalObject(value, label) {
    if (value === undefined)
        return undefined;
    return requireObject(value, label);
}
function requireObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object.`);
    return value;
}
function requiredString(value, label) {
    const normalized = optionalString(value, label);
    if (!normalized)
        throw new Error(`${label} must be a non-empty string.`);
    return normalized;
}
function optionalString(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new Error(`${label} must be a string.`);
    const normalized = value.trim();
    return normalized === "" ? undefined : normalized;
}
function stripUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
//# sourceMappingURL=runtime-neutral-contracts.js.map