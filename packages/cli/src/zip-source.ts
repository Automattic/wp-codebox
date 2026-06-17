import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { executeManagedHostCommand } from "@automattic/wp-codebox-core"
import { allowedDownloadHosts, maxDownloadBytes, maxExtractedBytes, maxExtractedFiles } from "./source-policy.js"

export interface ZipSourceReference {
  type: string
  resolvedUrl: string
  host: string
  expectedSha256?: string
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
  await assertSafeZipEntries(zipPath)
  await executeManagedHostCommand({ command: "unzip", args: ["-q", zipPath, "-d", extractDirectory], cwd: root, allowedCwdRoots: [root], label: "extract recipe source zip" })
  await assertExtractedSourceBounds(extractDirectory)

  return { root, zipPath, extractDirectory, digest }
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

async function assertSafeZipEntries(zipPath: string): Promise<void> {
  const root = dirname(zipPath)
  const { stdout } = await executeManagedHostCommand({ command: "unzip", args: ["-Z1", zipPath], cwd: root, allowedCwdRoots: [root], label: "list recipe source zip" })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length > maxExtractedFiles()) {
    throw new Error(`Recipe source zip contains too many entries: ${entries.length}`)
  }

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/")
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`Recipe source zip contains an unsafe path: ${entry}`)
    }
  }
}

async function assertExtractedSourceBounds(directory: string): Promise<void> {
  const totals = await directoryTotals(directory)
  if (totals.files > maxExtractedFiles()) {
    throw new Error(`Recipe source extraction contains too many files: ${totals.files}`)
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
