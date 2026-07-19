import { readFile, writeFile } from "node:fs/promises"
import { decodeZip, encodeZip } from "@php-wasm/stream-compression"

const revision = "1870fb41279e7eb5946e506c9c7406f1f1ea6dc3"
const archiveUrl = `https://codeload.github.com/Automattic/markdown-database-integration/zip/${revision}`
const sourceDirectory = process.env.MDI_RUNTIME_SOURCE
const output = new URL("../packages/runtime-cloudflare/assets/markdown-database-integration-runtime.zip", import.meta.url)

const runtimePaths = new Set([
  "db.php",
  "inc/class-wp-markdown-db.php",
  "inc/class-wp-markdown-driver.php",
  "inc/class-wp-markdown-frontmatter-profiles.php",
  "inc/class-wp-markdown-loader.php",
  "inc/class-wp-markdown-primary-storage-runtime.php",
  "inc/class-wp-markdown-search.php",
  "inc/class-wp-markdown-storage.php",
  "inc/class-wp-markdown-write-engine.php",
])
const runtimeFiles = []
if (sourceDirectory) {
  for (const relative of runtimePaths) {
    runtimeFiles.push(new File([await readFile(`${sourceDirectory}/${relative}`)], relative, { lastModified: 0 }))
  }
} else {
  const response = await fetch(archiveUrl)
  if (!response.ok || !response.body) throw new Error(`Unable to fetch Markdown Database Integration: ${response.status}.`)
  for await (const entry of decodeZip(response.body)) {
    const separator = entry.name.indexOf("/")
    const relative = separator === -1 ? "" : entry.name.slice(separator + 1)
    if (!runtimePaths.has(relative)) continue
    runtimeFiles.push(new File([await entry.arrayBuffer()], relative, { lastModified: 0 }))
  }
}
if (runtimeFiles.length !== runtimePaths.size) throw new Error(`Expected ${runtimePaths.size} MDI runtime files, received ${runtimeFiles.length}.`)

runtimeFiles.sort((left, right) => left.name.localeCompare(right.name))
const archive = await new Response(encodeZip(runtimeFiles)).arrayBuffer()
await writeFile(output, new Uint8Array(archive))
console.log(`Bundled ${runtimeFiles.length} MDI runtime files from ${revision} (${archive.byteLength} bytes).`)
