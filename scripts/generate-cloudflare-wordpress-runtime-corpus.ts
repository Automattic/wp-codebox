import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { decodeZip, encodeZip } from "@php-wasm/stream-compression"
import { isWordPressRuntimeFile } from "../packages/runtime-cloudflare/src/wordpress-runtime-corpus.js"
import { WORDPRESS_RUNTIME_ARTIFACT_SCHEMA, wordpressRuntimeArtifactKey, type WordPressRuntimeArtifactManifest } from "../packages/runtime-cloudflare/src/wordpress-runtime-artifact.js"

const sourceUrl = process.env.WORDPRESS_RUNTIME_ARCHIVE_URL ?? "https://downloads.wordpress.org/release/wordpress-7.0.2.zip"
const sourceVersion = process.env.WORDPRESS_RUNTIME_VERSION ?? "7.0.2"
const output = resolve(process.env.WORDPRESS_RUNTIME_ARTIFACT_OUTPUT ?? "artifacts/cloudflare-wordpress-runtime-corpus.zip")
const manifestOutput = resolve("packages/runtime-cloudflare/assets/wordpress-runtime-artifact.json")
const response = await fetch(sourceUrl)
if (!response.ok || !response.body) throw new Error(`Unable to download WordPress archive: ${response.status}.`)
const identity = response.headers.get("etag") ?? response.headers.get("last-modified") ?? undefined
const files: File[] = []
for await (const file of decodeZip(response.body)) files.push(file)
const archivePaths = new Set(files.map((file) => file.name))
const selected = files
  .filter((file) => isWordPressRuntimeFile(file.name, archivePaths))
  .map((file) => new File([file], file.name, { lastModified: 0 }))
selected.sort((left, right) => left.name.localeCompare(right.name))
if (!selected.length) throw new Error("WordPress archive did not yield a runtime corpus.")
const archive = new Uint8Array(await new Response(encodeZip(selected)).arrayBuffer())
const archiveSha256 = sha256Hex(archive)
const manifest: WordPressRuntimeArtifactManifest = {
  schema: WORDPRESS_RUNTIME_ARTIFACT_SCHEMA,
  key: wordpressRuntimeArtifactKey(archiveSha256),
  archive: { sha256: archiveSha256, size: archive.byteLength },
  source: { url: sourceUrl, version: sourceVersion, ...(identity ? { identity } : {}) },
  files: await Promise.all(selected.map(async (file) => ({ path: file.name, size: file.size, sha256: sha256Hex(new Uint8Array(await file.arrayBuffer())) }))),
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, archive)
await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ key: manifest.key, archiveBytes: archive.byteLength, files: manifest.files.length, sha256: archiveSha256, source: manifest.source }))

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
