import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { decodeZip, encodeZip } from "@php-wasm/stream-compression"
import { isWordPressRuntimeFile, isWordPressStaticAsset } from "../packages/runtime-cloudflare/src/wordpress-runtime-corpus.js"
import { WORDPRESS_RUNTIME_ARTIFACT_SCHEMA, wordpressRuntimeArtifactKey, type WordPressRuntimeArtifactManifest } from "../packages/runtime-cloudflare/src/wordpress-runtime-artifact.js"
import { WORDPRESS_STATIC_ARTIFACT_SCHEMA, validateWordPressStaticArtifactManifest, wordpressStaticArtifactKey, type WordPressStaticArtifactManifest } from "../packages/runtime-cloudflare/src/wordpress-static-artifact.js"
import { RUNTIME_ARCHIVE_ARTIFACT_SCHEMA, runtimeArchiveArtifactKey, validateRuntimeArchiveArtifactManifest, type RuntimeArchiveArtifactManifest } from "../packages/runtime-cloudflare/src/runtime-archive-artifact.js"
import { parseRuntimePackageManifest, selectRuntimePackageProfileFiles } from "../packages/runtime-core/src/runtime-package-profile.js"
import { runtimeArchiveComponentSource } from "../packages/runtime-core/src/runtime-archive-component.js"
import websiteImporterSourceContract from "../packages/runtime-cloudflare/components/website-importer.json" with { type: "json" }

const sourceUrl = process.env.WORDPRESS_RUNTIME_ARCHIVE_URL ?? "https://downloads.wordpress.org/release/wordpress-7.0.2.zip"
const sourceVersion = process.env.WORDPRESS_RUNTIME_VERSION ?? "7.0.2"
const output = resolve(process.env.WORDPRESS_RUNTIME_ARTIFACT_OUTPUT ?? "artifacts/cloudflare-wordpress-runtime-corpus.zip")
const manifestOutput = resolve("packages/runtime-cloudflare/assets/wordpress-runtime-artifact.json")
const staticOutput = resolve(process.env.WORDPRESS_STATIC_ARTIFACT_OUTPUT ?? "artifacts/cloudflare-wordpress-static-corpus.bin")
const staticManifestOutput = resolve("packages/runtime-cloudflare/assets/wordpress-static-artifact.json")
const sqliteSourceUrl = "https://github.com/WordPress/sqlite-database-integration/releases/download/v2.2.23/plugin-sqlite-database-integration.zip"
const sqliteOutput = resolve("artifacts/cloudflare-sqlite-database-integration.zip")
const sqliteManifestOutput = resolve("packages/runtime-cloudflare/assets/sqlite-database-integration-artifact.json")
const websiteImporterSource = runtimeArchiveComponentSource(websiteImporterSourceContract)
const websiteImporterOutput = resolve(`artifacts/cloudflare-${websiteImporterSource.component.id}.zip`)
const websiteImporterManifestOutput = resolve(`packages/runtime-cloudflare/assets/${websiteImporterSource.component.id}-artifact.json`)
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
const staticSelected = files.filter((file) => isWordPressStaticAsset(file.name)).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
if (!staticSelected.length) throw new Error("WordPress archive did not yield a static asset corpus.")
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

const staticChunks: Uint8Array[] = []
const staticFiles: WordPressStaticArtifactManifest["files"] = []
let staticOffset = 0
for (const file of staticSelected) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  staticFiles.push({ path: file.name, offset: staticOffset, size: bytes.byteLength, sha256: sha256Hex(bytes) })
  if (bytes.byteLength) staticChunks.push(bytes)
  staticOffset += bytes.byteLength
}
const staticBlob = new Uint8Array(await new Blob(staticChunks).arrayBuffer())
const staticSha256 = sha256Hex(staticBlob)
const staticManifest: WordPressStaticArtifactManifest = {
  schema: WORDPRESS_STATIC_ARTIFACT_SCHEMA,
  key: wordpressStaticArtifactKey(staticSha256),
  blob: { sha256: staticSha256, size: staticBlob.byteLength },
  source: { url: sourceUrl, version: sourceVersion, ...(identity ? { identity } : {}) },
  files: staticFiles,
}
validateWordPressStaticArtifactManifest(staticManifest)
await writeFile(staticOutput, staticBlob)
await writeFile(staticManifestOutput, `${JSON.stringify(staticManifest, null, 2)}\n`)

const sqliteResponse = await fetch(sqliteSourceUrl)
if (!sqliteResponse.ok) throw new Error(`Unable to download SQLite integration archive: ${sqliteResponse.status}.`)
const sqliteArchive = new Uint8Array(await sqliteResponse.arrayBuffer())
const sqliteSha256 = sha256Hex(sqliteArchive)
const sqliteIdentity = sqliteResponse.headers.get("etag") ?? sqliteResponse.headers.get("last-modified") ?? undefined
const sqliteManifest: RuntimeArchiveArtifactManifest = {
  schema: RUNTIME_ARCHIVE_ARTIFACT_SCHEMA,
  name: "sqlite-database-integration",
  key: runtimeArchiveArtifactKey("sqlite-database-integration", sqliteSha256),
  archive: { sha256: sqliteSha256, size: sqliteArchive.byteLength },
  source: { url: sqliteSourceUrl, version: "2.2.23", ...(sqliteIdentity ? { identity: sqliteIdentity } : {}) },
}
validateRuntimeArchiveArtifactManifest(sqliteManifest)
await writeFile(sqliteOutput, sqliteArchive)
await writeFile(sqliteManifestOutput, `${JSON.stringify(sqliteManifest, null, 2)}\n`)

const websiteImporterResponse = await fetch(websiteImporterSource.source.url)
if (!websiteImporterResponse.ok) throw new Error(`Unable to download runtime archive component ${websiteImporterSource.component.id}: ${websiteImporterResponse.status}.`)
const websiteImporterSourceArchive = new Uint8Array(await websiteImporterResponse.arrayBuffer())
if (sha256Hex(websiteImporterSourceArchive) !== websiteImporterSource.source.sha256) throw new Error(`Runtime archive component ${websiteImporterSource.component.id} does not match its pinned digest.`)
const websiteImporterSourceFiles: File[] = []
for await (const file of decodeZip(new Blob([websiteImporterSourceArchive]).stream())) {
  if (!file.name.endsWith("/")) websiteImporterSourceFiles.push(file)
}
const websiteImporterPackageManifest = websiteImporterSourceFiles.find((file) => file.name.endsWith("/runtime-package-manifest.json"))
const websiteImporterFiles = websiteImporterPackageManifest
  ? await selectProfileFiles(websiteImporterSourceFiles, websiteImporterPackageManifest, websiteImporterSource.component.package.profile)
  : selectMigrationProfileFiles(websiteImporterSourceFiles)
websiteImporterFiles.sort((left, right) => left.name.localeCompare(right.name))
const bootstrapPath = `${websiteImporterSource.component.package.root}/${websiteImporterSource.component.wordpress.bootstrap_file}`
if (!websiteImporterFiles.some((file) => file.name === bootstrapPath)) throw new Error(`Runtime archive component ${websiteImporterSource.component.id} is missing its bootstrap file: ${bootstrapPath}`)
const websiteImporterArchive = new Uint8Array(await new Response(encodeZip(websiteImporterFiles)).arrayBuffer())
const websiteImporterSha256 = sha256Hex(websiteImporterArchive)
const websiteImporterManifest: RuntimeArchiveArtifactManifest = {
  schema: RUNTIME_ARCHIVE_ARTIFACT_SCHEMA,
  name: websiteImporterSource.component.id,
  key: runtimeArchiveArtifactKey(websiteImporterSource.component.id, websiteImporterSha256),
  archive: { sha256: websiteImporterSha256, size: websiteImporterArchive.byteLength },
  source: { url: websiteImporterSource.source.url, ...(websiteImporterSource.source.version ? { version: websiteImporterSource.source.version } : {}), ...(websiteImporterSource.source.identity ? { identity: websiteImporterSource.source.identity } : {}) },
  component: websiteImporterSource.component,
}
validateRuntimeArchiveArtifactManifest(websiteImporterManifest)
await writeFile(websiteImporterOutput, websiteImporterArchive)
await writeFile(websiteImporterManifestOutput, `${JSON.stringify(websiteImporterManifest, null, 2)}\n`)
console.log(JSON.stringify({
  runtime: { key: manifest.key, bytes: archive.byteLength, files: manifest.files.length, sha256: archiveSha256 },
  static: { key: staticManifest.key, bytes: staticBlob.byteLength, files: staticManifest.files.length, sha256: staticSha256 },
  sqlite: { key: sqliteManifest.key, bytes: sqliteArchive.byteLength, sha256: sqliteSha256 },
  [websiteImporterSource.component.id]: { key: websiteImporterManifest.key, bytes: websiteImporterArchive.byteLength, sha256: websiteImporterSha256 },
  source: manifest.source,
}))

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function selectProfileFiles(files: File[], manifestFile: File, profile: string): Promise<File[]> {
  const manifest = parseRuntimePackageManifest(await manifestFile.text())
  if (manifest.package_root !== websiteImporterSource.component.package.root) throw new Error(`Runtime package profile root does not match component ${websiteImporterSource.component.id}.`)
  return materializeSelectedFiles(files, selectRuntimePackageProfileFiles(manifest, profile, files.map((file) => file.name), manifestFile.name))
}

function selectMigrationProfileFiles(files: File[]): File[] {
  const migration = websiteImporterSource.migration
  if (!migration || migration.source_sha256 !== websiteImporterSource.source.sha256) throw new Error(`Runtime archive component ${websiteImporterSource.component.id} does not declare package profile ${websiteImporterSource.component.package.profile}.`)
  const root = `${websiteImporterSource.component.package.root}/`
  const manifestPath = `${root}runtime-package-manifest.json`
  const syntheticManifest = parseRuntimePackageManifest(JSON.stringify({
    schema: `${websiteImporterSource.component.id}/runtime-package-manifest/v1`,
    package: websiteImporterSource.component.id,
    package_root: websiteImporterSource.component.package.root,
    profiles: {
      [websiteImporterSource.component.package.profile]: {
        abilities: Object.values(websiteImporterSource.component.abilities),
        selectors: migration.selectors,
        required_files: migration.required_files,
      },
    },
  }))
  return materializeSelectedFiles(files, selectRuntimePackageProfileFiles(syntheticManifest, websiteImporterSource.component.package.profile, files.map((file) => file.name), manifestPath))
}

function materializeSelectedFiles(files: File[], selected: Array<{ sourcePath: string; targetPath: string }>): File[] {
  const filesByPath = new Map(files.map((file) => [file.name, file]))
  return selected.map(({ sourcePath, targetPath }) => {
    const file = filesByPath.get(sourcePath)
    if (!file) throw new Error(`Runtime package profile selected an unavailable archive file: ${sourcePath}`)
    return new File([file], targetPath, { lastModified: 0 })
  })
}
