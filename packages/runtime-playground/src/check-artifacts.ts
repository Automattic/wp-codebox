import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { artifactManifestFile, type ArtifactManifestFile } from "@automattic/wp-codebox-core"
import type { ArtifactRedactor } from "./artifacts.js"
import type { normalizePluginCheckOutput, normalizeThemeCheckOutput } from "./commands.js"

export interface PluginCheckArtifact {
  targetPlugin: string
  files: {
    raw: string
    normalized: string
  }
  summary: ReturnType<typeof normalizePluginCheckOutput>["summary"]
}

export interface ThemeCheckArtifact {
  theme: string
  files: {
    raw: string
    normalized: string
  }
  summary: ReturnType<typeof normalizeThemeCheckOutput>["summary"]
  status: ReturnType<typeof normalizeThemeCheckOutput>["status"]
  exitCode: number
}

export async function writePluginCheckArtifacts(
  artifactRoot: string,
  pluginSlug: string,
  rawOutput: string,
  normalized: ReturnType<typeof normalizePluginCheckOutput>,
): Promise<PluginCheckArtifact> {
  const pluginCheckDirectory = join(artifactRoot, "files", "plugin-check")
  await mkdir(pluginCheckDirectory, { recursive: true })
  const safeSlug = pluginSlug.replace(/[^a-z0-9_-]/gi, "-")
  const rawPath = join(pluginCheckDirectory, `${safeSlug}.raw.json`)
  const normalizedPath = join(pluginCheckDirectory, `${safeSlug}.json`)
  await writeFile(rawPath, rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`)
  await writeFile(normalizedPath, `${JSON.stringify(normalized, null, 2)}\n`)

  return {
    targetPlugin: pluginSlug,
    files: {
      raw: relative(artifactRoot, rawPath),
      normalized: relative(artifactRoot, normalizedPath),
    },
    summary: normalized.summary,
  }
}

export async function writeThemeCheckArtifacts(
  artifactRoot: string,
  theme: string,
  raw: string,
  normalized: ReturnType<typeof normalizeThemeCheckOutput>,
): Promise<ThemeCheckArtifact> {
  const safeTheme = theme.replace(/[^a-z0-9_-]/gi, "-") || "theme"
  const directory = join(artifactRoot, "files", "theme-check")
  await mkdir(directory, { recursive: true })
  const rawPath = join(directory, `${safeTheme}.raw.txt`)
  const normalizedPath = join(directory, `${safeTheme}.normalized.json`)
  await writeFile(rawPath, raw.endsWith("\n") ? raw : `${raw}\n`)
  await writeFile(normalizedPath, `${JSON.stringify(normalized, null, 2)}\n`)

  return {
    theme,
    files: {
      raw: relative(artifactRoot, rawPath),
      normalized: relative(artifactRoot, normalizedPath),
    },
    summary: normalized.summary,
    status: normalized.status,
    exitCode: normalized.exitCode,
  }
}

export function pluginCheckManifestFiles(artifactRoot: string, pluginChecks: PluginCheckArtifact[]): ArtifactManifestFile[] {
  return pluginChecks.flatMap((check) => [
    artifactManifestFile(join(artifactRoot, check.files.raw), "plugin-check-raw", "application/json"),
    artifactManifestFile(join(artifactRoot, check.files.normalized), "plugin-check", "application/json"),
  ])
}

export function themeCheckManifestFiles(artifactRoot: string, themeChecks: ThemeCheckArtifact[]): ArtifactManifestFile[] {
  if (themeChecks.length === 0) {
    return []
  }

  const files = new Map<string, { kind: string; contentType: string }>()
  for (const check of themeChecks) {
    files.set(check.files.raw, { kind: "theme-check-raw", contentType: "text/plain" })
    files.set(check.files.normalized, { kind: "theme-check-normalized", contentType: "application/json" })
  }

  return [...files.entries()].map(([path, entry]) => artifactManifestFile(join(artifactRoot, path), entry.kind, entry.contentType))
}

export async function redactPluginCheckArtifacts(artifactRoot: string, pluginChecks: PluginCheckArtifact[], redactor: ArtifactRedactor): Promise<void> {
  for (const check of pluginChecks) {
    for (const path of [check.files.raw, check.files.normalized]) {
      const absolutePath = join(artifactRoot, path)
      try {
        await writeFile(absolutePath, redactor.redact(path, await readFile(absolutePath, "utf8")))
      } catch {
        // Plugin Check artifacts are generated before bundle collection; tolerate missing files.
      }
    }
  }
}

export async function redactThemeCheckArtifacts(artifactRoot: string, themeChecks: ThemeCheckArtifact[], redactor: ArtifactRedactor): Promise<void> {
  for (const check of themeChecks) {
    for (const path of [check.files.raw, check.files.normalized]) {
      const absolutePath = join(artifactRoot, path)
      try {
        await writeFile(absolutePath, redactor.redact(path, await readFile(absolutePath, "utf8")))
      } catch {
        // Theme Check capture is best-effort; preserve artifact collection if a file vanished.
      }
    }
  }
}
