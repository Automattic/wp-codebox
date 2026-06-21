import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { RuntimeBackendFactoryContext, RuntimeBackendKind, WorkspaceRecipe, WorkspaceRecipeRuntimeBackendPackage } from "@automattic/wp-codebox-core"

export interface RuntimeBackendPackageProvenance {
  schema: "wp-codebox/runtime-backend-package/v1"
  kind: string
  source: string
  resolvedSource: string
  entrypoint: string
  package?: {
    name?: string
    version?: string
    digest?: { sha256: string }
  }
  entrypointDigest?: { sha256: string }
  diagnostics: Array<{ status: "passed"; message: string }>
  metadata?: Record<string, unknown>
}

export interface PreparedRuntimeBackendPackage {
  runtimeBackendContext: RuntimeBackendFactoryContext
  provenance: RuntimeBackendPackageProvenance
}

interface LoadedRuntimeBackendPackage {
  backendPackage: WorkspaceRecipeRuntimeBackendPackage
  resolvedSource: string
  entrypoint: string
  entrypointContents: string
  manifest?: { raw: string; json: Record<string, unknown> }
  module: unknown
}

interface PreparedRuntimeBackendPackageAdapterResult {
  runtimeBackendContext: RuntimeBackendFactoryContext
  diagnostics: Array<{ status: "passed"; message: string }>
}

interface RuntimeBackendPackageAdapter {
  readonly backendKind: RuntimeBackendKind
  prepare(loadedPackage: LoadedRuntimeBackendPackage): PreparedRuntimeBackendPackageAdapterResult
}

interface RuntimeCliEntrypointModule {
  runCLI(args: string[]): unknown
}

class RuntimeBackendPackageAdapterRegistry {
  readonly #adapters = new Map<RuntimeBackendKind, RuntimeBackendPackageAdapter>()

  constructor(adapters: readonly RuntimeBackendPackageAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter)
    }
  }

  register(adapter: RuntimeBackendPackageAdapter): void {
    if (this.#adapters.has(adapter.backendKind)) {
      throw new Error(`Runtime backend package adapter is already registered: ${adapter.backendKind}`)
    }

    this.#adapters.set(adapter.backendKind, adapter)
  }

  resolve(backendKind: RuntimeBackendKind): RuntimeBackendPackageAdapter {
    const adapter = this.#adapters.get(backendKind)
    if (!adapter) {
      const known = this.#adapters.size > 0 ? [...this.#adapters.keys()].join(", ") : "none"
      throw new Error(`Unsupported runtime backend package backend: ${backendKind}; known backend package backends: ${known}`)
    }

    return adapter
  }
}

const playgroundRuntimeBackendPackageAdapter: RuntimeBackendPackageAdapter = {
  backendKind: "wordpress-playground",
  prepare(loadedPackage) {
    const { backendPackage, entrypoint, module } = loadedPackage
    if (backendPackage.kind !== "playground") {
      throw backendPackageError(backendPackage, `Unsupported WordPress Playground runtime backend package kind: ${backendPackage.kind}`)
    }
    if (!isPlaygroundCliModule(module)) {
      throw backendPackageError(backendPackage, `Runtime backend package entrypoint must export runCLI(): ${entrypoint}`)
    }

    return {
      runtimeBackendContext: { cliModule: module as RuntimeCliEntrypointModule },
      diagnostics: [{ status: "passed", message: "Entrypoint exports runCLI" }],
    }
  },
}

const runtimeBackendPackageAdapterRegistry = new RuntimeBackendPackageAdapterRegistry([playgroundRuntimeBackendPackageAdapter])

export class RecipeRuntimeBackendPackageError extends Error {
  readonly code = "recipe-runtime-backend-package-invalid"

  constructor(message: string, readonly backendPackage: WorkspaceRecipeRuntimeBackendPackage, readonly diagnostics: Array<{ status: "failed"; message: string }>) {
    super(message)
    this.name = "RecipeRuntimeBackendPackageError"
  }
}

export async function prepareRecipeRuntimeBackendPackage(recipe: WorkspaceRecipe, recipeDirectory: string, backendKind: RuntimeBackendKind = recipe.runtime?.backend ?? "wordpress-playground"): Promise<PreparedRuntimeBackendPackage | undefined> {
  const backendPackage = recipe.runtime?.backendPackage
  if (!backendPackage) {
    return undefined
  }

  const resolvedSource = resolve(recipeDirectory, backendPackage.source)
  const sourceStat = await statBackendSource(backendPackage, resolvedSource)
  const packageRoot = sourceStat.isDirectory() ? resolvedSource : dirname(resolvedSource)
  const manifest = sourceStat.isDirectory() ? await readPackageManifest(backendPackage, packageRoot) : undefined
  if (backendPackage.package && manifest?.json.name !== backendPackage.package) {
    throw backendPackageError(backendPackage, `Runtime backend package name mismatch: expected ${backendPackage.package}, found ${manifest?.json.name ?? "unknown"}`)
  }

  const entrypoint = sourceStat.isDirectory()
    ? resolvePackageEntrypoint(backendPackage, packageRoot, manifest?.json)
    : resolvedSource
  const entrypointContents = await readBackendEntrypoint(backendPackage, entrypoint)
  const module = await importBackendEntrypoint(backendPackage, entrypoint)
  const adapter = runtimeBackendPackageAdapterRegistry.resolve(backendKind)
  const adapterResult = adapter.prepare({ backendPackage, resolvedSource, entrypoint, entrypointContents, manifest, module })

  return {
    runtimeBackendContext: adapterResult.runtimeBackendContext,
    provenance: {
      schema: "wp-codebox/runtime-backend-package/v1",
      kind: backendPackage.kind,
      source: backendPackage.source,
      resolvedSource,
      entrypoint,
      ...(manifest ? { package: { name: stringField(manifest.json, "name"), version: stringField(manifest.json, "version"), digest: { sha256: sha256(manifest.raw) } } } : {}),
      entrypointDigest: { sha256: sha256(entrypointContents) },
      diagnostics: [
        { status: "passed", message: "Source exists" },
        { status: "passed", message: "Entrypoint resolved" },
        ...adapterResult.diagnostics,
      ],
      ...(backendPackage.metadata ? { metadata: backendPackage.metadata } : {}),
    },
  }
}

async function statBackendSource(backendPackage: WorkspaceRecipeRuntimeBackendPackage, resolvedSource: string) {
  try {
    return await stat(resolvedSource)
  } catch {
    throw backendPackageError(backendPackage, `Runtime backend package source must exist: ${backendPackage.source}`)
  }
}

async function readPackageManifest(backendPackage: WorkspaceRecipeRuntimeBackendPackage, packageRoot: string): Promise<{ raw: string; json: Record<string, unknown> }> {
  const manifestPath = join(packageRoot, "package.json")
  try {
    const raw = await readFile(manifestPath, "utf8")
    return { raw, json: JSON.parse(raw) as Record<string, unknown> }
  } catch (error) {
    const message = error instanceof SyntaxError ? `Runtime backend package package.json is invalid JSON: ${manifestPath}` : `Runtime backend package directory must contain package.json: ${manifestPath}`
    throw backendPackageError(backendPackage, message)
  }
}

function resolvePackageEntrypoint(backendPackage: WorkspaceRecipeRuntimeBackendPackage, packageRoot: string, manifest: Record<string, unknown> | undefined): string {
  if (backendPackage.entrypoint) {
    return resolve(packageRoot, backendPackage.entrypoint)
  }

  const candidates = [
    exportEntrypoint(manifest?.exports),
    stringField(manifest, "module"),
    stringField(manifest, "main"),
    "index.js",
  ]

  return resolve(packageRoot, candidates.find(Boolean) ?? "index.js")
}

function exportEntrypoint(exportsField: unknown): string | undefined {
  if (typeof exportsField === "string") {
    return exportsField
  }
  if (!exportsField || typeof exportsField !== "object") {
    return undefined
  }

  const rootExport = "." in exportsField ? (exportsField as Record<string, unknown>)["."] : exportsField
  if (typeof rootExport === "string") {
    return rootExport
  }
  if (!rootExport || typeof rootExport !== "object") {
    return undefined
  }

  return stringField(rootExport as Record<string, unknown>, "import")
    ?? stringField(rootExport as Record<string, unknown>, "default")
    ?? stringField(rootExport as Record<string, unknown>, "node")
}

async function readBackendEntrypoint(backendPackage: WorkspaceRecipeRuntimeBackendPackage, entrypoint: string): Promise<string> {
  try {
    return await readFile(entrypoint, "utf8")
  } catch {
    throw backendPackageError(backendPackage, `Runtime backend package entrypoint must exist: ${entrypoint}`)
  }
}

async function importBackendEntrypoint(backendPackage: WorkspaceRecipeRuntimeBackendPackage, entrypoint: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(entrypoint).href)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw backendPackageError(backendPackage, `Runtime backend package entrypoint could not be imported: ${basename(entrypoint)} (${message})`)
  }
}

function isPlaygroundCliModule(value: unknown): value is RuntimeCliEntrypointModule {
  return Boolean(value && typeof value === "object" && "runCLI" in value && typeof (value as { runCLI?: unknown }).runCLI === "function")
}

function backendPackageError(backendPackage: WorkspaceRecipeRuntimeBackendPackage, message: string): RecipeRuntimeBackendPackageError {
  return new RecipeRuntimeBackendPackageError(message, backendPackage, [{ status: "failed", message }])
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex")
}
