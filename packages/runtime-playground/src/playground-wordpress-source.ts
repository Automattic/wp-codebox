import { randomUUID } from "node:crypto"
import { existsSync, openAsBlob } from "node:fs"
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { decodeZip } from "@php-wasm/stream-compression"
import { resolvePlaygroundWordPressStartupAsset } from "./playground-cli-runner.js"
import { playgroundWordPressArchiveCacheDirectory } from "./playground-wordpress-archive-cache.js"

export const WORDPRESS_SOURCE_SCHEMA = "wp-codebox/wordpress-source/v1"

/**
 * WordPress core source materialized on the host from the same validated
 * archive cache WP Codebox uses to boot Playground.
 */
export interface PlaygroundWordPressSource {
  schema: typeof WORDPRESS_SOURCE_SCHEMA
  version: string
  /** Absolute directory containing `wp-includes/version.php`. */
  root: string
  /** Absolute path of the validated cached `${version}.zip` archive. */
  archive: string
  sourceUrl: string
}

export interface PlaygroundWordPressSourceOptions {
  cacheDirectory?: string
  /** Receives human-readable progress diagnostics. */
  log?: (message: string) => void
}

/**
 * Resolves a WordPress version query, ensures the validated cached archive,
 * and extracts it once to `<cache>/source/<version>/wordpress`.
 *
 * Extraction is staged in a sibling directory, verified against
 * `wp-includes/version.php`, and renamed into place, so concurrent callers
 * only ever observe a complete, verified tree.
 */
export async function materializePlaygroundWordPressSource(versionQuery: string | undefined, options: PlaygroundWordPressSourceOptions = {}): Promise<PlaygroundWordPressSource> {
  const cacheDirectory = resolve(options.cacheDirectory ?? playgroundWordPressArchiveCacheDirectory())
  const log = options.log ?? (() => undefined)
  assertReleaseVersionQuery(versionQuery)

  const asset = await resolvePlaygroundWordPressStartupAsset(versionQuery, undefined, cacheDirectory)
  await asset.archiveReference?.release()
  const version = asset.cacheValidation.version
  const archive = asset.localPath
  if (!archive) {
    throw new Error(`WordPress ${version} archive was not cached locally from ${asset.cacheValidation.sourceUrl}`)
  }

  const source = { schema: WORDPRESS_SOURCE_SCHEMA, version, archive: resolve(archive), sourceUrl: asset.cacheValidation.sourceUrl } as const
  const versionDirectory = playgroundWordPressSourceDirectory(cacheDirectory, version)
  const root = join(versionDirectory, "wordpress")

  if (await verifiedWordPressRootError(root, version) === undefined) {
    log(`Reusing WordPress ${version} source at ${root}`)
    return { ...source, root }
  }

  log(`Extracting WordPress ${version} source from ${source.archive}`)
  const stagingDirectory = join(dirname(versionDirectory), `.${version}.${process.pid}.${randomUUID()}.partial`)
  try {
    await mkdir(stagingDirectory, { recursive: true })
    await stageWordPressSource(source.archive, stagingDirectory, version)
    await publishStagedSource(stagingDirectory, versionDirectory, version)
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }

  const error = await verifiedWordPressRootError(root, version)
  if (error) {
    throw new Error(`WordPress ${version} source at ${root} failed verification: ${error}`)
  }
  log(`Materialized WordPress ${version} source at ${root}`)
  return { ...source, root }
}

export function playgroundWordPressSourceDirectory(cacheDirectory: string, version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
    throw new Error(`Refusing to materialize WordPress source for unsafe version identifier: ${version}`)
  }
  return join(resolve(cacheDirectory), "source", version)
}

/** Returns undefined when `root/wp-includes/version.php` declares `version`, otherwise the reason it does not. */
export async function verifiedWordPressRootError(root: string, version: string): Promise<string | undefined> {
  let contents: string
  try {
    contents = await readFile(join(root, "wp-includes", "version.php"), "utf8")
  } catch {
    return "wp-includes/version.php is missing"
  }
  const declared = /^\$wp_version\s*=\s*['"]([^'"]+)['"]\s*;/m.exec(contents)?.[1]
  if (!declared) {
    return "wp-includes/version.php does not declare $wp_version"
  }
  return declared === version ? undefined : `wp-includes/version.php declares $wp_version '${declared}', expected '${version}'`
}

function assertReleaseVersionQuery(versionQuery: string | undefined): void {
  if (versionQuery && (/^(trunk|nightly)$/i.test(versionQuery) || /^https?:\/\//i.test(versionQuery))) {
    throw new Error(`wordpress-source requires a WordPress release version or "latest"; received "${versionQuery}"`)
  }
}

async function stageWordPressSource(archive: string, stagingDirectory: string, version: string): Promise<void> {
  const extracted = join(stagingDirectory, "extracted")
  await extractZip(archive, extracted)
  const wordpressRoot = await locateWordPressRoot(extracted)
  if (!wordpressRoot) {
    throw new Error(`WordPress archive ${archive} does not contain wp-includes/version.php`)
  }
  const staged = join(stagingDirectory, "wordpress")
  await rename(wordpressRoot, staged)
  await rm(extracted, { recursive: true, force: true })
  const error = await verifiedWordPressRootError(staged, version)
  if (error) {
    throw new Error(`WordPress archive ${archive} failed verification: ${error}`)
  }
}

async function publishStagedSource(stagingDirectory: string, versionDirectory: string, version: string): Promise<void> {
  await mkdir(dirname(versionDirectory), { recursive: true })
  try {
    await rename(stagingDirectory, versionDirectory)
    return
  } catch (error) {
    if (!isDestinationOccupied(error)) {
      throw error
    }
  }

  // Another caller published first; reuse its tree when it verifies.
  if (await verifiedWordPressRootError(join(versionDirectory, "wordpress"), version) === undefined) {
    return
  }

  // Replace an unverifiable tree by moving it aside first, so the final path
  // only ever transitions between complete trees.
  const discarded = `${stagingDirectory}.discarded`
  await rename(versionDirectory, discarded)
  try {
    await rename(stagingDirectory, versionDirectory)
  } finally {
    await rm(discarded, { recursive: true, force: true })
  }
}

async function extractZip(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const blob = await openAsBlob(archive)
  for await (const entry of decodeZip(blob.stream() as ReadableStream<Uint8Array>)) {
    const target = safeEntryPath(destination, entry.name)
    if (entry.name.endsWith("/")) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, new Uint8Array(await entry.arrayBuffer()), { flag: "wx" })
  }
}

function safeEntryPath(destination: string, name: string): string {
  const target = resolve(destination, name)
  if (!name || isAbsolute(name) || name.includes("\\") || name.split("/").includes("..") || (target !== destination && !target.startsWith(`${destination}${sep}`))) {
    throw new Error(`WordPress archive contains an unsafe entry path: ${name}`)
  }
  return target
}

async function locateWordPressRoot(extracted: string): Promise<string | undefined> {
  if (existsSync(join(extracted, "wp-includes", "version.php"))) {
    return extracted
  }
  const children = await readdir(extracted)
  if (children.length !== 1) {
    return undefined
  }
  const child = join(extracted, children[0])
  const childStat = await lstat(child)
  return childStat.isDirectory() && existsSync(join(child, "wp-includes", "version.php")) ? child : undefined
}

function isDestinationOccupied(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOTEMPTY" || error.code === "EEXIST"))
}
