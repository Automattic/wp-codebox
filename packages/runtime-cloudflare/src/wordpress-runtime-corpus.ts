export interface WordPressArchiveEntry {
  path: string
  uncompressedSize: number
  isDirectory: boolean
}

const REQUIRED_RUNTIME_EXTENSION = /\.(?:php|json|crt|html)$/
const RUNTIME_FONT_OR_IMAGE_EXTENSION = /\.(?:woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/
const RUNTIME_SCRIPT_OR_STYLE_EXTENSION = /\.(?:css|js|mjs)$/

export function isWordPressRuntimeFile(path: string, archivePaths: ReadonlySet<string>): boolean {
  if (!path.startsWith("wordpress/") || path.endsWith("/") || path.endsWith(".map")) return false
  if (path.startsWith("wordpress/wp-content/themes/")) return true
  if (REQUIRED_RUNTIME_EXTENSION.test(path)) return true
  if (path.includes("/src/") || path.includes("/test/") || path.includes("/tests/") || path.includes("/node_modules/")) return false
  if (RUNTIME_FONT_OR_IMAGE_EXTENSION.test(path)) return true
  if (!RUNTIME_SCRIPT_OR_STYLE_EXTENSION.test(path)) return false
  if (path.endsWith(".mjs") || path.endsWith(".min.js") || path.endsWith(".min.css")) return true

  const minifiedSibling = path.replace(/\.(?:js|css)$/, (extension) => `.min${extension}`)
  return !archivePaths.has(minifiedSibling)
}

export function summarizeWordPressRuntimeCorpus(entries: Iterable<WordPressArchiveEntry>) {
  const entryList = Array.from(entries)
  const archivePaths = new Set(entryList.map((entry) => entry.path))
  const selected = entryList.filter((entry) => !entry.isDirectory && isWordPressRuntimeFile(entry.path, archivePaths))
  return {
    selected,
    selectedFiles: selected.length,
    selectedBytes: selected.reduce((total, entry) => total + entry.uncompressedSize, 0),
  }
}
