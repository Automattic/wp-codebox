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
