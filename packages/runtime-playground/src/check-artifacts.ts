import { join } from "node:path"
import { writeArtifactPart, type ArtifactManifestFile } from "@automattic/wp-codebox-core"
import { redactArtifactFiles } from "./artifact-bundle-writer.js"
import type { ArtifactRedactor } from "./artifacts.js"
import type { normalizePluginCheckOutput, normalizeThemeCheckOutput } from "./commands.js"

export interface PluginCheckArtifact {
  targetPlugin: string
  files: {
    raw: string
    normalized: string
  }
  manifestFiles: ArtifactManifestFile[]
  summary: ReturnType<typeof normalizePluginCheckOutput>["summary"]
}

export interface ThemeCheckArtifact {
  theme: string
  files: {
    raw: string
    normalized: string
  }
  manifestFiles: ArtifactManifestFile[]
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
  const safeSlug = pluginSlug.replace(/[^a-z0-9_-]/gi, "-")
  const raw = await writeArtifactPart({
    root: artifactRoot,
    path: join("files", "plugin-check", `${safeSlug}.raw.json`),
    kind: "plugin-check-raw",
    contentType: "application/json",
    contents: rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`,
    redaction: { policy: "required", sensitive: true, reason: "Plugin check raw output may include local paths or captured diagnostics." },
    provenance: { source: "runtime-playground", operation: "plugin-check", id: pluginSlug },
  })
  const normalizedArtifact = await writeArtifactPart({
    root: artifactRoot,
    path: join("files", "plugin-check", `${safeSlug}.json`),
    kind: "plugin-check",
    contentType: "application/json",
    contents: `${JSON.stringify(normalized, null, 2)}\n`,
    redaction: { policy: "required", sensitive: true, reason: "Plugin check normalized output may include local paths or captured diagnostics." },
    provenance: { source: "runtime-playground", operation: "plugin-check", id: pluginSlug },
  })

  return {
    targetPlugin: pluginSlug,
    files: {
      raw: raw.path,
      normalized: normalizedArtifact.path,
    },
    manifestFiles: [raw.manifestFile, normalizedArtifact.manifestFile],
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
  const rawArtifact = await writeArtifactPart({
    root: artifactRoot,
    path: join("files", "theme-check", `${safeTheme}.raw.txt`),
    kind: "theme-check-raw",
    contentType: "text/plain",
    contents: raw.endsWith("\n") ? raw : `${raw}\n`,
    redaction: { policy: "required", sensitive: true, reason: "Theme check raw output may include local paths or captured diagnostics." },
    provenance: { source: "runtime-playground", operation: "theme-check", id: theme },
  })
  const normalizedArtifact = await writeArtifactPart({
    root: artifactRoot,
    path: join("files", "theme-check", `${safeTheme}.normalized.json`),
    kind: "theme-check-normalized",
    contentType: "application/json",
    contents: `${JSON.stringify(normalized, null, 2)}\n`,
    redaction: { policy: "required", sensitive: true, reason: "Theme check normalized output may include local paths or captured diagnostics." },
    provenance: { source: "runtime-playground", operation: "theme-check", id: theme },
  })

  return {
    theme,
    files: {
      raw: rawArtifact.path,
      normalized: normalizedArtifact.path,
    },
    manifestFiles: [rawArtifact.manifestFile, normalizedArtifact.manifestFile],
    summary: normalized.summary,
    status: normalized.status,
    exitCode: normalized.exitCode,
  }
}

export function pluginCheckManifestFiles(_artifactRoot: string, pluginChecks: PluginCheckArtifact[]): ArtifactManifestFile[] {
  return pluginChecks.flatMap((check) => check.manifestFiles)
}

export function themeCheckManifestFiles(_artifactRoot: string, themeChecks: ThemeCheckArtifact[]): ArtifactManifestFile[] {
  return themeChecks.flatMap((check) => check.manifestFiles)
}

export async function redactPluginCheckArtifacts(artifactRoot: string, pluginChecks: PluginCheckArtifact[], redactor: ArtifactRedactor): Promise<void> {
  for (const check of pluginChecks) {
    await redactArtifactFiles(artifactRoot, [check.files.raw, check.files.normalized], redactor)
  }
}

export async function redactThemeCheckArtifacts(artifactRoot: string, themeChecks: ThemeCheckArtifact[], redactor: ArtifactRedactor): Promise<void> {
  for (const check of themeChecks) {
    await redactArtifactFiles(artifactRoot, [check.files.raw, check.files.normalized], redactor)
  }
}
