import { isAbsolute, normalize, relative, sep } from "node:path";
const FILE_TREE_SKIP_POLICIES = {
    "prepared-source": [".git", "node_modules", "vendor"],
    "captured-mount": [".git", "node_modules", "target"],
};
export function normalizeRelativePath(path) {
    return normalize(path.replaceAll("\\", "/")).replaceAll("\\", "/").replace(/^\.\//, "");
}
export function normalizeRootedPath(path, root = "/") {
    const absolutePath = path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
    const normalized = normalize(absolutePath);
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
export function pathIsWithinRoot(path, root) {
    const relativePath = relative(root, path);
    return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
export function relativePathIsWithinRoot(path, root) {
    return pathIsWithinRoot(normalizeRootedPath(path), normalizeRootedPath(root));
}
export function namedFileTreeSkipPolicy(policy) {
    return new Set(FILE_TREE_SKIP_POLICIES[policy]);
}
export function namedFileTreeSkipPolicyNames(policy) {
    return [...FILE_TREE_SKIP_POLICIES[policy]];
}
export function fileTreeEntryNameSkipped(name, skipNames) {
    if (Array.isArray(skipNames)) {
        return skipNames.includes(name);
    }
    return skipNames.has(name);
}
export function relativePathExcluded(relativePath, excludePaths) {
    const normalized = normalizeRelativePath(relativePath).replace(/^\/+/, "");
    return excludePaths.some((pattern) => relativePathMatchesExcludePattern(normalized, pattern));
}
export function relativePathMatchesExcludePattern(relativePath, pattern) {
    const normalizedPattern = normalizeRelativePath(pattern).trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalizedPattern) {
        return false;
    }
    if (normalizedPattern.endsWith("/**")) {
        const prefix = normalizedPattern.slice(0, -3).replace(/\/+$/, "");
        return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
    }
    return relativePath === normalizedPattern || relativePath.startsWith(`${normalizedPattern}/`);
}
export function phpStringArrayLiteral(values) {
    return `array(${values.map((value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(", ")})`;
}
//# sourceMappingURL=file-tree-policy.js.map