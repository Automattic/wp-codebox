import { playgroundBlueprint } from "./blueprint.js"
import { PlaygroundCliExitError, type PlaygroundCliBufferedOutput } from "./playground-command-errors.js"
import { PlaygroundPreviewPortUnavailableError, assertPreviewPortAvailable, errorHasCode, withPreviewProxy, type PlaygroundCliServer } from "./preview-server.js"
import { startProgrammaticPlaygroundServer } from "./programmatic-playground-runner.js"
import { normalizeLiveProgressEvent, previewLease, type BrowserStartupProgressEvent, type BrowserStartupProgressPhase, type BrowserStartupProgressStatus, type MountSpec, type PreviewLease, type RuntimeCreateSpec, type RuntimePreviewLeaseProvider } from "@automattic/wp-codebox-core"
import { randomInt } from "node:crypto"
import { existsSync } from "node:fs"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createServer as createNetServer } from "node:net"
import * as PlaygroundStorage from "@wp-playground/storage"
import { resolveWordPressRelease } from "@wp-playground/wordpress"
import { phpEnvAssignments, phpWpConfigDefineAssignments } from "./php-snippets.js"
import { stageReadonlyPlaygroundMounts, type ReadonlyMountStaging } from "./mount-materialization.js"

const DEFAULT_RUNTIME_PHP_INI_ENTRIES = { memory_limit: "512M" }

export interface PlaygroundCliModule {
  runCLI(options: {
    command: "server"
    port: number
    quiet: boolean
    verbosity?: "quiet"
    skipBrowser: boolean
    mount: Array<{ hostPath: string; vfsPath: string }>
    "mount-before-install"?: Array<{ hostPath: string; vfsPath: string }>
    blueprint?: unknown
    wp?: string
    php?: string
    workers?: number | "auto"
    wordpressInstallMode?: "install-from-existing-files" | "install-from-existing-files-if-needed" | "do-not-attempt-installing"
    "site-url"?: string
    phpIniEntries?: Record<string, string>
  }): Promise<PlaygroundCliServer>
}

const PLAYGROUND_WORDPRESS_CACHE_DIRECTORY_ENV = "WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR"

export interface PlaygroundCliStartupOptions {
  onProgress?: (event: BrowserStartupProgressEvent) => void | Promise<void>
  cliModule?: PlaygroundCliModule
}

export async function startPlaygroundCliServer(spec: RuntimeCreateSpec, mounts: MountSpec[], options: PlaygroundCliStartupOptions = {}): Promise<PlaygroundCliServer> {
  const startedAt = Date.now()
  const emitProgress = (phase: BrowserStartupProgressPhase, status: BrowserStartupProgressStatus, label: string, detail?: Record<string, unknown>) => {
    const event = {
      schema: "wp-codebox/browser-startup-progress/v1",
      phase,
      status,
      label,
      elapsed_ms: Date.now() - startedAt,
      ...(detail ? { detail } : {}),
    } as BrowserStartupProgressEvent
    void Promise.resolve(options.onProgress?.({ ...event, normalized_progress: normalizeLiveProgressEvent(event) } as BrowserStartupProgressEvent)).catch(() => undefined)
  }

  emitProgress("preview:start", "running", "Preparing your site", {
    backend: spec.backend,
    preview: previewDetail(spec),
    mounts: mounts.length,
  })
  emitProgress("preview:loading-client", "running", "Loading preview")
  let readonlyMountStaging: ReadonlyMountStaging | undefined
  try {
    if (spec.preview?.port) {
      await assertPreviewPortAvailable(spec.preview.port)
    }

    emitProgress("preview:loading-wordpress", "running", "Loading your site", {
      wordpressVersion: spec.environment.version,
    })
    const wordpressDirectory = spec.environment.assets?.wordpressDirectory
    const wordpressInstallMode = spec.environment.wordpressInstallMode ?? "install-from-existing-files"
    const bootstrapIniEntries = runtimeBootstrapPhpIniEntries(spec)
    const useProgrammaticRunner = shouldUseProgrammaticPlaygroundRunner(spec, options)
    readonlyMountStaging = await stageReadonlyPlaygroundMounts(mounts)
    const stagedMounts = readonlyMountStaging.mounts
    const wordpressStartupAsset = wordpressDirectory ? undefined : await resolvePlaygroundWordPressStartupAsset(spec.environment.version, spec.environment.assets?.wordpressZip)
    const cacheValidation = wordpressStartupAsset?.cacheValidation ?? {
      version: spec.environment.version ?? "mounted-wordpress-source",
      sourceUrl: wordpressDirectory ?? "",
      source: "pre-resolved" as const,
      invalidArchives: [],
    }
    const blueprintSummary = summarizeBlueprint(spec.environment.blueprint)
    if (blueprintSummary.steps > 0) {
      emitProgress("preview:applying-blueprint", "running", "Applying site setup", blueprintSummary)
    }
    if (blueprintSummary.dependencySteps > 0) {
      emitProgress("preview:installing-dependencies", "running", "Installing required resources", blueprintSummary)
    }
    if (blueprintSummary.activationSteps > 0) {
      emitProgress("preview:activating-dependencies", "running", "Activating site features", blueprintSummary)
    }

    const server = useProgrammaticRunner ? await startPlaygroundCliWithDynamicPortRetry(async (port) => {
      return startProgrammaticPlaygroundServer({
        ...spec,
        preview: {
          ...spec.preview,
          port,
        },
      }, stagedMounts, {
        bootstrapIniEntries: bootstrapIniEntries!,
        phpIniEntries: pluginRuntimePhpIniEntries(spec),
        wordpressDirectory: wordpressDirectory!,
        wordpressInstallMode,
        sharedPhpIniContent: phpIniContent(bootstrapIniEntries!),
      })
    }, Boolean(spec.preview?.port)) : await startPlaygroundCliWithDynamicPortRetry(async (port) => {
      const { runCLI } = options.cliModule ?? (await import("@wp-playground/cli")) as unknown as PlaygroundCliModule
      const localAssetServer = wordpressStartupAsset?.localPath ? await serveLocalStartupAsset(wordpressStartupAsset.localPath) : undefined
      const bootstrapSharedMount = await pluginRuntimeBootstrapSharedMount(spec)
      try {
        return await runCLI({
          command: "server",
          port,
          quiet: true,
          verbosity: "quiet",
          skipBrowser: true,
          workers: 6,
          mount: [
            ...stagedMounts.map((mount) => ({
              hostPath: mount.source,
              vfsPath: mount.target,
            })),
          ],
          ...(wordpressDirectory || bootstrapSharedMount ? {
            "mount-before-install": [
              ...(bootstrapSharedMount ? [bootstrapSharedMount] : []),
              ...(wordpressDirectory ? [{ hostPath: wordpressDirectory, vfsPath: "/wordpress" }] : []),
            ],
            wordpressInstallMode,
          } : {}),
          wp: localAssetServer?.url ?? wordpressStartupAsset?.wp,
          php: spec.environment.phpVersion,
          phpIniEntries: pluginRuntimePhpIniEntries(spec),
          "site-url": spec.preview?.siteUrl,
          blueprint: playgroundCliBlueprint(spec),
        })
      } finally {
        await localAssetServer?.close()
      }
    }, Boolean(spec.preview?.port))

    emitProgress("preview:connecting-client", "running", "Connecting preview", {
      localUrl: server.serverUrl,
      cacheValidation,
      fixedPreviewPort: spec.preview?.port ?? null,
    })

    const proxiedServer = await withPreviewLeaseProvider(await withPreviewProxy(server, spec.preview?.port ?? 0, spec.preview?.bind), spec)
    emitProgress("preview:ready", "complete", "Preview ready", {
      localUrl: proxiedServer.serverUrl,
      upstreamUrl: server.serverUrl,
      lease: proxiedServer.previewLease ? previewLeaseDetail(proxiedServer.previewLease) : undefined,
    })
    return {
      ...proxiedServer,
      async [Symbol.asyncDispose]() {
        try {
          await proxiedServer[Symbol.asyncDispose]()
        } finally {
          await readonlyMountStaging?.[Symbol.asyncDispose]()
        }
      },
    }
  } catch (error) {
    emitProgress("preview:error", "failed", "Preview failed to start", {
      error: errorDetail(error),
    })

    await readonlyMountStaging?.[Symbol.asyncDispose]()
    if (spec.preview?.port && errorHasCode(error, "EADDRINUSE")) {
      throw new PlaygroundPreviewPortUnavailableError(spec.preview.port, error)
    }

    throw error
  }
}

async function withPreviewLeaseProvider(server: PlaygroundCliServer, spec: RuntimeCreateSpec): Promise<PlaygroundCliServer> {
  const provider = spec.preview?.leaseProvider
  if (!provider) {
    return server
  }

  let lease: PreviewLease | undefined
  try {
    lease = previewLease(await provider.acquire({
      localUrl: server.serverUrl,
      requestedPublicUrl: spec.preview?.publicUrl,
      requestedSiteUrl: spec.preview?.siteUrl,
      metadata: { backend: spec.backend },
    }))
    lease = await probePreviewLease(provider, lease)
  } catch (error) {
    if (lease) {
      await safeReleasePreviewLease(provider, lease, "probe-failed", error)
    }
    await server[Symbol.asyncDispose]()
    throw error
  }

  return {
    ...server,
    previewLease: lease,
    async [Symbol.asyncDispose]() {
      try {
        await safeReleasePreviewLease(provider, lease, "runtime-dispose")
      } finally {
        await server[Symbol.asyncDispose]()
      }
    },
  }
}

async function probePreviewLease(provider: RuntimePreviewLeaseProvider, lease: PreviewLease): Promise<PreviewLease> {
  const result = await provider.probe?.(lease)
  if (!result) {
    return lease
  }

  const probedLease = previewLease({
    ...lease,
    ...(result.lease ?? {}),
    reachability: result.reachability ?? result.lease?.reachability ?? {
      status: result.status,
      checked_at: new Date().toISOString(),
      ...(result.evidence_refs ? { evidence_refs: result.evidence_refs } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
    },
    evidence_refs: result.evidence_refs ?? result.lease?.evidence_refs ?? lease.evidence_refs,
  })
  if (result.status === "unreachable") {
    throw new PreviewLeaseProbeError(probedLease)
  }

  return probedLease
}

async function safeReleasePreviewLease(provider: RuntimePreviewLeaseProvider, lease: PreviewLease, reason: "runtime-dispose" | "probe-failed", error?: unknown): Promise<void> {
  try {
    await provider.release?.(lease, {
      status: error ? "failed" : "released",
      reason,
      ...(error ? { error: errorDetail(error) } : {}),
    })
  } catch {
    // Local runtime cleanup must still proceed even if an external lease provider fails release.
  }
}

class PreviewLeaseProbeError extends Error {
  constructor(readonly lease: PreviewLease) {
    super("Preview lease probe reported unreachable preview.")
    this.name = "PreviewLeaseProbeError"
  }
}

export function shouldUseProgrammaticPlaygroundRunner(spec: RuntimeCreateSpec, options: PlaygroundCliStartupOptions = {}): boolean {
  return !options.cliModule
    && Boolean(spec.environment.assets?.wordpressDirectory)
    && (Boolean(runtimeBootstrapPhpIniEntries(spec)) || Boolean(spec.environment.extensions?.length))
}

async function pluginRuntimeBootstrapSharedMount(spec: RuntimeCreateSpec): Promise<{ hostPath: string; vfsPath: string } | undefined> {
  const iniEntries = runtimeBootstrapPhpIniEntries(spec)
  if (!iniEntries) {
    return undefined
  }

  const directory = join(spec.artifactsDirectory ?? "artifacts", "playground-internal-shared")
  await mkdir(directory, { recursive: true })
  await mkdir(join(directory, "mu-plugins"), { recursive: true })
  await mkdir(join(directory, "preload"), { recursive: true })
  await writeFile(join(directory, "php.ini"), phpIniContent(iniEntries), "utf8")
  await writeFile(join(directory, "auto_prepend_file.php"), runtimeAutoPrependPhp(spec), "utf8")

  return { hostPath: directory, vfsPath: "/internal/shared" }
}

function runtimeBootstrapPhpIniEntries(spec: RuntimeCreateSpec): Record<string, string> | undefined {
  const entries = pluginRuntimeBootstrapPhpIniEntries(spec) ?? {}
  if (Object.keys(entries).length === 0 && !distributionBootstrapPhp(spec)) {
    return undefined
  }

  return entries
}

function pluginRuntimeBootstrapPhpIniEntries(spec: RuntimeCreateSpec): Record<string, string> | undefined {
  return pluginRuntimePhpEntries(spec, "bootstrapIniEntries")
}

function pluginRuntimePhpIniEntries(spec: RuntimeCreateSpec): Record<string, string> | undefined {
  return {
    ...DEFAULT_RUNTIME_PHP_INI_ENTRIES,
    ...(pluginRuntimePhpEntries(spec, "iniEntries") ?? {}),
  }
}

function pluginRuntimePhpEntries(spec: RuntimeCreateSpec, key: "iniEntries" | "bootstrapIniEntries"): Record<string, string> | undefined {
  const pluginRuntime = spec.metadata?.recipe && typeof spec.metadata.recipe === "object" && !Array.isArray(spec.metadata.recipe)
    ? (spec.metadata.recipe as { inputs?: { pluginRuntime?: unknown } }).inputs?.pluginRuntime
    : undefined
  const php = pluginRuntime && typeof pluginRuntime === "object" && !Array.isArray(pluginRuntime)
    ? (pluginRuntime as { php?: Record<string, unknown> }).php
    : undefined
  const iniEntries = php && typeof php === "object" && !Array.isArray(php) ? php[key] : undefined
  if (!iniEntries || typeof iniEntries !== "object" || Array.isArray(iniEntries)) {
    return undefined
  }

  const entries: Record<string, string> = {}
  for (const [name, value] of Object.entries(iniEntries)) {
    if (/^[a-zA-Z0-9_.-]+$/.test(name) && (["string", "number", "boolean"].includes(typeof value) || value === null)) {
      entries[name] = value === null ? "" : String(value)
    }
  }

  return Object.keys(entries).length > 0 ? entries : undefined
}

function phpIniContent(entries: Record<string, string>): string {
  const lines = [
    "auto_prepend_file=/internal/shared/auto_prepend_file.php",
    // Runtime memory ceiling for all in-sandbox PHP, including artifact
    // collection. The collect_artifacts phase reads declared/typed artifacts and
    // runtime snapshot files into memory and base64-encodes them
    // (file_get_contents + base64_encode + wp_json_encode each hold a copy, so a
    // single file costs ~2.3x its size in PHP heap). At the old 256M a heavy
    // fixture could exhaust the limit mid-collection and emit a hard PHP fatal,
    // sinking the whole batch. 512M keeps collection bounded well below the 2000M
    // upload/post ceilings already configured below, without uncapping memory.
    // Recipes can still raise this per-runtime via pluginRuntime.php.iniEntries.
    "memory_limit=512M",
    "ignore_repeated_errors = 1",
    "error_reporting = E_ALL",
    "display_errors = 1",
    "html_errors = 1",
    "display_startup_errors = On",
    "log_errors = 1",
    "always_populate_raw_post_data = -1",
    "upload_max_filesize = 2000M",
    "post_max_size = 2000M",
    "allow_url_fopen = On",
    "allow_url_include = Off",
    "session.save_path = /home/web_user",
    "implicit_flush = 1",
    "output_buffering = 0",
    "max_execution_time = 0",
    "max_input_time = -1",
  ]
  for (const [name, value] of Object.entries(entries)) {
    lines.push(`${name} = ${value}`)
  }

  return `${lines.join("\n")}\n`
}

function runtimeAutoPrependPhp(spec: RuntimeCreateSpec): string {
  return `<?php\n${distributionBootstrapPhp(spec)}`
}

function distributionBootstrapPhp(spec: RuntimeCreateSpec): string {
  const distribution = recipeDistribution(spec)
  if (!distribution) {
    return ""
  }

  const lines = [
    phpEnvAssignments(distributionEnv(distribution.env)),
    phpWpConfigDefineAssignments(distribution.constants ?? {}),
  ].filter(Boolean)

  return lines.length > 0 ? `${lines.join("")}\n` : ""
}

function recipeDistribution(spec: RuntimeCreateSpec): { env?: Record<string, unknown>; constants?: Record<string, unknown> } | undefined {
  const recipe = spec.metadata?.recipe
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    return undefined
  }

  const distribution = (recipe as { distribution?: unknown }).distribution
  return distribution && typeof distribution === "object" && !Array.isArray(distribution) ? distribution as { env?: Record<string, unknown>; constants?: Record<string, unknown> } : undefined
}

function distributionEnv(values: Record<string, unknown> | undefined): Record<string, unknown> {
  const env: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      env[name] = value === null ? "" : String(value)
    }
  }

  return env
}

function playgroundCliBlueprint(spec: RuntimeCreateSpec): unknown {
  const blueprint = playgroundBlueprint(spec.environment.blueprint, spec.policy, spec.preview?.siteUrl)
  if (blueprint !== spec.environment.blueprint) {
    return blueprint
  }

  return localBlueprintPackageFilesystem(spec) ?? blueprint
}

function localBlueprintPackageFilesystem(spec: RuntimeCreateSpec): LocalBlueprintPackageFilesystem | undefined {
  const task = spec.metadata?.task
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return undefined
  }

  const blueprintPath = (task as Record<string, unknown>).blueprintPath
  if (typeof blueprintPath !== "string" || blueprintPath.length === 0) {
    return undefined
  }

  return new LocalBlueprintPackageFilesystem(blueprintPath)
}

class LocalBlueprintPackageFilesystem {
  private readonly filesystem: ReadableBlueprintFilesystem
  private readonly blueprintFileName: string

  constructor(blueprintPath: string) {
    const NodeJsFilesystem = (PlaygroundStorage as unknown as { NodeJsFilesystem: new(root: string) => ReadableBlueprintFilesystem }).NodeJsFilesystem
    this.filesystem = new NodeJsFilesystem(dirname(blueprintPath))
    this.blueprintFileName = basename(blueprintPath)
  }

  read(path: string): ReturnType<ReadableBlueprintFilesystem["read"]> {
    const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "")
    return this.filesystem.read(normalizedPath === "blueprint.json" ? this.blueprintFileName : normalizedPath)
  }
}

interface ReadableBlueprintFilesystem {
  read(path: string): Promise<unknown>
}

async function startPlaygroundCliWithDynamicPortRetry(callback: (port: number) => Promise<PlaygroundCliServer>, fixedPreviewPort: boolean): Promise<PlaygroundCliServer> {
  const attempts = fixedPreviewPort ? 1 : 6
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = fixedPreviewPort ? 0 : await availablePlaygroundPortRange()
    try {
      return await runPlaygroundCliWithoutProcessExit(() => callback(port))
    } catch (error) {
      if (!fixedPreviewPort && attempt < attempts && errorHasCode(error, "EADDRINUSE")) {
        continue
      }

      throw error
    }
  }

  throw new Error("WordPress Playground CLI could not find an available dynamic port")
}

function previewDetail(spec: RuntimeCreateSpec): Record<string, unknown> {
  return {
    hasPublicUrl: Boolean(spec.preview?.publicUrl),
    hasSiteUrl: Boolean(spec.preview?.siteUrl),
    hasFixedPort: spec.preview?.port !== undefined,
    bind: spec.preview?.bind ?? null,
    hasLeaseProvider: Boolean(spec.preview?.leaseProvider),
  }
}

function previewLeaseDetail(lease: PreviewLease): Record<string, unknown> {
  return {
    provider: lease.lease?.provider ?? null,
    status: lease.lease?.status ?? null,
    reachability: lease.reachability?.status ?? null,
    hasPublicUrl: Boolean(lease.public_url ?? lease.preview_public_url),
  }
}

function summarizeBlueprint(blueprint: unknown): { steps: number; dependencySteps: number; activationSteps: number; stepTypes: string[] } {
  const steps = blueprint && typeof blueprint === "object" && "steps" in blueprint && Array.isArray(blueprint.steps) ? blueprint.steps : []
  const stepTypes = steps.map((step) => stepType(step)).filter((step): step is string => Boolean(step))
  return {
    steps: steps.length,
    dependencySteps: stepTypes.filter((step) => /install|import|download|package/i.test(step)).length,
    activationSteps: stepTypes.filter((step) => /activate|enable/i.test(step)).length,
    stepTypes,
  }
}

function stepType(step: unknown): string | undefined {
  if (!step || typeof step !== "object") {
    return undefined
  }

  const candidate = step as Record<string, unknown>
  for (const key of ["step", "type", "command", "name"]) {
    if (typeof candidate[key] === "string") {
      return candidate[key]
    }
  }

  return undefined
}

function errorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    }
  }

  return { message: String(error) }
}

export interface PlaygroundWordPressArchiveCacheValidation {
  version: string
  sourceUrl: string
  source: "pre-resolved" | "cache" | "inferred" | "api"
  cache?: {
    status: "hit" | "downloaded"
    archivePath: string
    lockPath: string
    waitedMs: number
  }
  invalidArchives: Array<{
    path: string
    size: number
    reason: string
    deleted: boolean
  }>
}

export interface PlaygroundWordPressArchiveCacheValidationOptions {
  deleteInvalid?: boolean
}

export async function validatePlaygroundWordPressArchiveCache(versionQuery: string | undefined, cacheDirectory = defaultPlaygroundWordPressArchiveCacheDirectory(), options: PlaygroundWordPressArchiveCacheValidationOptions = { deleteInvalid: true }): Promise<PlaygroundWordPressArchiveCacheValidation> {
  const release = await resolveWordPressReleaseForStartup(versionQuery)
  const version = release.version
  const sourceUrl = release.releaseUrl
  const archivePaths = [
    join(cacheDirectory, `${version}.zip`),
    join(cacheDirectory, `prebuilt-wp-content-for-wp-${version}.zip`),
  ]
  const invalidArchives: PlaygroundWordPressArchiveCacheValidation["invalidArchives"] = []

  for (const archivePath of archivePaths) {
    if (!existsSync(archivePath)) {
      continue
    }

    const archiveStat = await stat(archivePath)
    const reason = await invalidZipReason(archivePath, archiveStat.size)
    if (!reason) {
      continue
    }

    if (!options.deleteInvalid) {
      invalidArchives.push({ path: archivePath, size: archiveStat.size, reason, deleted: false })
      continue
    }

    try {
      await unlink(archivePath)
      invalidArchives.push({ path: archivePath, size: archiveStat.size, reason, deleted: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Corrupt cached WordPress archive could not be removed: ${archivePath} (size: ${archiveStat.size} bytes, requested WordPress version: ${versionQuery ?? "latest"}, resolved WordPress version: ${version}, source URL: ${sourceUrl}, validation: ${reason}, unlink error: ${message})`)
    }
  }

  return { version, sourceUrl, source: release.source, invalidArchives }
}

interface PlaygroundWordPressStartupAsset {
  wp: string | undefined
  localPath?: string
  cacheValidation: PlaygroundWordPressArchiveCacheValidation
}

interface ResolvedWordPressReleaseForStartup {
  version: string
  releaseUrl: string
  source: PlaygroundWordPressArchiveCacheValidation["source"]
}

type WordPressReleaseResolver = typeof resolveWordPressRelease

export async function resolvePlaygroundWordPressStartupAsset(versionQuery: string | undefined, wordpressZip?: string, cacheDirectory = defaultPlaygroundWordPressArchiveCacheDirectory()): Promise<PlaygroundWordPressStartupAsset> {
  if (wordpressZip) {
    const version = startupAssetVersion(versionQuery, wordpressZip)
    const cacheValidation = await validateWordPressArchivePaths(version, wordpressZip, isHttpUrl(wordpressZip) ? [] : [wordpressZip], { deleteInvalid: false })
    return { wp: isHttpUrl(wordpressZip) ? wordpressZip : undefined, localPath: isHttpUrl(wordpressZip) ? undefined : wordpressZip, cacheValidation: { ...cacheValidation, sourceUrl: wordpressZip, source: "pre-resolved" } }
  }

  const release = await resolveWordPressReleaseForStartup(versionQuery, cacheDirectory)
  return await withPlaygroundArchiveCacheLock(cacheDirectory, release.version, async (lock) => {
    const cachedArchivePath = join(cacheDirectory, `${release.version}.zip`)
    const archivePaths = [cachedArchivePath, join(cacheDirectory, `prebuilt-wp-content-for-wp-${release.version}.zip`)]
    const cacheValidation = await validateWordPressArchivePaths(release.version, release.releaseUrl, archivePaths, { deleteInvalid: true })
    if (existsSync(cachedArchivePath)) {
      return {
        wp: undefined,
        localPath: cachedArchivePath,
        cacheValidation: {
          ...cacheValidation,
          source: "cache",
          cache: { status: "hit", archivePath: cachedArchivePath, lockPath: lock.path, waitedMs: lock.waitedMs },
        },
      }
    }

    await downloadWordPressArchiveToCache(release.releaseUrl, cachedArchivePath)
    const downloadedValidation = await validateWordPressArchivePaths(release.version, release.releaseUrl, [cachedArchivePath], { deleteInvalid: false })
    const invalidDownloadedArchive = downloadedValidation.invalidArchives[0]
    if (invalidDownloadedArchive) {
      throw new PlaygroundStartupAssetError("wordpress-archive-cache", release.releaseUrl, versionQuery ?? "latest", new Error(`Downloaded WordPress archive is invalid: ${invalidDownloadedArchive.reason}`))
    }

    return {
      wp: undefined,
      localPath: cachedArchivePath,
      cacheValidation: {
        ...downloadedValidation,
        invalidArchives: [...cacheValidation.invalidArchives, ...downloadedValidation.invalidArchives],
        source: release.source,
        cache: { status: "downloaded", archivePath: cachedArchivePath, lockPath: lock.path, waitedMs: lock.waitedMs },
      },
    }
  })
}

function defaultPlaygroundWordPressArchiveCacheDirectory(): string {
  return process.env[PLAYGROUND_WORDPRESS_CACHE_DIRECTORY_ENV] || join(homedir(), ".wordpress-playground")
}

interface PlaygroundArchiveCacheLock {
  path: string
  waitedMs: number
}

async function withPlaygroundArchiveCacheLock<T>(cacheDirectory: string, version: string, callback: (lock: PlaygroundArchiveCacheLock) => Promise<T>): Promise<T> {
  await mkdir(cacheDirectory, { recursive: true })
  const lockPath = join(cacheDirectory, `${version}.zip.lock`)
  const startedAt = Date.now()

  for (;;) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if (!errorHasCode(error, "EEXIST")) {
        throw error
      }
      if (Date.now() - startedAt > 120_000) {
        throw new PlaygroundStartupAssetError("wordpress-archive-cache-lock", lockPath, version, new Error("Timed out waiting for WordPress archive cache lock"))
      }
      await delay(100)
    }
  }

  try {
    return await callback({ path: lockPath, waitedMs: Date.now() - startedAt })
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function downloadWordPressArchiveToCache(sourceUrl: string, archivePath: string): Promise<void> {
  const tempPath = `${archivePath}.${process.pid}.${Date.now()}.partial`
  try {
    const response = await fetch(sourceUrl)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
    }
    const archive = new Uint8Array(await response.arrayBuffer())
    const reason = await invalidZipBufferReason(archive)
    if (reason) {
      throw new Error(`Downloaded WordPress archive is invalid: ${reason}`)
    }
    await writeFile(tempPath, archive, { flag: "wx" })
    await rename(tempPath, archivePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw new PlaygroundStartupAssetError("wordpress-archive-cache", sourceUrl, basename(archivePath, ".zip"), error)
  }
}

export async function resolveWordPressReleaseForStartup(versionQuery: string | undefined, cacheDirectory = defaultPlaygroundWordPressArchiveCacheDirectory(), resolver: WordPressReleaseResolver = resolveWordPressRelease): Promise<ResolvedWordPressReleaseForStartup> {
  const exactVersion = exactWordPressVersion(versionQuery)
  if (exactVersion) {
    return {
      version: exactVersion,
      releaseUrl: `https://wordpress.org/wordpress-${exactVersion}.zip`,
      source: "inferred",
    }
  }

  try {
    const release = await resolver(versionQuery)
    const resolved = {
      version: String(release.version),
      releaseUrl: String(release.releaseUrl),
      source: release.source === "api" ? "api" : "inferred",
    } satisfies ResolvedWordPressReleaseForStartup
    await writeCachedWordPressRelease(versionQuery, cacheDirectory, resolved)
    return resolved
  } catch (error) {
    const cachedRelease = await readCachedWordPressRelease(versionQuery, cacheDirectory)
    if (cachedRelease) {
      return cachedRelease
    }
    throw new PlaygroundStartupAssetError("wordpress-release-metadata", "https://api.wordpress.org/core/version-check/1.7/?channel=beta", versionQuery ?? "latest", error)
  }
}

async function writeCachedWordPressRelease(versionQuery: string | undefined, cacheDirectory: string, release: ResolvedWordPressReleaseForStartup): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true })
  await writeFile(wordPressReleaseMetadataCachePath(versionQuery, cacheDirectory), `${JSON.stringify({
    schema: "wp-codebox/wordpress-release-metadata-cache/v1",
    query: versionQuery || "latest",
    version: release.version,
    releaseUrl: release.releaseUrl,
    source: release.source,
    cachedAt: new Date().toISOString(),
  }, null, 2)}\n`)
}

async function readCachedWordPressRelease(versionQuery: string | undefined, cacheDirectory: string): Promise<ResolvedWordPressReleaseForStartup | undefined> {
  try {
    const cached = JSON.parse(await readFile(wordPressReleaseMetadataCachePath(versionQuery, cacheDirectory), "utf8"))
    if (cached?.schema !== "wp-codebox/wordpress-release-metadata-cache/v1") {
      return undefined
    }
    if (!exactWordPressVersion(cached.version) || typeof cached.releaseUrl !== "string" || !isHttpUrl(cached.releaseUrl)) {
      return undefined
    }
    return {
      version: cached.version,
      releaseUrl: cached.releaseUrl,
      source: "cache",
    }
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return undefined
    }
    return undefined
  }
}

function wordPressReleaseMetadataCachePath(versionQuery: string | undefined, cacheDirectory: string): string {
  const query = (versionQuery || "latest").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "latest"
  return join(cacheDirectory, `wordpress-release-metadata-${query}.json`)
}

async function validateWordPressArchivePaths(version: string, sourceUrl: string, archivePaths: string[], options: PlaygroundWordPressArchiveCacheValidationOptions): Promise<PlaygroundWordPressArchiveCacheValidation> {
  const invalidArchives: PlaygroundWordPressArchiveCacheValidation["invalidArchives"] = []

  for (const archivePath of archivePaths) {
    if (!existsSync(archivePath)) {
      continue
    }

    const archiveStat = await stat(archivePath)
    const reason = await invalidZipReason(archivePath, archiveStat.size)
    if (!reason) {
      continue
    }

    if (!options.deleteInvalid) {
      invalidArchives.push({ path: archivePath, size: archiveStat.size, reason, deleted: false })
      continue
    }

    try {
      await unlink(archivePath)
      invalidArchives.push({ path: archivePath, size: archiveStat.size, reason, deleted: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Corrupt cached WordPress archive could not be removed: ${archivePath} (size: ${archiveStat.size} bytes, requested WordPress version: ${version}, resolved WordPress version: ${version}, source URL: ${sourceUrl}, validation: ${reason}, unlink error: ${message})`)
    }
  }

  return { version, sourceUrl, source: "inferred", invalidArchives }
}

class PlaygroundStartupAssetError extends Error {
  readonly code = "wp-codebox-playground-startup-asset-unavailable"
  readonly phase = "preview:loading-wordpress"
  readonly asset: string
  readonly sourceUrl: string
  readonly requestedVersion: string

  constructor(asset: string, sourceUrl: string, requestedVersion: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`Unable to resolve Playground startup asset ${asset} for WordPress ${requestedVersion} from ${sourceUrl}: ${message}`, { cause })
    this.name = "PlaygroundStartupAssetError"
    this.asset = asset
    this.sourceUrl = sourceUrl
    this.requestedVersion = requestedVersion
  }
}

async function serveLocalStartupAsset(assetPath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer(async (_request, response) => {
    try {
      const contents = await readFile(assetPath)
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(contents.byteLength),
      })
      response.end(contents)
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end(error instanceof Error ? error.message : String(error))
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => resolveListen())
  })

  const address = server.address()
  if (!address || typeof address !== "object") {
    await closeHttpServer(server)
    throw new Error(`Unable to serve local Playground startup asset: ${assetPath}`)
  }

  return {
    url: `http://127.0.0.1:${address.port}/${encodeURIComponent(basename(assetPath))}`,
    close: () => closeHttpServer(server),
  }
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}

function startupAssetVersion(versionQuery: string | undefined, wordpressZip: string): string {
  return exactWordPressVersion(versionQuery) ?? `pre-resolved-${basename(wordpressZip).replace(/[^A-Za-z0-9_.-]+/g, "-")}`
}

function exactWordPressVersion(versionQuery: string | undefined): string | undefined {
  if (!versionQuery || !/^\d+\.\d+(?:\.\d+)?$/.test(versionQuery)) {
    return undefined
  }

  return versionQuery.endsWith(".0") ? versionQuery.split(".").slice(0, 2).join(".") : versionQuery
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

async function invalidZipReason(archivePath: string, size: number): Promise<string | undefined> {
  if (size < 22) {
    return "too small to be a zip archive"
  }

  const header = await readFile(archivePath, { encoding: null, flag: "r" }).then((buffer) => buffer.subarray(0, 4))
  return invalidZipHeaderReason(header)
}

async function invalidZipBufferReason(buffer: Uint8Array): Promise<string | undefined> {
  if (buffer.byteLength < 22) {
    return "too small to be a zip archive"
  }

  return invalidZipHeaderReason(buffer.subarray(0, 4))
}

function invalidZipHeaderReason(header: Uint8Array): string | undefined {
  if (header.length < 4) {
    return "missing zip header"
  }

  if (header[0] !== 0x50 || header[1] !== 0x4b) {
    return `unexpected zip header ${Buffer.from(header).toString("hex")}`
  }

  if (![0x03, 0x05, 0x07].includes(header[2])) {
    return `unexpected zip header ${Buffer.from(header).toString("hex")}`
  }

  return undefined
}

async function availablePlaygroundPortRange(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(49152, 65000)
    if (await portRangeAvailable(port, 8)) {
      return port
    }
  }

  return 0
}

async function portRangeAvailable(startPort: number, size: number): Promise<boolean> {
  for (let offset = 0; offset < size; offset++) {
    if (!await portAvailable(startPort + offset)) {
      return false
    }
  }

  return true
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createNetServer()
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(port, "127.0.0.1", () => resolveListen())
    })
    return true
  } catch (error) {
    if (errorHasCode(error, "EADDRINUSE")) {
      return false
    }

    throw error
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  }
}

async function runPlaygroundCliWithoutProcessExit<T>(callback: () => Promise<T>): Promise<T> {
  const exit = process.exit
  const outputCapture = capturePlaygroundCliProcessOutput()
  const activeHandles = activeProcessHandles()
  process.exit = ((code?: string | number | null | undefined): never => {
    const exitCode = typeof code === "number" ? code : 1
    throw new PlaygroundCliExitError(exitCode, outputCapture.output())
  }) as typeof process.exit

  try {
    return await callback()
  } catch (error) {
    await disposeNewProcessHandles(activeHandles)
    throw error
  } finally {
    outputCapture.dispose()
    process.exit = exit
  }
}

function capturePlaygroundCliProcessOutput(maxBytes = 32_768): { output: () => PlaygroundCliBufferedOutput | undefined; dispose: () => void } {
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let truncated = false

  const capture = (chunks: Buffer[], currentBytes: number, chunk: string | Uint8Array): number => {
    if (currentBytes >= maxBytes) {
      truncated = true
      return currentBytes
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = maxBytes - currentBytes
    if (buffer.byteLength > remaining) {
      chunks.push(buffer.subarray(0, remaining))
      truncated = true
      return maxBytes
    }

    chunks.push(buffer)
    return currentBytes + buffer.byteLength
  }

  const acknowledgeWrite = (encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): true => {
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }

    return true
  }

  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdoutBytes = capture(stdout, stdoutBytes, chunk)
    return acknowledgeWrite(encodingOrCallback, callback)
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stderrBytes = capture(stderr, stderrBytes, chunk)
    return acknowledgeWrite(encodingOrCallback, callback)
  }) as typeof process.stderr.write

  return {
    output: () => {
      const output: PlaygroundCliBufferedOutput = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(truncated ? { truncated } : {}),
      }
      return output.stdout || output.stderr || output.truncated ? output : undefined
    },
    dispose: () => {
      process.stdout.write = stdoutWrite as typeof process.stdout.write
      process.stderr.write = stderrWrite as typeof process.stderr.write
    },
  }
}

function activeProcessHandles(): Set<unknown> {
  const getActiveHandles = (process as typeof process & { _getActiveHandles?: () => unknown[] })._getActiveHandles
  return new Set(getActiveHandles ? getActiveHandles.call(process) : [])
}

async function disposeNewProcessHandles(before: Set<unknown>): Promise<void> {
  const handles = [...activeProcessHandles()].filter((handle) => !before.has(handle))
  await Promise.all(handles.map(disposeProcessHandle))
}

async function disposeProcessHandle(handle: unknown): Promise<void> {
  const candidate = handle as {
    close?: (callback?: (error?: Error) => void) => unknown
    destroy?: () => unknown
    unref?: () => unknown
  }

  try {
    if (typeof candidate.close === "function") {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (!settled) {
            settled = true
            resolve()
          }
        }
        const result = candidate.close?.(finish)
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).then(finish, finish)
        }
        setTimeout(finish, 1000).unref()
      })
      return
    }

    if (typeof candidate.destroy === "function") {
      candidate.destroy()
    }

    if (typeof candidate.unref === "function") {
      candidate.unref()
    }
  } catch {
    // The original Playground boot failure is the actionable error.
  }
}
