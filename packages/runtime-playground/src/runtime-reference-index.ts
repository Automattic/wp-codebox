import { readFile } from "node:fs/promises"
import { dirname, extname, join, posix } from "node:path"
import type { ArtifactManifestFile } from "@automattic/wp-codebox-core"
import type { BrowserProbeArtifact } from "./browser-artifacts.js"
import type { CapturedMountFiles } from "./artifacts.js"

export interface RuntimeReferenceIndex {
  schema: "wp-codebox/runtime-reference-index/v1"
  version: 1
  createdAt: string
  summary: {
    filesScanned: number
    references: number
    present: number
    missing: number
    entrypoints: number
  }
  entrypoints: RuntimeReferenceIndexEntrypoint[]
  references: RuntimeReferenceIndexReference[]
  present: RuntimeReferenceIndexReference[]
  missing: RuntimeReferenceIndexReference[]
}

export interface RuntimeReferenceIndexEntrypoint {
  path: string
  kind: "html" | "markdown"
  reason: string
  runtimePath?: string
  url?: string
}

export interface RuntimeReferenceIndexReference {
  source: {
    path: string
    kind: "html" | "css" | "markdown"
    runtimePath?: string
    url?: string
  }
  target: {
    raw: string
    path: string
    present: boolean
    artifactPath?: string
    runtimePath?: string
  }
  kind: string
  context?: string
}

interface RuntimeReferenceIndexInput {
  artifactRoot: string
  createdAt: string
  manifestFiles: ArtifactManifestFile[]
  capturedMounts: CapturedMountFiles
  browserProbes: BrowserProbeArtifact[]
}

interface ScannableArtifactFile {
  path: string
  kind: "html" | "css" | "markdown"
  runtimePath?: string
  url?: string
}

interface ReferenceCandidate {
  raw: string
  kind: string
  context?: string
}

const LOCAL_REFERENCE_EXTENSIONS = new Set([".html", ".htm", ".css", ".md", ".markdown"])
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"])

export async function buildRuntimeReferenceIndex({ artifactRoot, createdAt, manifestFiles, capturedMounts, browserProbes }: RuntimeReferenceIndexInput): Promise<RuntimeReferenceIndex> {
  const artifactPaths = new Set(manifestFiles.map((file) => normalizeArtifactPath(file.path)))
  const capturedByArtifactPath = new Map(capturedMounts.files.map((file) => [normalizeArtifactPath(file.artifactPath), file]))
  const capturedByRuntimePath = new Map(capturedMounts.files.map((file) => [normalizeRuntimePath(file.target), file]))
  const browserHtmlByPath = new Map<string, BrowserProbeArtifact>()
  for (const probe of browserProbes) {
    if (probe.files.html) {
      browserHtmlByPath.set(normalizeArtifactPath(probe.files.html), probe)
    }
  }

  const scannableFiles = manifestFiles
    .map((file) => scannableArtifactFile(file, capturedByArtifactPath, browserHtmlByPath))
    .filter((file): file is ScannableArtifactFile => Boolean(file))
    .sort((left, right) => left.path.localeCompare(right.path))
  const references: RuntimeReferenceIndexReference[] = []

  for (const file of scannableFiles) {
    const contents = await readFile(join(artifactRoot, file.path), "utf8")
    for (const candidate of referencesInContents(file.kind, contents)) {
      const target = resolveReferenceTarget(candidate.raw, file, artifactPaths, capturedByRuntimePath)
      if (target) {
        references.push({
          source: compactSource(file),
          target,
          kind: candidate.kind,
          ...(candidate.context ? { context: candidate.context } : {}),
        })
      }
    }
  }

  references.sort((left, right) => `${left.source.path}\0${left.target.raw}\0${left.kind}`.localeCompare(`${right.source.path}\0${right.target.raw}\0${right.kind}`))
  const present = references.filter((reference) => reference.target.present)
  const missing = references.filter((reference) => !reference.target.present)
  const entrypoints = entrypointsForFiles(scannableFiles)

  return {
    schema: "wp-codebox/runtime-reference-index/v1",
    version: 1,
    createdAt,
    summary: {
      filesScanned: scannableFiles.length,
      references: references.length,
      present: present.length,
      missing: missing.length,
      entrypoints: entrypoints.length,
    },
    entrypoints,
    references,
    present,
    missing,
  }
}

function scannableArtifactFile(file: ArtifactManifestFile, capturedByArtifactPath: Map<string, CapturedMountFiles["files"][number]>, browserHtmlByPath: Map<string, BrowserProbeArtifact>): ScannableArtifactFile | undefined {
  const path = normalizeArtifactPath(file.path)
  const extension = extname(path).toLowerCase()
  if (!LOCAL_REFERENCE_EXTENSIONS.has(extension)) {
    return undefined
  }

  const captured = capturedByArtifactPath.get(path)
  const browserProbe = browserHtmlByPath.get(path)
  return {
    path,
    kind: extension === ".css" ? "css" : MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : "html",
    ...(captured ? { runtimePath: normalizeRuntimePath(captured.target) } : {}),
    ...(browserProbe ? { url: browserProbe.summary.finalUrl } : {}),
  }
}

function referencesInContents(kind: ScannableArtifactFile["kind"], contents: string): ReferenceCandidate[] {
  if (kind === "css") {
    return cssReferences(contents)
  }
  if (kind === "markdown") {
    return markdownReferences(contents)
  }

  return htmlReferences(contents)
}

function htmlReferences(contents: string): ReferenceCandidate[] {
  const references: ReferenceCandidate[] = []
  const attributePattern = /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
  for (const match of contents.matchAll(attributePattern)) {
    const attribute = match[1]?.toLowerCase()
    const value = match[3] ?? match[4] ?? match[5] ?? ""
    if (attribute && value) {
      references.push({ raw: value, kind: htmlReferenceKind(attribute, value), context: attribute })
    }
  }

  const srcsetPattern = /\b(srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^>]+))/gi
  for (const match of contents.matchAll(srcsetPattern)) {
    const value = match[3] ?? match[4] ?? match[5] ?? ""
    for (const item of srcsetReferences(value)) {
      references.push({ raw: item, kind: "srcset", context: "srcset" })
    }
  }

  return references
}

function htmlReferenceKind(attribute: string, value: string): string {
  if (attribute === "href" && /\.css(?:[?#].*)?$/i.test(value)) {
    return "stylesheet"
  }
  if (attribute === "poster") {
    return "media-poster"
  }
  return attribute
}

function cssReferences(contents: string): ReferenceCandidate[] {
  const references: ReferenceCandidate[] = []
  const pattern = /url\(\s*("([^"]*)"|'([^']*)'|([^)'\s][^)]*?))\s*\)/gi
  for (const match of contents.matchAll(pattern)) {
    const value = match[2] ?? match[3] ?? match[4] ?? ""
    if (value) {
      references.push({ raw: value.trim(), kind: "css-url", context: "url()" })
    }
  }

  return references
}

function markdownReferences(contents: string): ReferenceCandidate[] {
  const references: ReferenceCandidate[] = []
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of contents.matchAll(imagePattern)) {
    const value = match[1] ?? ""
    if (value) {
      references.push({ raw: value, kind: "markdown-image", context: "image" })
    }
  }

  return references
}

function srcsetReferences(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0])
    .filter((item) => item.length > 0)
}

function resolveReferenceTarget(raw: string, source: ScannableArtifactFile, artifactPaths: Set<string>, capturedByRuntimePath: Map<string, CapturedMountFiles["files"][number]>): RuntimeReferenceIndexReference["target"] | undefined {
  if (!isLocalReference(raw)) {
    return undefined
  }

  const referencePath = stripReferenceFragment(raw)
  if (!referencePath || referencePath.startsWith("#")) {
    return undefined
  }

  if (source.runtimePath) {
    const runtimePath = normalizeRuntimePath(resolveRelativePath(dirname(source.runtimePath), referencePath))
    const captured = capturedByRuntimePath.get(runtimePath)
    return {
      raw,
      path: runtimePath,
      present: Boolean(captured),
      ...(captured ? { artifactPath: normalizeArtifactPath(captured.artifactPath) } : {}),
      runtimePath,
    }
  }

  const artifactPath = normalizeArtifactPath(resolveRelativePath(dirname(source.path), referencePath))
  return {
    raw,
    path: artifactPath,
    present: artifactPaths.has(artifactPath),
    ...(artifactPaths.has(artifactPath) ? { artifactPath } : {}),
  }
}

function isLocalReference(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0
    && !trimmed.startsWith("#")
    && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    && !trimmed.startsWith("//")
}

function stripReferenceFragment(value: string): string {
  return value.trim().split("#")[0]?.split("?")[0] ?? ""
}

function resolveRelativePath(base: string, target: string): string {
  if (target.startsWith("/")) {
    return target
  }

  return posix.normalize(posix.join(base, target))
}

function compactSource(file: ScannableArtifactFile): RuntimeReferenceIndexReference["source"] {
  return {
    path: file.path,
    kind: file.kind,
    ...(file.runtimePath ? { runtimePath: file.runtimePath } : {}),
    ...(file.url ? { url: file.url } : {}),
  }
}

function entrypointsForFiles(files: ScannableArtifactFile[]): RuntimeReferenceIndexEntrypoint[] {
  return files
    .filter((file) => file.kind === "html" || isLikelyMarkdownEntrypoint(file.path))
    .map((file) => ({
      path: file.path,
      kind: file.kind === "markdown" ? "markdown" : "html",
      reason: file.kind === "html" ? "html-artifact" : "markdown-entrypoint-name",
      ...(file.runtimePath ? { runtimePath: file.runtimePath } : {}),
      ...(file.url ? { url: file.url } : {}),
    }))
}

function isLikelyMarkdownEntrypoint(path: string): boolean {
  const name = posix.basename(path).toLowerCase()
  return name === "readme.md" || name === "index.md" || name === "readme.markdown" || name === "index.markdown"
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

function normalizeRuntimePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/"))
  return path.startsWith("/") && !normalized.startsWith("/") ? `/${normalized}` : normalized
}
