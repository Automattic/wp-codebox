import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

export type SourceRootPreparationMode = "copy" | "reference"

export interface SourceRootComponentDescriptor {
  name: string
  source: string
  target?: string
  mode?: SourceRootPreparationMode
  metadata?: Record<string, unknown>
}

export interface SourceRootPreparationOptions {
  components: readonly SourceRootComponentDescriptor[]
  preparedRoot: string
  allowedSourceRoots?: readonly string[]
  defaultMode?: SourceRootPreparationMode
  manifestPath?: string
}

export interface PreparedSourceRootComponent {
  name: string
  mode: SourceRootPreparationMode
  originalPath: string
  preparedPath: string
  target: string
  copied: boolean
  metadata?: Record<string, unknown>
}

export interface SourceRootPreparationDiagnostic {
  code: string
  message: string
  component?: string
}

export interface SourceRootPreparationManifest {
  schema: "wp-codebox/source-root-preparation/v1"
  preparedRoot: string
  components: PreparedSourceRootComponent[]
  diagnostics: SourceRootPreparationDiagnostic[]
}

export async function prepareSourceRoots(options: SourceRootPreparationOptions): Promise<SourceRootPreparationManifest> {
  const preparedRoot = resolveRequiredDirectory(options.preparedRoot, "preparedRoot")
  const allowedRoots = (options.allowedSourceRoots ?? []).map((root) => resolveRequiredDirectory(root, "allowedSourceRoots"))
  const defaultMode = options.defaultMode ?? "copy"
  validateMode(defaultMode)

  await mkdir(preparedRoot, { recursive: true })

  const components = [...options.components]
    .map((component, index) => normalizeSourceRootComponent(component, index, preparedRoot, allowedRoots, defaultMode))
    .sort((a, b) => a.name.localeCompare(b.name))

  const seenTargets = new Set<string>()
  const seenNames = new Set<string>()
  for (const component of components) {
    if (seenNames.has(component.name)) {
      throw new Error(`Source root component name must be unique: ${component.name}`)
    }
    if (seenTargets.has(component.target)) {
      throw new Error(`Source root target must be unique: ${component.target}`)
    }
    seenNames.add(component.name)
    seenTargets.add(component.target)
  }

  const diagnostics: SourceRootPreparationDiagnostic[] = []
  for (const component of components) {
    const sourceStat = await stat(component.originalPath).catch(() => undefined)
    if (!sourceStat) {
      throw new Error(`Source root does not exist for ${component.name}: ${component.originalPath}`)
    }
    if (!sourceStat.isDirectory()) {
      throw new Error(`Source root must be a directory for ${component.name}: ${component.originalPath}`)
    }

    if (component.mode === "copy") {
      await rm(component.preparedPath, { recursive: true, force: true })
      await cp(component.originalPath, component.preparedPath, { recursive: true, force: true })
      diagnostics.push({ code: "component-copied", message: `Prepared source root copied for ${component.name}.`, component: component.name })
    } else {
      diagnostics.push({ code: "component-referenced", message: `Prepared source root referenced for ${component.name}.`, component: component.name })
    }
  }

  const manifest: SourceRootPreparationManifest = {
    schema: "wp-codebox/source-root-preparation/v1",
    preparedRoot,
    components,
    diagnostics,
  }

  if (options.manifestPath) {
    const manifestPath = resolve(preparedRoot, normalizeRelativePath(options.manifestPath, "manifestPath"))
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  return manifest
}

function normalizeSourceRootComponent(
  component: SourceRootComponentDescriptor,
  index: number,
  preparedRoot: string,
  allowedRoots: readonly string[],
  defaultMode: SourceRootPreparationMode,
): PreparedSourceRootComponent {
  if (!component.name || typeof component.name !== "string") {
    throw new Error(`Source root component ${index} requires name`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(component.name)) {
    throw new Error(`Source root component name must contain only letters, numbers, dots, underscores, or dashes: ${component.name}`)
  }
  if (!component.source || typeof component.source !== "string") {
    throw new Error(`Source root component ${component.name} requires source`)
  }

  const mode = component.mode ?? defaultMode
  validateMode(mode)

  const originalPath = resolve(component.source)
  if (allowedRoots.length > 0 && !allowedRoots.some((root) => isPathInside(root, originalPath))) {
    throw new Error(`Source root for ${component.name} must be inside an allowed source root`)
  }

  const target = normalizeRelativePath(component.target ?? component.name, `Source root target for ${component.name}`)
  const preparedPath = mode === "copy" ? resolve(preparedRoot, target) : originalPath
  if (mode === "copy" && !isPathInside(preparedRoot, preparedPath)) {
    throw new Error(`Prepared path for ${component.name} must stay inside the prepared root`)
  }

  return {
    name: component.name,
    mode,
    originalPath,
    preparedPath,
    target,
    copied: mode === "copy",
    ...(component.metadata ? { metadata: component.metadata } : {}),
  }
}

function resolveRequiredDirectory(path: string, label: string): string {
  if (!path || typeof path !== "string") {
    throw new Error(`${label} is required`)
  }
  return resolve(path)
}

function normalizeRelativePath(path: string, label: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/")
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:($|\/)/.test(normalized)) {
    throw new Error(`${label} must be a relative path`)
  }

  const segments = normalized.split("/").filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain current-directory or parent-directory segments`)
  }
  return segments.join("/")
}

function validateMode(mode: SourceRootPreparationMode): void {
  if (mode !== "copy" && mode !== "reference") {
    throw new Error(`Unsupported source root preparation mode: ${mode}`)
  }
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}
