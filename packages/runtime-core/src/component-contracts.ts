import { basename, join, resolve } from "node:path"
import { readdirSync, readFileSync, statSync } from "node:fs"

export type ComponentLoadMode = "plugin" | "mu-plugin"

export interface PluginEntrypointContract {
  source: string
  slug?: string
  pluginFile?: string
  loadAs?: ComponentLoadMode
}

export interface ResolvedPluginEntrypointContract {
  source: string
  slug: string
  pluginFile: string
  loadAs: ComponentLoadMode
  fallback: "explicit" | "slug" | "plugin" | "header" | "default"
}

export function resolvePluginEntrypointContract(contract: PluginEntrypointContract): ResolvedPluginEntrypointContract {
  const source = stringValue(contract.source)
  const slug = sanitizePluginSlug(stringValue(contract.slug) || basename(resolve(source || ".")))
  const loadAs = contract.loadAs === "mu-plugin" ? "mu-plugin" : "plugin"

  if (contract.pluginFile) {
    return { source, slug, pluginFile: canonicalPluginFile(slug, contract.pluginFile), loadAs, fallback: "explicit" }
  }

  for (const [name, fallback] of [[`${slug}.php`, "slug"], ["plugin.php", "plugin"]] as const) {
    if (source && isFile(join(source, name))) {
      return { source, slug, pluginFile: `${slug}/${name}`, loadAs, fallback }
    }
  }

  const headerEntry = source ? findTopLevelPluginHeaderEntry(source) : ""
  if (headerEntry) {
    return { source, slug, pluginFile: `${slug}/${headerEntry}`, loadAs, fallback: "header" }
  }

  return { source, slug, pluginFile: `${slug}/${slug}.php`, loadAs, fallback: "default" }
}

function canonicalPluginFile(slug: string, pluginFile: string): string {
  const normalized = pluginFile.trim().replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Plugin entrypoint must be a safe path inside ${slug}: ${pluginFile}`)
  }
  return normalized === slug || normalized.startsWith(`${slug}/`) ? normalized : `${slug}/${normalized}`
}

export function sanitizePluginSlug(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, "-")
}

function findTopLevelPluginHeaderEntry(source: string): string {
  let entries: string[]
  try {
    entries = readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".php"))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return ""
  }

  for (const entry of entries) {
    try {
      if (/^[\s\S]{0,8192}?Plugin Name:\s*\S/m.test(readFileSync(join(source, entry), "utf8"))) {
        return entry
      }
    } catch {
      // Unreadable file; try the next candidate.
    }
  }
  return ""
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}

export type ThemeEntrypointFile = "index.php" | "templates/index.html" | "block-templates/index.html"

export interface ThemeEntrypointContract {
  source: string
  slug?: string
}

export interface ResolvedThemeEntrypointContract {
  source: string
  slug: string
  themeName: string
  template?: string
  entrypoint: ThemeEntrypointFile
}

const THEME_ENTRYPOINT_CANDIDATES: readonly ThemeEntrypointFile[] = ["index.php", "templates/index.html", "block-templates/index.html"]

/**
 * Resolves a theme's contract from an already-materialized local directory.
 *
 * Themes have no plugin-style entrypoint header; their contract is style.css
 * carrying a Theme Name header, an optional Template header naming a parent
 * theme slug, and a block/classic template entrypoint. This must only be
 * called after a source is materialized on disk -- a remote URL cannot be
 * inspected before download, so callers resolve this after extraction, not
 * at recipe-build time.
 */
export function resolveThemeEntrypointContract(contract: ThemeEntrypointContract): ResolvedThemeEntrypointContract {
  const source = stringValue(contract.source)
  const slug = sanitizePluginSlug(stringValue(contract.slug) || basename(resolve(source || ".")))

  const styleSheetPath = join(source, "style.css")
  let styleSheet: string
  try {
    styleSheet = readFileSync(styleSheetPath, "utf8")
  } catch {
    throw new Error(`Theme is missing style.css: ${slug}`)
  }

  const themeName = themeHeaderValue(styleSheet, "Theme Name")
  if (!themeName) {
    throw new Error(`Theme style.css must declare a non-empty Theme Name header: ${slug}`)
  }

  const template = themeHeaderValue(styleSheet, "Template") || undefined
  const entrypoint = THEME_ENTRYPOINT_CANDIDATES.find((candidate) => isFile(join(source, candidate)))
  if (!entrypoint) {
    throw new Error(`Theme is missing an entrypoint (${THEME_ENTRYPOINT_CANDIDATES.join(", ")}): ${slug}`)
  }

  return { source, slug, themeName, template, entrypoint }
}

function themeHeaderValue(styleSheet: string, header: string): string {
  const match = styleSheet.slice(0, 8192).match(new RegExp(`^[ \\t/*#@]*${header}:[ \\t]*(.*)$`, "mi"))
  return match ? match[1].trim() : ""
}
