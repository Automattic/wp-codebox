import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export interface PhpWasmRuntimeAssetPreflight {
  schema: "wp-codebox/php-wasm-runtime-asset-preflight/v1"
  packageName: string
  packageVersion?: string
  phpVersion: string
  mode: "jspi" | "asyncify"
  packageRoot: string
  loaderPath: string
  wasmPath: string
  wasmSize: number
  wasmSha256: string
}

export interface PhpWasmRuntimeAssetPreflightOptions {
  packageRoot?: string
  packageName?: string
  phpVersion?: string
  mode?: "jspi" | "asyncify"
}

export class PhpWasmExternalExtensionCapabilityError extends Error {
  readonly code = "wp-codebox-php-wasm-external-extensions-require-jspi"
  readonly diagnostic: { capability: "jspi"; selectedMode: "asyncify"; message: string }

  constructor() {
    const message = "External PHP.wasm extension manifests require a JSPI runtime; the selected runtime uses Asyncify."
    super(message)
    this.name = "PhpWasmExternalExtensionCapabilityError"
    this.diagnostic = { capability: "jspi", selectedMode: "asyncify", message }
  }
}

export async function assertPhpWasmExternalExtensionsSupported(extensions: readonly unknown[] | undefined, mode?: "jspi" | "asyncify"): Promise<void> {
  if (!extensions || extensions.length === 0) {
    return
  }
  if ((mode ?? phpWasmModeFromEnv() ?? await selectedPhpWasmMode()) !== "jspi") {
    throw new PhpWasmExternalExtensionCapabilityError()
  }
}

const repairHint = "Repair the PHP wasm runtime package by reinstalling dependencies, for example: remove node_modules and package-lock drift, then run npm install; if using a package cache, clear the broken @php-wasm package cache first."
const compiledWasmCache = new Map<string, PhpWasmRuntimeAssetPreflight>()
const requireFromHere = createRequire(import.meta.url)

export class PhpWasmRuntimeAssetIntegrityError extends Error {
  readonly code = "wp-codebox-php-wasm-runtime-asset-invalid"
  readonly repair = repairHint

  constructor(readonly diagnostic: Record<string, unknown>, cause?: unknown) {
    const message = [
      "PHP wasm runtime asset preflight failed before WordPress Playground boot.",
      diagnostic.packageName ? `package=${diagnostic.packageName}` : undefined,
      diagnostic.packageVersion ? `packageVersion=${diagnostic.packageVersion}` : undefined,
      diagnostic.phpVersion ? `php=${diagnostic.phpVersion}` : undefined,
      diagnostic.mode ? `mode=${diagnostic.mode}` : undefined,
      diagnostic.wasmPath ? `wasm=${diagnostic.wasmPath}` : undefined,
      diagnostic.reason ? `reason=${diagnostic.reason}` : undefined,
      repairHint,
    ].filter(Boolean).join(" ")
    super(message, cause === undefined ? undefined : { cause })
    this.name = "PhpWasmRuntimeAssetIntegrityError"
  }
}

export async function preflightPhpWasmRuntimeAssets(options: PhpWasmRuntimeAssetPreflightOptions = {}): Promise<PhpWasmRuntimeAssetPreflight> {
  const phpVersion = options.phpVersion ?? process.env.WP_CODEBOX_PHP_WASM_VERSION ?? await recommendedPhpVersion()
  const packageName = options.packageName ?? process.env.WP_CODEBOX_PHP_WASM_PACKAGE ?? phpWasmNodePackageName(phpVersion)
  const packageRoot = options.packageRoot ?? process.env.WP_CODEBOX_PHP_WASM_PACKAGE_ROOT ?? packageRootFor(packageName)
  const packageVersion = await packageVersionFor(packageRoot)
  const mode = options.mode ?? phpWasmModeFromEnv() ?? await selectedPhpWasmMode()
  const loaderPath = join(packageRoot, mode, `php_${phpVersion.replace(".", "_")}.js`)
  const baseDiagnostic = { schema: "wp-codebox/php-wasm-runtime-asset-diagnostic/v1", packageName, packageVersion, phpVersion, mode, packageRoot, loaderPath }

  if (!existsSync(loaderPath)) {
    throw new PhpWasmRuntimeAssetIntegrityError({ ...baseDiagnostic, reason: "missing-loader", loaderPath })
  }

  const loaderSource = await readFile(loaderPath, "utf8")
  const wasmPath = extractWasmPathFromLoader(loaderSource, loaderPath)
  if (!existsSync(wasmPath)) {
    throw new PhpWasmRuntimeAssetIntegrityError({ ...baseDiagnostic, reason: "missing-wasm", wasmPath })
  }

  const wasmStat = await stat(wasmPath)
  const cacheKey = `${wasmPath}:${wasmStat.size}:${wasmStat.mtimeMs}`
  const cached = compiledWasmCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const wasmBytes = await readFile(wasmPath)
  try {
    await WebAssembly.compile(wasmBytes)
  } catch (error) {
    throw new PhpWasmRuntimeAssetIntegrityError({ ...baseDiagnostic, reason: "invalid-wasm", wasmPath, wasmSize: wasmStat.size }, error)
  }

  const preflight: PhpWasmRuntimeAssetPreflight = {
    schema: "wp-codebox/php-wasm-runtime-asset-preflight/v1",
    packageName,
    ...(packageVersion ? { packageVersion } : {}),
    phpVersion,
    mode,
    packageRoot,
    loaderPath,
    wasmPath,
    wasmSize: wasmStat.size,
    wasmSha256: createHash("sha256").update(wasmBytes).digest("hex"),
  }
  compiledWasmCache.set(cacheKey, preflight)
  return preflight
}

function phpWasmNodePackageName(phpVersion: string): string {
  return `@php-wasm/node-${phpVersion.replace(".", "-")}`
}

function packageRootFor(packageName: string): string {
  return dirname(requireFromHere.resolve(`${packageName}/package.json`))
}

async function packageVersionFor(packageRoot: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: unknown }
    return typeof manifest.version === "string" ? manifest.version : undefined
  } catch {
    return undefined
  }
}

async function recommendedPhpVersion(): Promise<string> {
  const common = await import("@wp-playground/common") as { RecommendedPHPVersion?: unknown }
  if (typeof common.RecommendedPHPVersion === "string") {
    return common.RecommendedPHPVersion
  }
  return "8.3"
}

function phpWasmModeFromEnv(): "jspi" | "asyncify" | undefined {
  const mode = process.env.WP_CODEBOX_PHP_WASM_MODE
  if (mode === "jspi" || mode === "asyncify") {
    return mode
  }

  if (process.env.WP_CODEBOX_NO_JSPI_RESPAWN || process.env.PLAYGROUND_NO_JSPI_RESPAWN) {
    return "asyncify"
  }
}

async function selectedPhpWasmMode(): Promise<"jspi" | "asyncify"> {
  const featureDetect = await import("wasm-feature-detect") as { jspi?: () => Promise<boolean> }
  return await featureDetect.jspi?.() ? "jspi" : "asyncify"
}

function extractWasmPathFromLoader(loaderSource: string, loaderPath: string): string {
  const dependencyMatch = loaderSource.match(/dependencyFilename\s*=\s*path\.join\(currentDirPath,\s*['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/)
  if (dependencyMatch) {
    return join(dirname(loaderPath), dependencyMatch[1], dependencyMatch[2])
  }

  const urlMatch = loaderSource.match(/new URL\(\s*['"]([^'"]+\.wasm)['"],\s*import\.meta\.url\s*\)/)
  if (urlMatch) {
    return fileURLToPath(new URL(urlMatch[1], pathToFileURL(loaderPath)))
  }

  throw new PhpWasmRuntimeAssetIntegrityError({
    schema: "wp-codebox/php-wasm-runtime-asset-diagnostic/v1",
    reason: "wasm-path-not-found-in-loader",
    loaderPath,
  })
}
