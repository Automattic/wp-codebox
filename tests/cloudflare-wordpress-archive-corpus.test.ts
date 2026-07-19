import assert from "node:assert/strict"
import test from "node:test"
import { decodeRemoteZip, type CentralDirectoryEntry } from "@php-wasm/stream-compression"
import { isWordPressRuntimeFile, summarizeWordPressRuntimeCorpus, type WordPressArchiveEntry } from "../packages/runtime-cloudflare/src/wordpress-runtime-corpus.js"

const WORDPRESS_ARCHIVE_URL = "https://wordpress.org/latest.zip"
const MAX_RUNTIME_CORPUS_BYTES = 32 * 1024 * 1024

test("WordPress production runtime corpus stays within the Worker materialization budget", async () => {
  const decoder = new TextDecoder()
  const entries: WordPressArchiveEntry[] = []
  const stream = await decodeRemoteZip(WORDPRESS_ARCHIVE_URL, (entry) => {
    const directoryEntry = entry as CentralDirectoryEntry
    entries.push({ path: decoder.decode(directoryEntry.path), uncompressedSize: directoryEntry.uncompressedSize, isDirectory: directoryEntry.isDirectory })
    return false
  })
  for await (const _ of stream) {
    // The predicate records central-directory metadata and selects no file ranges.
  }

  const corpus = summarizeWordPressRuntimeCorpus(entries)
  const archivePaths = new Set(entries.map((entry) => entry.path))
  const legacy = entries.filter((entry) => !entry.isDirectory && (entry.path.startsWith("wordpress/wp-admin/") || /\.(?:php|json|crt|html|css|js|mjs|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/.test(entry.path)))
  const excluded = entries.filter((entry) => !entry.isDirectory && !isWordPressRuntimeFile(entry.path, archivePaths))
  const byGroup = (files: WordPressArchiveEntry[]) => Object.entries(files.reduce<Record<string, { files: number; bytes: number }>>((groups, entry) => {
    const group = entry.path.split("/").slice(0, 3).join("/")
    const current = groups[group] ?? { files: 0, bytes: 0 }
    current.files++
    current.bytes += entry.uncompressedSize
    groups[group] = current
    return groups
  }, {})).sort(([, left], [, right]) => right.bytes - left.bytes).slice(0, 8)

  console.log(JSON.stringify({
    archiveEntries: entries.length,
    selectedFiles: corpus.selectedFiles,
    selectedBytes: corpus.selectedBytes,
    legacyFiles: legacy.length,
    legacyBytes: legacy.reduce((total, entry) => total + entry.uncompressedSize, 0),
    largestExcludedGroups: byGroup(excluded),
  }))
  assert.ok(corpus.selectedBytes <= MAX_RUNTIME_CORPUS_BYTES, `Selected ${corpus.selectedBytes} bytes exceeds the ${MAX_RUNTIME_CORPUS_BYTES}-byte runtime corpus budget.`)
})
