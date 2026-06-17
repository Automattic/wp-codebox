import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { artifactFileDigest, artifactManifestFile, type ArtifactManifestFile, type ArtifactManifestFileOptions } from "./artifact-manifest.js"

export interface ArtifactPartInput {
  root: string
  path: string
  kind: ArtifactManifestFile["kind"]
  contentType: string
  contents: string | Buffer
  redaction?: ArtifactManifestFileOptions["redaction"]
  provenance?: ArtifactManifestFileOptions["provenance"]
}

export interface ArtifactPart {
  path: string
  absolutePath: string
  bytes: number
  manifestFile: ArtifactManifestFile
}

export async function writeArtifactPart(input: ArtifactPartInput): Promise<ArtifactPart> {
  const relativePath = normalizeArtifactPartPath(input.path)
  const contents = typeof input.contents === "string" ? input.contents : Buffer.from(input.contents)
  const absolutePath = join(input.root, relativePath)

  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)

  const manifestFile = artifactManifestFile(absolutePath, input.kind, input.contentType, artifactFileDigest(contents), {
    redaction: input.redaction,
    provenance: input.provenance,
  })

  return {
    path: relative(input.root, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    bytes: Buffer.byteLength(contents),
    manifestFile,
  }
}

export function normalizeArtifactPartPath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Artifact part path must be a relative path without current-directory or parent-directory segments")
  }
  return segments.join("/")
}
