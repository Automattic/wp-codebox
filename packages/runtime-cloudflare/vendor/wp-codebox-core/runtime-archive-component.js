export const RUNTIME_ARCHIVE_COMPONENT_SCHEMA = "wp-codebox/runtime-archive-component/v1";
export const RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA = "wp-codebox/runtime-archive-component-source/v1";
export function runtimeArchiveComponent(value) {
    if (!isRecord(value) || value.schema !== RUNTIME_ARCHIVE_COMPONENT_SCHEMA || !isSlug(value.id))
        throw new Error("Runtime archive component identity is invalid.");
    if (!isRecord(value.package) || !isSlug(value.package.profile) || !isSlug(value.package.root))
        throw new Error("Runtime archive component package is invalid.");
    if (!isRecord(value.wordpress) || !isPluginInstallPath(value.wordpress.install_path) || !isSafeFilePath(value.wordpress.bootstrap_file))
        throw new Error("Runtime archive component WordPress contract is invalid.");
    if (!isRecord(value.wordpress.load) || value.wordpress.load.mode !== "mu-plugin-loader" || !isMuPluginFilePath(value.wordpress.load.loader_path))
        throw new Error("Runtime archive component load contract is invalid.");
    if (value.wordpress.version_constant !== undefined && (typeof value.wordpress.version_constant !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value.wordpress.version_constant)))
        throw new Error("Runtime archive component version constant is invalid.");
    if (!isRecord(value.abilities) || !Object.keys(value.abilities).length || Object.entries(value.abilities).some(([alias, ability]) => !isSlug(alias) || !isAbility(ability)))
        throw new Error("Runtime archive component abilities are invalid.");
    if (!isRecord(value.limits) || !Number.isSafeInteger(value.limits.files) || Number(value.limits.files) < 1 || Number(value.limits.files) > 100_000 || !Number.isSafeInteger(value.limits.bytes) || Number(value.limits.bytes) < 1 || Number(value.limits.bytes) > 256 * 1024 * 1024)
        throw new Error("Runtime archive component limits are invalid.");
    return {
        schema: RUNTIME_ARCHIVE_COMPONENT_SCHEMA,
        id: value.id,
        package: { profile: value.package.profile, root: value.package.root },
        wordpress: {
            install_path: value.wordpress.install_path,
            bootstrap_file: value.wordpress.bootstrap_file,
            load: { mode: "mu-plugin-loader", loader_path: value.wordpress.load.loader_path },
            ...(value.wordpress.version_constant ? { version_constant: value.wordpress.version_constant } : {}),
        },
        abilities: Object.fromEntries(Object.entries(value.abilities).sort(([left], [right]) => left.localeCompare(right))),
        limits: { files: Number(value.limits.files), bytes: Number(value.limits.bytes) },
    };
}
export function runtimeArchiveComponentSource(value) {
    if (!isRecord(value) || value.schema !== RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA || !isRecord(value.source))
        throw new Error("Runtime archive component source is invalid.");
    let url;
    try {
        url = new URL(String(value.source.url));
    }
    catch {
        throw new Error("Runtime archive component source URL is invalid.");
    }
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname || !isBoundedIdentity(value.source.version) || !isBoundedIdentity(value.source.identity) || !isSha256(value.source.sha256))
        throw new Error("Runtime archive component source is invalid.");
    return {
        schema: RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA,
        source: { url: url.toString(), version: value.source.version, identity: value.source.identity, sha256: value.source.sha256 },
        component: runtimeArchiveComponent(value.component),
    };
}
export function runtimeArchiveComponentOwnedWpContentPaths(component) {
    const validated = runtimeArchiveComponent(component);
    return [`${validated.wordpress.install_path}/`, validated.wordpress.load.loader_path];
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isSlug(value) {
    return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function isAbility(value) {
    return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function isSha256(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isBoundedIdentity(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}
function isSafeFilePath(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 2_048 && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\") && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function isPluginInstallPath(value) {
    return typeof value === "string" && /^plugins\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function isMuPluginFilePath(value) {
    return isSafeFilePath(value) && /^mu-plugins\/[A-Za-z0-9._-]+\.php$/.test(value);
}
//# sourceMappingURL=runtime-archive-component.js.map