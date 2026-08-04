import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { decodeZip, encodeZip } from "@php-wasm/stream-compression"
import { isWordPressRuntimeFile, isWordPressStaticAsset } from "../packages/runtime-cloudflare/src/wordpress-runtime-corpus.js"
import { WORDPRESS_RUNTIME_ARTIFACT_SCHEMA, wordpressRuntimeArtifactKey, type WordPressRuntimeArtifactManifest } from "../packages/runtime-cloudflare/src/wordpress-runtime-artifact.js"
import { WORDPRESS_STATIC_ARTIFACT_SCHEMA, validateWordPressStaticArtifactManifest, wordpressStaticArtifactKey, type WordPressStaticArtifactManifest } from "../packages/runtime-cloudflare/src/wordpress-static-artifact.js"
import { RUNTIME_ARCHIVE_ARTIFACT_SCHEMA, runtimeArchiveArtifactKey, validateRuntimeArchiveArtifactManifest, type RuntimeArchiveArtifactManifest } from "../packages/runtime-cloudflare/src/runtime-archive-artifact.js"
import { runtimeArchiveComponentSource } from "../packages/runtime-core/src/runtime-archive-component.js"
import { parseRuntimePackageManifest, selectRuntimePackageProfileFiles } from "../packages/runtime-core/src/runtime-package-profile.js"
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

const componentResponse = await fetch(websiteImporterSource.source.url)
if (!componentResponse.ok) throw new Error(`Unable to download runtime archive component ${websiteImporterSource.component.id}: ${componentResponse.status}.`)
const componentSourceArchive = new Uint8Array(await componentResponse.arrayBuffer())
if (sha256Hex(componentSourceArchive) !== websiteImporterSource.source.sha256) throw new Error(`Runtime archive component ${websiteImporterSource.component.id} does not match its pinned digest.`)
const componentSourceFiles: File[] = []
for await (const file of decodeZip(new Blob([componentSourceArchive]).stream())) if (!file.name.endsWith("/")) componentSourceFiles.push(file)
const packageManifests = componentSourceFiles.filter((file) => file.name.endsWith("/runtime-package-manifest.json"))
if (packageManifests.length !== 1) throw new Error(`Runtime archive component ${websiteImporterSource.component.id} must contain exactly one runtime package manifest.`)
const packageManifest = parseRuntimePackageManifest(await packageManifests[0].text())
if (packageManifest.package_root !== websiteImporterSource.component.package.root) throw new Error(`Runtime package profile root does not match component ${websiteImporterSource.component.id}.`)
const profile = packageManifest.profiles[websiteImporterSource.component.package.profile]
if (!profile) throw new Error(`Runtime package profile is unavailable: ${websiteImporterSource.component.package.profile}`)
for (const ability of Object.values(websiteImporterSource.component.abilities)) if (!profile.abilities.includes(ability)) throw new Error(`Runtime package profile does not declare component ability: ${ability}`)
const selections = selectRuntimePackageProfileFiles(packageManifest, websiteImporterSource.component.package.profile, componentSourceFiles.map((file) => file.name), packageManifests[0].name)
const bootstrapPath = `${websiteImporterSource.component.package.root}/${websiteImporterSource.component.wordpress.bootstrap_file}`
if (!selections.some(({ targetPath }) => targetPath === bootstrapPath)) throw new Error(`Runtime archive component ${websiteImporterSource.component.id} is missing its bootstrap file: ${bootstrapPath}`)
// Preserve the verified source ZIP byte-for-byte while validating its selected profile.
const componentArchive = componentSourceArchive
const componentSha256 = sha256Hex(componentArchive)
const componentManifest: RuntimeArchiveArtifactManifest = {
  schema: RUNTIME_ARCHIVE_ARTIFACT_SCHEMA,
  name: websiteImporterSource.component.id,
  key: runtimeArchiveArtifactKey(websiteImporterSource.component.id, componentSha256),
  archive: { sha256: componentSha256, size: componentArchive.byteLength },
  source: { url: websiteImporterSource.source.url, version: websiteImporterSource.source.version, identity: websiteImporterSource.source.identity },
  component: websiteImporterSource.component,
}
validateRuntimeArchiveArtifactManifest(componentManifest)
await writeFile(websiteImporterOutput, componentArchive)
await writeFile(websiteImporterManifestOutput, `${JSON.stringify(componentManifest, null, 2)}\n`)
console.log(JSON.stringify({
  runtime: { key: manifest.key, bytes: archive.byteLength, files: manifest.files.length, sha256: archiveSha256 },
  static: { key: staticManifest.key, bytes: staticBlob.byteLength, files: staticManifest.files.length, sha256: staticSha256 },
  sqlite: { key: sqliteManifest.key, bytes: sqliteArchive.byteLength, sha256: sqliteSha256 },
  [websiteImporterSource.component.id]: { key: componentManifest.key, bytes: componentArchive.byteLength, sha256: componentSha256 },
  source: manifest.source,
}))

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
