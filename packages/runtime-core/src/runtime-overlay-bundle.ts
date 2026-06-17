export const RUNTIME_OVERLAY_BUNDLE_SCHEMA = "wp-codebox/runtime-overlay-bundle/v1" as const

export interface RuntimeOverlayBundleDeclaredFile {
  path: string
  source?: string
  contents?: string
  mode?: "readonly" | "readwrite"
  sha256?: string
  metadata?: Record<string, unknown>
}

export interface RuntimeOverlayBundleConfigPrelude {
  target: string
  source?: string
  contents?: string
  order?: number
  metadata?: Record<string, unknown>
}

export interface RuntimeOverlayBundleLocalRoute {
  path: string
  target: string
  methods?: string[]
  localOnly: true
  metadata?: Record<string, unknown>
}

export interface RuntimeOverlayBundlePatchProvenance {
  id: string
  source: string
  appliesTo?: string
  sha256?: string
  metadata?: Record<string, unknown>
}

export interface RuntimeOverlayBundleCapabilityManifest {
  provided?: string[]
  required?: string[]
  optional?: string[]
}

export interface RuntimeOverlayBundleUnsupportedGap {
  capability: string
  reason: string
  failureMode: "fail-closed"
  metadata?: Record<string, unknown>
}

export interface RuntimeOverlayBundle {
  schema: typeof RUNTIME_OVERLAY_BUNDLE_SCHEMA
  id: string
  description?: string
  files?: RuntimeOverlayBundleDeclaredFile[]
  configPreludes?: RuntimeOverlayBundleConfigPrelude[]
  localRoutes?: RuntimeOverlayBundleLocalRoute[]
  patches?: RuntimeOverlayBundlePatchProvenance[]
  capabilities?: RuntimeOverlayBundleCapabilityManifest
  unsupportedGaps?: RuntimeOverlayBundleUnsupportedGap[]
  metadata?: Record<string, unknown>
}

export function runtimeOverlayBundle(input: Omit<RuntimeOverlayBundle, "schema"> & { schema?: typeof RUNTIME_OVERLAY_BUNDLE_SCHEMA }): RuntimeOverlayBundle {
  if (!input.id || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.id)) {
    throw new Error("Runtime overlay bundle id must be a non-empty stable identifier.")
  }

  const bundle: RuntimeOverlayBundle = {
    ...input,
    schema: RUNTIME_OVERLAY_BUNDLE_SCHEMA,
    files: input.files?.map(normalizeDeclaredFile),
    configPreludes: input.configPreludes?.map(normalizeConfigPrelude).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    localRoutes: input.localRoutes?.map(normalizeLocalRoute),
    patches: input.patches?.map(normalizePatchProvenance),
    capabilities: input.capabilities ? normalizeCapabilities(input.capabilities) : undefined,
    unsupportedGaps: input.unsupportedGaps?.map(normalizeUnsupportedGap),
  }
  assertRuntimeOverlayBundleSupported(bundle)
  return bundle
}

export function assertRuntimeOverlayBundleSupported(bundle: Pick<RuntimeOverlayBundle, "unsupportedGaps">): void {
  const gaps = bundle.unsupportedGaps ?? []
  if (gaps.length === 0) return
  const details = gaps.map((gap) => `${gap.capability}: ${gap.reason}`).join("; ")
  throw new Error(`Runtime overlay bundle declares unsupported fail-closed gaps: ${details}`)
}

function normalizeDeclaredFile(file: RuntimeOverlayBundleDeclaredFile): RuntimeOverlayBundleDeclaredFile {
  requireAbsolutePath(file.path, "declared file path")
  requireSourceOrContents(file, "declared file")
  return { ...file, mode: file.mode ?? "readonly" }
}

function normalizeConfigPrelude(prelude: RuntimeOverlayBundleConfigPrelude): RuntimeOverlayBundleConfigPrelude {
  requireNonEmpty(prelude.target, "config prelude target")
  requireSourceOrContents(prelude, "config prelude")
  return prelude
}

function normalizeLocalRoute(route: RuntimeOverlayBundleLocalRoute): RuntimeOverlayBundleLocalRoute {
  requireAbsolutePath(route.path, "local route path")
  requireNonEmpty(route.target, "local route target")
  if (route.localOnly !== true) throw new Error("Runtime overlay bundle routes must be local-only.")
  return { ...route, methods: route.methods?.map((method) => method.toUpperCase()) }
}

function normalizePatchProvenance(patch: RuntimeOverlayBundlePatchProvenance): RuntimeOverlayBundlePatchProvenance {
  requireNonEmpty(patch.id, "patch id")
  requireNonEmpty(patch.source, "patch source")
  return patch
}

function normalizeCapabilities(capabilities: RuntimeOverlayBundleCapabilityManifest): RuntimeOverlayBundleCapabilityManifest {
  return {
    provided: uniqueStrings(capabilities.provided),
    required: uniqueStrings(capabilities.required),
    optional: uniqueStrings(capabilities.optional),
  }
}

function normalizeUnsupportedGap(gap: RuntimeOverlayBundleUnsupportedGap): RuntimeOverlayBundleUnsupportedGap {
  requireNonEmpty(gap.capability, "unsupported gap capability")
  requireNonEmpty(gap.reason, "unsupported gap reason")
  if (gap.failureMode !== "fail-closed") throw new Error("Unsupported runtime overlay bundle gaps must fail closed.")
  return gap
}

function requireSourceOrContents(input: { source?: string; contents?: string }, label: string): void {
  if (!input.source && input.contents === undefined) throw new Error(`Runtime overlay bundle ${label} must declare source or contents.`)
}

function requireAbsolutePath(path: string, label: string): void {
  requireNonEmpty(path, label)
  if (!path.startsWith("/")) throw new Error(`Runtime overlay bundle ${label} must be absolute.`)
  if (path.split("/").includes("..")) throw new Error(`Runtime overlay bundle ${label} cannot contain parent-directory segments.`)
}

function requireNonEmpty(value: string | undefined, label: string): void {
  if (!value || value.trim() === "") throw new Error(`Runtime overlay bundle ${label} is required.`)
}

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined
  return [...new Set(values.filter((value) => value.trim() !== ""))]
}
