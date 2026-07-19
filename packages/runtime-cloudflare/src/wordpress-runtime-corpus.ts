export interface WordPressArchiveEntry {
  path: string
  uncompressedSize: number
  isDirectory: boolean
}

const SERVER_READ_EXTENSION = /\.(?:php|json|crt|html)$/
const STATIC_ASSET_EXTENSION = /\.(?:css|js|mjs|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/
const STATIC_ARCHIVE_ROOTS = ["wp-admin/", "wp-includes/", "wp-content/themes/"]
const SERVER_READ_ASSET_PATHS = new Set([
  // wp-includes/view-transitions.php in current WordPress reads this at bootstrap.
  "wordpress/wp-admin/css/view-transitions.min.css",
  // wp-includes/formatting.php inlines this loader into generated pages.
  "wordpress/wp-includes/js/wp-emoji-loader.min.js",
  // wp-admin/includes/dashboard.php inlines this background into dashboard markup.
  "wordpress/wp-admin/images/dashboard-background.svg",
])

export function isWordPressRuntimeFile(path: string, _archivePaths: ReadonlySet<string>): boolean {
  if (!path.startsWith("wordpress/") || path.endsWith("/") || path.endsWith(".map")) return false
  // PHP discovers all executable code and structured metadata server-side. Browser
  // assets stay in the archive and are fetched directly by the entry Worker.
  return SERVER_READ_EXTENSION.test(path) || path.endsWith("/style.css") || SERVER_READ_ASSET_PATHS.has(path)
}

export function wordpressStaticArchivePath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..")) return null
  const relative = decoded.slice(1)
  if (!STATIC_ARCHIVE_ROOTS.some((root) => relative.startsWith(root)) || !STATIC_ASSET_EXTENSION.test(relative)) return null
  return `wordpress/${relative}`
}

export function wordpressStaticContentType(archivePath: string): string {
  const extension = archivePath.slice(archivePath.lastIndexOf(".") + 1).toLowerCase()
  return ({
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
  }[extension] ?? "application/octet-stream")
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
