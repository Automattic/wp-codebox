import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { artifactManifestFile, refreshArtifactManifestFileSha256s } from "./artifact-manifest.js";
import { resolveArtifactPath, safeArtifactRelativePath } from "./artifact-paths.js";
export class ManifestedArtifactSet {
    entries = new Map();
    add(input) {
        const entry = artifactManifestFile(input.path, input.kind, input.contentType, undefined, {
            viewer: input.viewer,
            redaction: input.redaction,
            provenance: input.provenance,
        });
        this.entries.set(input.path, entry);
        return entry;
    }
    files() {
        return [...this.entries.values()];
    }
}
export class ArtifactBundleWriter {
    directory;
    manifestPath;
    artifacts = new ManifestedArtifactSet();
    constructor(directory, manifestPath = "manifest.json") {
        this.directory = directory;
        this.manifestPath = manifestPath;
    }
    path(path) {
        return resolveArtifactPath(this.directory, path).absolutePath;
    }
    relativePath(path) {
        return artifactManifestRelativePath(this.directory, path);
    }
    async write(path, contents, manifest) {
        this.artifacts.add({ path, ...manifest });
        await mkdir(dirname(this.path(path)), { recursive: true });
        await writeFile(this.path(path), contents);
    }
    async writeJson(path, value, manifest) {
        await this.write(path, artifactJson(value), {
            ...manifest,
            contentType: manifest.contentType ?? "application/json",
        });
    }
    async writeJsonLines(path, records, manifest) {
        await this.write(path, artifactJsonLines(records), {
            ...manifest,
            contentType: manifest.contentType ?? "application/x-ndjson",
        });
    }
    async writeGenerated(path, manifest, write) {
        this.artifacts.add({ path, ...manifest });
        await mkdir(dirname(this.path(path)), { recursive: true });
        await write(this.path(path));
    }
    async importFile(path, sourcePath, manifest) {
        await this.writeGenerated(path, manifest, async (destinationPath) => {
            await copyFile(sourcePath, destinationPath);
        });
    }
    async writeManifest(manifest) {
        this.artifacts.add({ path: this.manifestPath, kind: "manifest", contentType: "application/json" });
        manifest.files = this.artifacts.files();
        await writeArtifactManifestJson(this.directory, this.manifestPath, manifest);
        return manifest;
    }
}
export function artifactJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
export function artifactJsonLines(records) {
    return records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
}
export function artifactManifestRelativePath(artifactRoot, path) {
    const root = resolve(artifactRoot);
    const absolutePath = isAbsolute(path) ? resolve(path) : resolveArtifactPath(root, path).absolutePath;
    const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
        throw new Error(`Artifact path must stay inside the artifact root: ${path}`);
    }
    return safeArtifactRelativePath(relativePath);
}
export async function writeArtifactJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifactJson(value));
}
export async function writeArtifactManifestJson(directory, manifestPath, manifest) {
    await refreshArtifactManifestFileSha256s(directory, manifest, manifestPath);
    await writeArtifactJson(resolveArtifactPath(directory, manifestPath).absolutePath, manifest);
    await refreshArtifactManifestFileSha256s(directory, manifest, manifestPath);
    await writeArtifactJson(resolveArtifactPath(directory, manifestPath).absolutePath, manifest);
}
//# sourceMappingURL=artifact-layout.js.map