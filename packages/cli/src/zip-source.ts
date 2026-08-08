import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { executeManagedHostCommand } from "@automattic/wp-codebox-core"
import { allowedDownloadHosts, maxCompressionRatio, maxDownloadBytes, maxExtractedBytes, maxExtractedFileBytes, maxExtractedFilesFor, type ArchiveSourceClass } from "./source-policy.js"

export interface ZipSourceReference {
  type: string
  resolvedUrl: string
  host: string
  expectedSha256?: string
  archiveClass?: ArchiveSourceClass
}

export interface PreparedZipSource {
  root: string
  zipPath: string
  extractDirectory: string
  digest: string
}

export type RedirectSourceResolver<TSource extends ZipSourceReference> = (source: TSource, finalSourceRef: string, headers?: Headers) => TSource

export async function prepareZipSource<TSource extends ZipSourceReference>(source: TSource, slug: string, redirectSource: RedirectSourceResolver<TSource>): Promise<PreparedZipSource> {
  const root = await mkdtemp(join(tmpdir(), `wp-codebox-source-${slug}-`))
  const zipPath = join(root, "source.zip")
  const extractDirectory = join(root, "extracted")
  await mkdir(extractDirectory, { recursive: true })
  const digest = await downloadZipSource(source, zipPath, redirectSource)
  await assertSafeZipEntries(zipPath, source)
  await executeManagedHostCommand({ command: "unzip", args: ["-q", zipPath, "-d", extractDirectory], cwd: root, allowedCwdRoots: [root], label: "extract recipe source zip" })
  await assertExtractedSourceBounds(extractDirectory, source)

  return { root, zipPath, extractDirectory, digest }
}

export async function prepareLocalZipSource(sourcePath: string, slug: string, expectedSha256?: string, archiveClass: ArchiveSourceClass = "standard"): Promise<PreparedZipSource> {
  const root = await mkdtemp(join(tmpdir(), `wp-codebox-source-${slug}-`))
  const zipPath = join(root, "source.zip")
  const extractDirectory = join(root, "extracted")
  try {
    const source = await lstat(sourcePath)
    if (source.isSymbolicLink() || !source.isFile()) {
      throw new Error(`Local ZIP recipe source must be a regular file: ${sourcePath}`)
    }
    const buffer = await readFile(sourcePath)
    const digest = createHash("sha256").update(buffer).digest("hex")
    if (expectedSha256 && digest !== expectedSha256.toLowerCase()) {
      throw new Error(`Recipe source sha256 mismatch for ${sourcePath}: expected ${expectedSha256.toLowerCase()}, got ${digest}`)
    }
    await writeFile(zipPath, buffer)
    await mkdir(extractDirectory, { recursive: true })
    const archiveSource = { type: "local", resolvedUrl: sourcePath, host: "", archiveClass }
    await assertSafeZipEntries(zipPath, archiveSource)
    await executeManagedHostCommand({ command: "unzip", args: ["-q", zipPath, "-d", extractDirectory], cwd: root, allowedCwdRoots: [root], label: "extract recipe source zip" })
    await assertExtractedSourceBounds(extractDirectory, archiveSource)
    return { root, zipPath, extractDirectory, digest }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function downloadZipSource<TSource extends ZipSourceReference>(source: TSource, targetPath: string, redirectSource: RedirectSourceResolver<TSource>): Promise<string> {
  const response = await fetch(source.resolvedUrl)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download recipe source ${source.resolvedUrl}: HTTP ${response.status}`)
  }

  const finalSource = redirectSource(source, response.url || source.resolvedUrl, response.headers)

  if (finalSource.type === "local" || !allowedDownloadHosts().includes(finalSource.host)) {
    throw new Error(`Recipe source redirected to a host that is not allowed: ${finalSource.host || finalSource.resolvedUrl}`)
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0")
  if (contentLength > maxDownloadBytes()) {
    throw new Error(`Recipe source download exceeds ${maxDownloadBytes()} bytes: ${source.resolvedUrl}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxDownloadBytes()) {
    throw new Error(`Recipe source download exceeds ${maxDownloadBytes()} bytes: ${source.resolvedUrl}`)
  }

  const digest = createHash("sha256").update(buffer).digest("hex")
  if (source.expectedSha256 && digest !== source.expectedSha256.toLowerCase()) {
    throw new Error(`Recipe source sha256 mismatch for ${source.resolvedUrl}: expected ${source.expectedSha256.toLowerCase()}, got ${digest}`)
  }

  await writeFile(targetPath, buffer)
  return digest
}

async function assertSafeZipEntries(zipPath: string, source: ZipSourceReference): Promise<void> {
  const entries = zipEntries(await readFile(zipPath))
  const maxFiles = maxExtractedFilesFor(source)
  if (entries.length > maxFiles) {
    throw new Error(`Recipe source zip contains too many entries: ${entries.length}; limit ${maxFiles}; archive class ${source.archiveClass ?? "standard"}`)
  }

  for (const entry of entries) {
    const normalized = entry.name.replace(/\\/g, "/")
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`Recipe source zip contains an unsafe path: ${entry.name}`)
    }
  }

  const expandedBytes = entries.reduce((total, entry) => total + entry.uncompressedBytes, 0)
  if (expandedBytes > maxExtractedBytes()) {
    throw new Error(`Recipe source extraction exceeds ${maxExtractedBytes()} bytes: ${expandedBytes}`)
  }

  for (const { compressedBytes, uncompressedBytes } of entries) {
    if (uncompressedBytes > maxExtractedFileBytes()) {
      throw new Error(`Recipe source zip entry exceeds ${maxExtractedFileBytes()} bytes: ${uncompressedBytes}`)
    }
    if (uncompressedBytes > 0 && (compressedBytes === 0 || uncompressedBytes / compressedBytes > maxCompressionRatio())) {
      throw new Error(`Recipe source zip entry exceeds ${maxCompressionRatio()}:1 compression ratio`)
    }
  }
}

function zipEntries(data: Buffer): Array<{ name: string; compressedBytes: number; uncompressedBytes: number }> {
  const minimumEndOfCentralDirectory = 22
  const endOfCentralDirectory = findEndOfCentralDirectory(data)
  if (endOfCentralDirectory < 0 || data.length < minimumEndOfCentralDirectory) {
    throw new Error("Recipe source zip has no valid central directory")
  }

  const disk = data.readUInt16LE(endOfCentralDirectory + 4)
  const centralDirectoryDisk = data.readUInt16LE(endOfCentralDirectory + 6)
  const entriesOnDisk = data.readUInt16LE(endOfCentralDirectory + 8)
  const entryCount = data.readUInt16LE(endOfCentralDirectory + 10)
  const centralDirectoryBytes = data.readUInt32LE(endOfCentralDirectory + 12)
  let offset = data.readUInt32LE(endOfCentralDirectory + 16)
  if (disk !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralDirectoryBytes === 0xffffffff || offset === 0xffffffff) {
    throw new Error("Recipe source zip uses an unsupported central directory")
  }

  const end = offset + centralDirectoryBytes
  if (!Number.isSafeInteger(end) || end > endOfCentralDirectory) throw new Error("Recipe source zip has an invalid central directory range")

  const entries: Array<{ name: string; compressedBytes: number; uncompressedBytes: number }> = []
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw new Error("Recipe source zip has an invalid central directory entry")
    const compressedBytes = data.readUInt32LE(offset + 20)
    const uncompressedBytes = data.readUInt32LE(offset + 24)
    const nameBytes = data.readUInt16LE(offset + 28)
    const extraBytes = data.readUInt16LE(offset + 30)
    const commentBytes = data.readUInt16LE(offset + 32)
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) throw new Error("Recipe source zip uses an unsupported ZIP64 entry")
    entries.push({ name: data.toString("utf8", offset + 46, offset + 46 + nameBytes), compressedBytes, uncompressedBytes })
    offset += 46 + nameBytes + extraBytes + commentBytes
  }

  if (offset !== end) throw new Error("Recipe source zip has an invalid central directory size")
  return entries
}

function findEndOfCentralDirectory(data: Buffer): number {
  const earliest = Math.max(0, data.length - 0xffff - 22)
  for (let offset = data.length - 22; offset >= earliest; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50 && offset + 22 + data.readUInt16LE(offset + 20) === data.length) return offset
  }
  return -1
}

async function assertExtractedSourceBounds(directory: string, source: ZipSourceReference): Promise<void> {
  const totals = await directoryTotals(directory)
  const maxFiles = maxExtractedFilesFor(source)
  if (totals.files > maxFiles) {
    throw new Error(`Recipe source extraction contains too many files: ${totals.files}; limit ${maxFiles}; archive class ${source.archiveClass ?? "standard"}`)
  }
  if (totals.bytes > maxExtractedBytes()) {
    throw new Error(`Recipe source extraction exceeds ${maxExtractedBytes()} bytes: ${totals.bytes}`)
  }
}

async function directoryTotals(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const child = await directoryTotals(path)
      files += child.files
      bytes += child.bytes
    } else if (entry.isFile()) {
      const result = await stat(path)
      files += 1
      bytes += result.size
    }
  }
  return { files, bytes }
}
