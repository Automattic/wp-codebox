import assert from "node:assert/strict"
import test from "node:test"
import { decodeZip } from "@php-wasm/stream-compression"
import { isWordPressRuntimeFile, isWordPressStaticAsset, summarizeWordPressRuntimeCorpus, type WordPressArchiveEntry } from "../src/wordpress-runtime-corpus.js"
import { WORDPRESS_RUNTIME_MAX_FILES, WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES } from "../src/wordpress-runtime-artifact.js"
import { WORDPRESS_STATIC_MAX_BYTES, WORDPRESS_STATIC_MAX_FILES } from "../src/wordpress-static-artifact.js"

const WORDPRESS_ARCHIVE_URL = "https://wordpress.org/latest.zip"

test("WordPress production runtime corpus stays within the Worker materialization budget", async () => {
  const entries: WordPressArchiveEntry[] = []
  const response = await fetch(WORDPRESS_ARCHIVE_URL)
  assert.equal(response.ok, true, `WordPress archive returned HTTP ${response.status}.`)
  assert.ok(response.body, "WordPress archive response has no body.")
  for await (const file of decodeZip(response.body)) {
    entries.push({ path: file.name, uncompressedSize: file.size, isDirectory: file.name.endsWith("/") })
  }

  const corpus = summarizeWordPressRuntimeCorpus(entries)
  const archivePaths = new Set(entries.map((entry) => entry.path))
  const legacy = entries.filter((entry) => !entry.isDirectory && (entry.path.startsWith("wordpress/wp-admin/") || /\.(?:php|json|crt|html|css|js|mjs|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/.test(entry.path)))
  const excluded = entries.filter((entry) => !entry.isDirectory && !isWordPressRuntimeFile(entry.path, archivePaths))
  const staticAssets = entries.filter((entry) => !entry.isDirectory && isWordPressStaticAsset(entry.path))
  const staticBytes = staticAssets.reduce((total, entry) => total + entry.uncompressedSize, 0)
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
    staticFiles: staticAssets.length,
    staticBytes,
    legacyFiles: legacy.length,
    legacyBytes: legacy.reduce((total, entry) => total + entry.uncompressedSize, 0),
    largestExcludedGroups: byGroup(excluded),
  }))
  assert.ok(entries.some((entry) => entry.path === "wordpress/wp-includes/version.php"), "Archive is missing wp-includes/version.php.")
  assert.ok(corpus.selectedFiles > 0, "WordPress archive did not yield a runtime corpus.")
  assert.ok(corpus.selectedFiles <= WORDPRESS_RUNTIME_MAX_FILES, `Selected ${corpus.selectedFiles} files exceeds the ${WORDPRESS_RUNTIME_MAX_FILES}-file runtime corpus budget.`)
  assert.ok(corpus.selectedBytes <= WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES, `Selected ${corpus.selectedBytes} bytes exceeds the ${WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES}-byte runtime corpus budget.`)
  assert.ok(staticAssets.length > 0 && staticAssets.length <= WORDPRESS_STATIC_MAX_FILES, `Selected ${staticAssets.length} static files exceeds the ${WORDPRESS_STATIC_MAX_FILES}-file budget.`)
  assert.ok(staticBytes <= WORDPRESS_STATIC_MAX_BYTES, `Selected ${staticBytes} static bytes exceeds the ${WORDPRESS_STATIC_MAX_BYTES}-byte budget.`)
})
