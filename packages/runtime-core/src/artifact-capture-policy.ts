import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { artifactFileDigest, artifactManifestFile, type ArtifactManifestFile, type ArtifactManifestFileOptions } from "./artifact-manifest.js"
import { resolveArtifactPath, safeArtifactRelativePath } from "./artifact-paths.js"

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
  const { relativePath, absolutePath } = resolveArtifactPath(input.root, input.path)
  const contents = typeof input.contents === "string" ? input.contents : Buffer.from(input.contents)

  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)

  const manifestFile = artifactManifestFile(relativePath, input.kind, input.contentType, artifactFileDigest(contents), {
    redaction: input.redaction,
    provenance: input.provenance,
  })

  return {
    path: relativePath,
    absolutePath,
    bytes: Buffer.byteLength(contents),
    manifestFile,
  }
}

export function normalizeArtifactPartPath(path: string): string {
  return safeArtifactRelativePath(path)
}
