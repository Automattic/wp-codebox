import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveArtifactPath } from "./artifact-paths.js";
import { stableJson } from "./object-utils.js";
const EMPTY_SHA256 = "0".repeat(64);
export function artifactFileDigest(contents) {
    return { algorithm: "sha256", value: createHash("sha256").update(contents).digest("hex") };
}
export function artifactManifestFile(path, kind, contentType, sha256 = placeholderArtifactFileDigest(), viewerOrOptions) {
    const options = artifactManifestFileOptions(viewerOrOptions);
    return stripUndefined({ path, kind, contentType, sha256, ...options });
}
export function artifactManifestFileWithSha256(path, kind, contentType, sha256) {
    return artifactManifestFile(path, kind, contentType, { algorithm: "sha256", value: sha256 });
}
export function placeholderArtifactFileDigest() {
    return { algorithm: "sha256", value: EMPTY_SHA256 };
}
export async function calculateArtifactContentDigest(directory, inputs) {
    const hash = createHash("sha256").update("wp-codebox/artifact-content/v1\n");
    for (const [index, input] of inputs.entries()) {
        if (index > 0) {
            hash.update("\n");
        }
        hash.update(`${input}\n`);
        hash.update(await readFile(resolveArtifactPath(directory, input).absolutePath));
    }
    return hash.digest("hex");
}
export function calculateArtifactManifestFileListDigest(files) {
    return createHash("sha256")
        .update("wp-codebox/artifact-manifest-file-list/v1\n")
        .update(stableJson(files.map(({ path, kind, contentType, redaction, provenance, viewer }) => stripUndefined({ path, kind, contentType, redaction, provenance, viewer }))))
        .digest("hex");
}
export async function calculateArtifactManifestFileSha256(directory, manifest, file, manifestFileName = "manifest.json") {
    if (file.path === manifestFileName) {
        return calculateArtifactManifestSelfSha256(manifest, manifestFileName);
    }
    return artifactFileDigest(await readFile(resolveArtifactPath(directory, file.path).absolutePath)).value;
}
export function calculateArtifactManifestSelfSha256(manifest, manifestFileName = "manifest.json") {
    return createHash("sha256")
        .update("wp-codebox/artifact-manifest-self/v1\n")
        .update(stableJson(manifestWithPlaceholderSelfHash(manifest, manifestFileName)))
        .digest("hex");
}
export function upsertArtifactManifestFiles(manifest, files) {
    manifest.files = Array.isArray(manifest.files) ? manifest.files : [];
    for (const file of files) {
        const existing = manifest.files.find((entry) => entry.path === file.path);
        if (existing) {
            Object.assign(existing, file);
        }
        else {
            manifest.files.push(file);
        }
    }
}
export async function refreshArtifactManifestFileSha256s(directory, manifest, manifestFileName = "manifest.json") {
    for (const file of manifest.files) {
        if (file.path !== manifestFileName) {
            file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file, manifestFileName) };
        }
    }
    for (const file of manifest.files) {
        if (file.path === manifestFileName) {
            file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file, manifestFileName) };
        }
    }
}
function manifestWithPlaceholderSelfHash(manifest, manifestFileName) {
    return {
        ...manifest,
        files: manifest.files.map((file) => file.path === manifestFileName
            ? { ...file, sha256: placeholderArtifactFileDigest() }
            : file),
    };
}
function stripUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function artifactManifestFileOptions(viewerOrOptions) {
    if (!viewerOrOptions) {
        return {};
    }
    if ("base" in viewerOrOptions && "query" in viewerOrOptions && "replay" in viewerOrOptions) {
        return { viewer: viewerOrOptions };
    }
    return viewerOrOptions;
}
//# sourceMappingURL=artifact-manifest.js.map