import { createHash } from "node:crypto"
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { compileSourcePackage, composerManagedHostCommandConfig, composerManagedHostEnv, sourcePackagePathAllowed, type WorkspaceRecipeSourcePackage } from "@automattic/wp-codebox-core"
import type { MountSpec, WorkspaceRecipe, WorkspaceRecipeDependencyOverlay, WorkspaceRecipeExtraPlugin, WorkspaceRecipeRuntimeOverlay, WorkspaceRecipeStagedFile, WorkspaceRecipeWorkspace, WorkspaceRecipeWorkspacePreload, WorkspaceRecipeWorkspacePreloadRepository } from "@automattic/wp-codebox-core"
import { executeManagedHostCommand, resolvePluginEntrypointContract } from "@automattic/wp-codebox-core"
import { collectPreparedSourceCleanupPaths, DEFAULT_PREPARED_SOURCE_EXCLUDE_NAMES, localPreparedSourceProvenance, prepareLocalSourceStageSync, SANDBOX_WORKSPACE_ROOT, type PreparedSourceProvenance } from "@automattic/wp-codebox-core/internals"
import { registerRuntimeOverlayDescriptor, runtimeOverlayDescriptor } from "./runtime-overlay-registry.js"
import { evaluateSourcePolicy, sourcePolicySnapshot, type SourcePolicyIssue } from "./source-policy.js"
import { prepareZipSource } from "./zip-source.js"

export { ALLOW_NETWORK_DOWNLOADS_ENV, ALLOWED_DOWNLOAD_HOSTS_ENV, allowedDownloadHosts, isSha256, maxDownloadBytes, maxExtractedBytes, maxExtractedFiles, MAX_DOWNLOAD_BYTES_ENV, MAX_EXTRACTED_BYTES_ENV, MAX_EXTRACTED_FILES_ENV, REQUIRE_SOURCE_SHA256_ENV, sourceSha256Required } from "./source-policy.js"

const PHP_AI_CLIENT_RUNTIME_OVERLAY_TARGET = "/wordpress/wp-includes/php-ai-client"
const PHP_SCOPER_DOWNLOAD_ATTEMPTS = 3
const PHP_SCOPER_DOWNLOAD_TIMEOUT_MS = 120_000

export interface PreparedWorkspaceMount {
  source: string
  target: string
  mode: "readonly" | "readwrite"
  cleanupPaths: string[]
  metadata: Record<string, unknown>
}

interface PreparedWorkspaceSource {
  source: string
  baselineSource: string
  cleanupPaths: string[]
}

export type RecipeSourceType = "local" | "https_zip" | "wporg_plugin_zip"

export interface RecipeSourceProvenance {
  kind: RecipeSourceType
  original: string
  resolvedUrl?: string
  digest?: {
    sha256: string
    expected?: string
    verified?: boolean
  }
  policy?: {
    host: string
    maxDownloadBytes: number
    maxExtractedBytes: number
    maxExtractedFiles: number
    sha256Required: boolean
  }
  localPathCategory?: "recipe-relative" | "temporary-download" | "temporary-composer-autoload"
}

interface PreparedExternalSource {
  source: string
  cleanupPaths: string[]
  provenance: RecipeSourceProvenance
}

export interface PreparedExtraPlugin {
  source: string
  slug: string
  target: string
  pluginFile: string
  activate: boolean
  loadAs: "plugin" | "mu-plugin"
  cleanupPaths: string[]
  provenance: RecipeSourceProvenance
  metadata?: Record<string, unknown>
}

type BootActivePluginCandidate = Pick<PreparedExtraPlugin, "pluginFile" | "activate" | "loadAs">

export type RecipeStagedFileProvenance = PreparedSourceProvenance

export interface PreparedStagedFile {
  source: string
  originalSource: string
  sourceRef: string
  target: string
  type: MountSpec["type"]
  cleanupPaths: string[]
  provenance: RecipeStagedFileProvenance
  metadata: Record<string, unknown>
}

export interface SourcePackageProvenance {
  schema: "wp-codebox/source-package-provenance/v1"
  name: string
  source: RecipeStagedFileProvenance
  target: string
  allow: string[]
  deny: string[]
  digest: { sha256: string }
  materializedAt: string
}

export interface PreparedRuntimeOverlay {
  source: string
  target: string
  type: "directory"
  mode: "readonly"
  cleanupPaths: string[]
  metadata: Record<string, unknown>
}

export interface PreparedDependencyOverlay {
  source: string
  sourceRef: string
  target: string
  package: string
  consumer: string
  type: "directory"
  mode: "readonly"
  cleanupPaths: string[]
  metadata: Record<string, unknown>
}

export interface ParsedRecipeSource {
  type: RecipeSourceType
  resolvedUrl: string
  host: string
  expectedSha256?: string
  wporgSlug?: string
}

const PHP_SCOPER_VERSION = "0.18.17"
const PHP_SCOPER_URL = `https://github.com/humbug/php-scoper/releases/download/${PHP_SCOPER_VERSION}/php-scoper.phar`

export type RecipeSourcePolicyIssue = SourcePolicyIssue
export const evaluateRecipeSourcePolicy = evaluateSourcePolicy

function normalizedWorkspaceSeedExcludePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
}

function workspaceSeedExcludeMatches(relativePath: string, excludePath: string): boolean {
  const normalizedRelativePath = normalizedWorkspaceSeedExcludePath(relativePath)
  const normalizedExcludePath = normalizedWorkspaceSeedExcludePath(excludePath)
  if (!normalizedExcludePath) {
    return false
  }

  if (normalizedExcludePath.endsWith("*")) {
    return normalizedRelativePath.startsWith(normalizedExcludePath.slice(0, -1))
  }

  return normalizedRelativePath === normalizedExcludePath || normalizedRelativePath.startsWith(`${normalizedExcludePath}/`)
}

function shouldCopyWorkspaceSeedEntry(sourceRoot: string, entry: string, excludePaths: string[] = []): boolean {
  const relativePath = relative(sourceRoot, entry)
  if (!relativePath) {
    return true
  }

  return !excludePaths.some((excludePath) => workspaceSeedExcludeMatches(relativePath, excludePath))
}

async function copyWorkspaceSeedDirectory(source: string, target: string, excludePaths: string[] = []): Promise<void> {
  await cp(source, target, {
    recursive: true,
    filter: (entry) => shouldCopyWorkspaceSeedEntry(source, entry, excludePaths),
  })
}

export async function prepareRecipeWorkspaces(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedWorkspaceMount[]> {
  const workspaces = recipe.inputs?.workspaces ?? []
  const mounts: PreparedWorkspaceMount[] = []
  for (const [index, workspace] of workspaces.entries()) {
    const slug = workspace.seed.slug ?? basename(resolve(recipeDirectory, workspace.seed.source ?? `workspace-${index}`))
    const prepared = await prepareRecipeWorkspace(workspace, recipeDirectory, slug)
    const target = workspace.target ?? defaultWorkspaceTarget(workspace, slug)
    mounts.push({
      source: prepared.source,
      target,
      mode: workspace.mode ?? "readwrite",
      cleanupPaths: prepared.cleanupPaths,
      metadata: {
        kind: "recipe-workspace",
        index,
        seed: workspace.seed,
        baselineSource: prepared.baselineSource,
        target,
        workspaceRoot: SANDBOX_WORKSPACE_ROOT,
        sourceMode: workspace.sourceMode ?? "repo-backed",
      },
    })
  }

  return mounts
}

export async function prepareRecipeWorkspacePreloads(recipe: WorkspaceRecipe): Promise<PreparedWorkspaceMount[]> {
  const preloads = recipe.inputs?.workspace_preloads ?? []
  const mounts: PreparedWorkspaceMount[] = []
  for (const [preloadIndex, preload] of preloads.entries()) {
    for (const [repositoryIndex, repository] of preload.payload.repositories.entries()) {
      mounts.push(await prepareWorkspacePreloadRepository(preload, repository, preloadIndex, repositoryIndex))
    }
  }

  return mounts
}

async function prepareWorkspacePreloadRepository(preload: WorkspaceRecipeWorkspacePreload, repository: WorkspaceRecipeWorkspacePreloadRepository, preloadIndex: number, repositoryIndex: number): Promise<PreparedWorkspaceMount> {
  if (!/^[a-z0-9-]+$/.test(repository.name)) {
    throw new Error(`Workspace preload repository name must be a slug: ${repository.name}`)
  }
  if (!workspacePreloadRepositoryUrlAllowed(repository.url)) {
    throw new Error(`Workspace preload repository url must be an HTTPS or SSH Git URL: ${repository.url}`)
  }

  const root = await mkdtemp(join(tmpdir(), `wp-codebox-workspace-preload-${repository.name}-`))
  const source = join(root, repository.name)
  try {
    await executeManagedHostCommand({ command: "git", args: ["clone", "--quiet", repository.url, source], cwd: root, allowedCwdRoots: [root], label: "clone workspace preload repository" })
    if (repository.ref) {
      await executeManagedHostCommand({ command: "git", args: ["checkout", "--quiet", repository.ref], cwd: source, allowedCwdRoots: [root], label: "checkout workspace preload repository ref" })
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  return {
    source,
    target: `${SANDBOX_WORKSPACE_ROOT}/${repository.name}`,
    mode: "readwrite",
    cleanupPaths: [root],
    metadata: {
      kind: "workspace-preload",
      sourceMode: "repo-backed",
      mountRole: "workspace-preload",
      workspaceRef: repository.name,
      repo: repository.url,
      gitRef: repository.ref,
      preload: {
        type: preload.type,
        slug: preload.slug,
        source: preload.source,
        schema: preload.payload.schema,
        provenance: preload.provenance,
      },
      artifactRef: {
        type: preload.type,
        slug: preload.slug,
        source: preload.source,
        preloadIndex,
        repositoryIndex,
      },
    },
  }
}

function workspacePreloadRepositoryUrlAllowed(url: string): boolean {
  return url.startsWith("https://") || /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+\.git$/.test(url)
}

async function cleanupRecipeWorkspaces(workspaces: PreparedWorkspaceMount[]): Promise<void> {
  await Promise.all(workspaces.flatMap((workspace) => workspace.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })))
}

export async function cleanupRecipePreparedSources(workspaces: PreparedWorkspaceMount[], extraPlugins: PreparedExtraPlugin[], stagedFiles: PreparedStagedFile[] = [], overlays: PreparedRuntimeOverlay[] = [], dependencyOverlays: PreparedDependencyOverlay[] = []): Promise<void> {
  const cleanupPaths = collectPreparedSourceCleanupPaths(extraPlugins, stagedFiles, overlays, dependencyOverlays)
  await Promise.all([cleanupRecipeWorkspaces(workspaces), ...cleanupPaths.map((path) => rm(path, { recursive: true, force: true }))])
}

export async function prepareRecipeExtraPlugins(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedExtraPlugin[]> {
  const plugins: PreparedExtraPlugin[] = []
  for (const plugin of recipeExtraPlugins(recipe)) {
    const slug = recipeExtraPluginSlug(plugin)
    const resolved = await prepareRecipeSource(plugin.source, recipeDirectory, slug, plugin.sha256)
    const pluginFile = await resolveRecipeExtraPluginFile(plugin, recipeDirectory)
    const loadAs = plugin.loadAs ?? "plugin"
    const prepared = await prepareComposerAutoloadForPlugin(resolved, slug, plugin.source)
    await assertPreparedPluginFileExists(prepared.source, pluginFile.slice(slug.length + 1), plugin.source)
    plugins.push({
      source: prepared.source,
      slug,
      target: pluginTarget(slug, loadAs),
      pluginFile,
      activate: plugin.activate !== false,
      loadAs,
      cleanupPaths: prepared.cleanupPaths,
      provenance: prepared.provenance,
      metadata: plugin.metadata ?? {},
    })
  }

  return plugins
}

async function prepareComposerAutoloadForPlugin(prepared: PreparedExternalSource, slug: string, sourceRef: string): Promise<PreparedExternalSource> {
  if (prepared.provenance.kind !== "local") {
    return prepared
  }

  try {
    const composerJson = await stat(join(prepared.source, "composer.json"))
    if (!composerJson.isFile()) {
      return prepared
    }
  } catch {
    return prepared
  }

  try {
    const autoload = await stat(join(prepared.source, "vendor", "autoload.php"))
    if (autoload.isFile()) {
      return prepared
    }
  } catch {
    // Prepare a temporary copy below.
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), `wp-codebox-plugin-${slug}-`))
  const stagedSource = join(stagingRoot, slug)
  await cp(prepared.source, stagedSource, { recursive: true })
  try {
    await executeManagedHostCommand({
      ...composerManagedHostCommandConfig({
        cwd: stagedSource,
        allowedCwdRoots: [stagingRoot],
        label: "prepare Composer autoload for recipe extra plugin",
      }),
      cwd: stagedSource,
    })
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    const detail = error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim() ? error.stderr.trim() : error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe extra plugin source requires Composer autoload but could not be prepared: ${sourceRef}: ${detail}`)
  }

  return {
    ...prepared,
    source: stagedSource,
    cleanupPaths: [...prepared.cleanupPaths, stagingRoot],
    provenance: {
      ...prepared.provenance,
      localPathCategory: "temporary-composer-autoload",
    },
  }
}

export async function prepareRecipeDependencyOverlays(recipe: WorkspaceRecipe, recipeDirectory: string, extraPlugins: PreparedExtraPlugin[]): Promise<PreparedDependencyOverlay[]> {
  const overlays: PreparedDependencyOverlay[] = []
  for (const [index, overlay] of (recipe.inputs?.dependency_overlays ?? []).entries()) {
    overlays.push(await prepareRecipeDependencyOverlay(overlay, recipeDirectory, extraPlugins, index))
  }

  return overlays
}

async function prepareRecipeDependencyOverlay(overlay: WorkspaceRecipeDependencyOverlay, recipeDirectory: string, extraPlugins: PreparedExtraPlugin[], index: number): Promise<PreparedDependencyOverlay> {
  if (overlay.kind !== "composer-package") {
    throw new Error(`Unsupported dependency overlay kind: ${overlay.kind}`)
  }
  if (!isComposerPackageName(overlay.package)) {
    throw new Error(`Dependency overlay package must be a safe Composer package name: ${overlay.package}`)
  }

  const consumer = extraPlugins.find((plugin) => plugin.slug === overlay.consumer)
  if (!consumer) {
    throw new Error(`Dependency overlay consumer plugin was not found in inputs.extra_plugins: ${overlay.consumer}`)
  }

  const source = resolve(recipeDirectory, overlay.source)
  await validateExistingDirectoryForOverlay(source, overlay.source)
  const stagingRoot = await mkdtemp(join(tmpdir(), "wp-codebox-dependency-overlay-"))
  const preparedSource = await prepareComposerBackedSource(source, stagingRoot, `dependency overlay ${overlay.package}`)
  const target = `${consumer.target}/vendor/${composerPackageVendorPath(overlay.package)}`
  const digest = await directoryContentDigest(preparedSource)

  return {
    source: preparedSource,
    sourceRef: overlay.source,
    target,
    package: overlay.package,
    consumer: overlay.consumer,
    type: "directory",
    mode: "readonly",
    cleanupPaths: [stagingRoot],
    metadata: {
      kind: "dependency-overlay",
      index,
      overlayKind: overlay.kind,
      package: overlay.package,
      source: overlay.source,
      consumer: overlay.consumer,
      target,
      digest: { sha256: digest },
      ...(overlay.metadata ? { userMetadata: overlay.metadata } : {}),
    },
  }
}

export async function prepareRecipeStagedFiles(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedStagedFile[]> {
  const stagedFiles: PreparedStagedFile[] = []
  for (const [index, stagedFile] of (recipe.inputs?.stagedFiles ?? []).entries()) {
    const originalSource = resolve(recipeDirectory, stagedFile.source)
    const type = await stagedFileMountType(originalSource)
    const stagingRoot = await mkdtemp(join(tmpdir(), "wp-codebox-staged-file-"))
    const staged = prepareLocalSourceStageSync({
      source: originalSource,
      sourceRef: stagedFile.source,
      targetRoot: stagingRoot,
      recipeDirectory,
      excludeNames: [],
    })
    const provenance = stagedFileProvenance(stagedFile, recipeDirectory)
    stagedFiles.push({
      source: staged.source,
      originalSource,
      sourceRef: stagedFile.source,
      target: stagedFile.target,
      type,
      cleanupPaths: staged.cleanupPaths,
      provenance,
      metadata: {
        kind: "staged-file",
        index,
        source: provenance,
      },
    })
  }

  for (const [index, sourcePackage] of (recipe.inputs?.sourcePackages ?? []).entries()) {
    stagedFiles.push(await prepareRecipeSourcePackage(sourcePackage, recipeDirectory, index))
  }

  return stagedFiles
}

async function prepareRecipeSourcePackage(sourcePackage: WorkspaceRecipeSourcePackage, recipeDirectory: string, index: number): Promise<PreparedStagedFile> {
  const compiled = compileSourcePackage(sourcePackage)
  const originalSource = resolve(recipeDirectory, sourcePackage.source)
  const sourceStat = await stat(originalSource)
  if (!sourceStat.isDirectory()) {
    throw new Error(`Recipe sourcePackages entries must point to directories: ${sourcePackage.source}`)
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), "wp-codebox-source-package-"))
  const stagedSource = join(stagingRoot, compiled.name)
  await copySourcePackageDirectory(originalSource, stagedSource, sourcePackage.allow ?? [], sourcePackage.deny ?? [])
  const digest = await directoryContentDigest(stagedSource)
  const provenance = localPreparedSourceProvenance(sourcePackage.source, recipeDirectory)
  const provenancePayload: SourcePackageProvenance = {
    schema: "wp-codebox/source-package-provenance/v1",
    name: compiled.name,
    source: provenance,
    target: compiled.stagedFile.target,
    allow: sourcePackage.allow ?? [],
    deny: sourcePackage.deny ?? [],
    digest: { sha256: digest },
    materializedAt: new Date().toISOString(),
  }
  await writeFile(join(stagedSource, ".wp-codebox-source-package.json"), `${JSON.stringify(provenancePayload, null, 2)}\n`)

  return {
    source: stagedSource,
    originalSource,
    sourceRef: sourcePackage.source,
    target: compiled.stagedFile.target,
    type: "directory",
    cleanupPaths: [stagingRoot],
    provenance,
    metadata: {
      kind: "source-package",
      index,
      name: compiled.name,
      target: compiled.stagedFile.target,
      source: provenance,
      filters: { allow: sourcePackage.allow ?? [], deny: sourcePackage.deny ?? [] },
      digest: { sha256: digest },
      provenanceFile: ".wp-codebox-source-package.json",
      ...(sourcePackage.metadata ? { userMetadata: sourcePackage.metadata } : {}),
    },
  }
}

async function copySourcePackageDirectory(sourceRoot: string, targetRoot: string, allow: string[], deny: string[]): Promise<void> {
  const excludedNames = new Set(DEFAULT_PREPARED_SOURCE_EXCLUDE_NAMES)
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (entry) => {
      const relativePath = relative(sourceRoot, entry).replace(/\\/g, "/")
      if (!relativePath) {
        return true
      }
      if (excludedNames.has(basename(entry))) {
        return false
      }
      return sourcePackagePathAllowed(relativePath, allow, deny)
    },
  })
}

export async function prepareRecipeRuntimeOverlays(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedRuntimeOverlay[]> {
  const overlays: PreparedRuntimeOverlay[] = []
  for (const [index, overlay] of (recipe.runtime?.overlays ?? []).entries()) {
    const descriptor = runtimeOverlayDescriptor(overlay)
    if (!descriptor) {
      throw new Error(`Unsupported runtime overlay: ${overlay.kind}/${overlay.library}/${overlay.strategy}`)
    }

    const prepared = descriptor.prepare
      ? await descriptor.prepare(overlay, recipeDirectory, index)
      : await prepareDeclaredRuntimeOverlayPack(overlay, recipeDirectory, index, descriptor.defaultTarget)
    overlays.push(prepared)
  }

  return overlays
}

async function prepareDeclaredRuntimeOverlayPack(overlay: WorkspaceRecipeRuntimeOverlay, recipeDirectory: string, index: number, defaultTarget: string): Promise<PreparedRuntimeOverlay> {
  const source = resolve(recipeDirectory, overlay.source)
  await validateExistingDirectoryForOverlay(source, overlay.source)
  const target = overlay.target ?? defaultTarget
  const digest = await directoryContentDigest(source)

  return {
    source,
    target,
    type: "directory",
    mode: "readonly",
    cleanupPaths: [],
    metadata: {
      kind: "runtime-overlay",
      index,
      overlayKind: overlay.kind,
      library: overlay.library,
      strategy: overlay.strategy,
      source: overlay.source,
      target,
      preparedPath: source,
      preparedPathKind: "local",
      digest: { sha256: digest },
      ...(overlay.bundle ? { bundle: overlay.bundle } : {}),
      ...(overlay.metadata ? { userMetadata: overlay.metadata } : {}),
    },
  }
}

async function preparePhpAiClientOverlay(overlay: WorkspaceRecipeRuntimeOverlay, recipeDirectory: string, index: number): Promise<PreparedRuntimeOverlay> {
  const source = resolve(recipeDirectory, overlay.source)
  await validateExistingDirectoryForOverlay(source, overlay.source)
  const stagingRoot = await mkdtemp(join(tmpdir(), "wp-codebox-overlay-php-ai-client-"))
  const bundle = join(stagingRoot, "wp-includes", "php-ai-client")
  const srcTarget = join(bundle, "src")
  const thirdPartyTarget = join(bundle, "third-party")
  await mkdir(srcTarget, { recursive: true })
  await mkdir(thirdPartyTarget, { recursive: true })

  const preparedSource = await prepareComposerBackedSource(source, stagingRoot, `runtime overlay ${overlay.kind}/${overlay.library}/${overlay.strategy}`)
  const scopedRoot = await scopePhpAiClientSource(preparedSource, stagingRoot)
  const packages = await composerInstalledPackagesFromSource(preparedSource)
  const namespacePrefixes = dependencyNamespacePrefixes(packages)
  await scopePhpAiClientSourceDependencyReferences(join(scopedRoot, "src"), namespacePrefixes)
  await cp(join(scopedRoot, "src"), srcTarget, { recursive: true })
  await copyScopedComposerDependencies(packages, scopedRoot, thirdPartyTarget)
  await scopePhpAiClientSourceDependencyReferences(thirdPartyTarget, namespacePrefixes)
  await prunePhpAiClientThirdParty(thirdPartyTarget)
  await writePhpAiClientAutoload(bundle)
  const digest = await directoryContentDigest(bundle)

  return {
    source: bundle,
    target: overlay.target ?? PHP_AI_CLIENT_RUNTIME_OVERLAY_TARGET,
    type: "directory",
    mode: "readonly",
    cleanupPaths: [stagingRoot],
    metadata: {
      kind: "runtime-overlay",
      index,
      overlayKind: overlay.kind,
      library: overlay.library,
      strategy: overlay.strategy,
      source: overlay.source,
      target: overlay.target ?? PHP_AI_CLIENT_RUNTIME_OVERLAY_TARGET,
      preparedPath: bundle,
      preparedPathKind: "ephemeral",
      digest: { sha256: digest },
      ...(overlay.metadata ? { userMetadata: overlay.metadata } : {}),
    },
  }
}

registerRuntimeOverlayDescriptor({
  kind: "bundled-library",
  library: "php-ai-client",
  strategy: "wordpress-scoped-bundle",
  defaultTarget: PHP_AI_CLIENT_RUNTIME_OVERLAY_TARGET,
  prepare: preparePhpAiClientOverlay,
})

async function prepareComposerBackedSource(source: string, stagingRoot: string, label: string): Promise<string> {
  if (await pathIsDirectory(join(source, "vendor"))) {
    return source
  }

  if (!await pathIsFile(join(source, "composer.json"))) {
    throw new Error(`Composer-backed ${label} source has no vendor directory and no composer.json for dependency hydration: ${source}`)
  }

  const composer = await resolveComposerCommand()
  if (!composer) {
    throw new Error(`Composer-backed ${label} source has no vendor directory, and Composer is not available to hydrate dependencies. Run composer install in ${source}, or install Composer on PATH before running WP Codebox.`)
  }

  const staged = prepareLocalSourceStageSync({
    source,
    targetRoot: stagingRoot,
    targetName: "composer-source",
    cleanupRoot: false,
    excludeNames: ["vendor"],
  })
  const hydratedSource = staged.source

  try {
    await executeManagedHostCommand({
      ...composerManagedHostCommandConfig({
        cwd: hydratedSource,
        allowedCwdRoots: [stagingRoot],
        args: ["install", "--working-dir", hydratedSource, "--no-dev", "--no-interaction", "--no-progress", "--prefer-dist", "--classmap-authoritative"],
        label: `hydrate Composer-backed ${label}`,
      }),
      command: composer,
      cwd: hydratedSource,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Composer-backed ${label} dependency hydration failed for ${source}. Run composer install in that checkout or inspect Composer output. ${message}`)
  }

  if (!await pathIsFile(join(hydratedSource, "vendor", "composer", "installed.json"))) {
    throw new Error(`Composer-backed ${label} dependency hydration completed without vendor/composer/installed.json: ${source}`)
  }

  return hydratedSource
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function resolveComposerCommand(): Promise<string> {
  try {
    await executeManagedHostCommand({ command: "composer", args: ["--version"], cwd: process.cwd(), env: composerManagedHostEnv(), allowedCwdRoots: [process.cwd()], timeoutMs: 10_000, maxOutputBytes: 64 * 1024, label: "detect Composer" })
    return "composer"
  } catch {
    return ""
  }
}

async function validateExistingDirectoryForOverlay(source: string, sourceRef: string): Promise<void> {
  try {
    const result = await stat(source)
    if (result.isDirectory()) {
      return
    }
  } catch {
    // Throw a stable message below.
  }

  throw new Error(`Runtime overlay source must be an existing directory: ${sourceRef}`)
}

async function scopePhpAiClientSource(source: string, stagingRoot: string): Promise<string> {
  const scoperPath = await resolvePhpScoper(stagingRoot)
  const configPath = join(stagingRoot, "scoper.inc.php")
  const scopedRoot = join(stagingRoot, "scoped")
  await writeFile(configPath, phpAiClientScoperConfig())
  await executeManagedHostCommand({
    command: "php",
    args: [scoperPath, "add-prefix", "--working-dir", source, "--config", configPath, "--output-dir", scopedRoot, "--force", "--no-interaction"],
    cwd: stagingRoot,
    allowedCwdRoots: [stagingRoot, source],
    maxOutputBytes: 1024 * 1024 * 10,
    label: "scope PHP source",
  })
  return scopedRoot
}

export async function resolvePhpScoper(stagingRoot: string): Promise<string> {
  const configured = process.env.WP_CODEBOX_PHP_SCOPER_PHAR
  if (configured) {
    return configured
  }

  const cachedPath = phpScoperCachePath()
  if (await pathIsFile(cachedPath)) {
    return cachedPath
  }

  await mkdir(dirname(cachedPath), { recursive: true })
  let lastError: unknown
  for (let attempt = 1; attempt <= PHP_SCOPER_DOWNLOAD_ATTEMPTS; attempt++) {
    if (await pathIsFile(cachedPath)) {
      return cachedPath
    }

    const downloadPath = join(dirname(cachedPath), `php-scoper-${process.pid}-${Date.now()}-${attempt}.phar.tmp`)
    try {
      await executeManagedHostCommand({
        command: "curl",
        args: ["-fsSL", "--retry", "2", "--retry-delay", "2", "--retry-connrefused", "--connect-timeout", "20", PHP_SCOPER_URL, "-o", downloadPath],
        cwd: stagingRoot,
        allowedCwdRoots: [stagingRoot],
        timeoutMs: PHP_SCOPER_DOWNLOAD_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024,
        label: `download php-scoper (attempt ${attempt}/${PHP_SCOPER_DOWNLOAD_ATTEMPTS})`,
      })
      await rename(downloadPath, cachedPath)
      return cachedPath
    } catch (error) {
      lastError = error
      await unlink(downloadPath).catch(() => undefined)
    }
  }

  const stagedFallbackPath = join(stagingRoot, "php-scoper.phar")
  if (await pathIsFile(stagedFallbackPath)) {
    await copyFile(stagedFallbackPath, cachedPath).catch(() => undefined)
    return stagedFallbackPath
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function phpScoperCachePath(): string {
  const cacheRoot = process.env.WP_CODEBOX_PHP_SCOPER_CACHE_DIR
    ?? process.env.WP_CODEBOX_CACHE_DIR
    ?? (process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, "wp-codebox") : undefined)
    ?? (process.env.HOME ? join(process.env.HOME, ".cache", "wp-codebox") : undefined)
    ?? join(tmpdir(), "wp-codebox-cache")

  return join(cacheRoot, "php-scoper", PHP_SCOPER_VERSION, "php-scoper.phar")
}

function phpAiClientScoperConfig(): string {
  return `<?php
use Isolated\\Symfony\\Component\\Finder\\Finder;

return array(
	'prefix' => 'WordPress\\\\AiClientDependencies',
	'finders' => array(
		Finder::create()
			->files()
			->ignoreVCS( true )
			->notName( '/LICENSE|.*\\.md|.*\\.dist|Makefile/' )
			->exclude( array( 'composer', 'doc', 'test', 'test_old', 'tests', 'Tests', 'vendor-bin' ) )
			->in( 'vendor' ),
		Finder::create()
			->files()
			->ignoreVCS( true )
			->name( '*.php' )
			->in( 'src' ),
	),
	'exclude-namespaces' => array(
		'WordPress\\\\AiClient',
	),
	'exclude-files' => array(),
	'exclude-constants' => array(
		'/^ABSPATH$/',
		'/^WPINC$/',
	),
	'exclude-functions' => array(),
	'patchers' => array(
		static function ( string $file_path, string $prefix, string $contents ): string {
			if ( false === strpos( $file_path, 'php-http/discovery' ) ) {
				return $contents;
			}

			$external_namespaces = array(
				'GuzzleHttp',
				'Http\\\\Adapter',
				'Http\\\\Client\\\\Curl',
				'Http\\\\Client\\\\Socket',
				'Http\\\\Client\\\\Buzz',
				'Http\\\\Client\\\\React',
				'Buzz',
				'Nyholm',
				'Laminas',
				'Symfony\\\\Component\\\\HttpClient',
				'Phalcon\\\\Http',
				'Slim\\\\Psr7',
				'Kriswallsmith',
			);

			foreach ( $external_namespaces as $ns ) {
				$escaped_ns     = preg_quote( $ns, '/' );
				$escaped_prefix = preg_quote( $prefix, '/' );
				$contents       = preg_replace( '/([\\'\"])' . $escaped_prefix . '\\\\\\\\' . $escaped_ns . '/', '$1' . $ns, $contents );
				$contents       = preg_replace( '/([\\'\"])' . $escaped_prefix . '\\\\' . $escaped_ns . '/', '$1' . $ns, $contents );
			}

			return $contents;
		},
	),
);
`
}

async function composerInstalledPackagesFromSource(source: string): Promise<ComposerInstalledPackage[]> {
  const installedPath = join(source, "vendor", "composer", "installed.json")
  let installed: unknown
  try {
    installed = JSON.parse(await readFile(installedPath, "utf8"))
  } catch (error) {
    throw new Error(`php-ai-client overlay requires Composer dependencies at vendor/composer/installed.json: ${error instanceof Error ? error.message : String(error)}`)
  }

  return composerInstalledPackages(installed)
}

async function copyScopedComposerDependencies(packages: ComposerInstalledPackage[], scopedRoot: string, thirdPartyTarget: string): Promise<void> {
  for (const pkg of packages) {
    if (pkg.name === "wordpress/php-ai-client") {
      continue
    }
    for (const [namespacePrefix, sourceDirs] of Object.entries(pkg.autoload?.["psr-4"] ?? {})) {
      const namespacePath = namespacePrefix.replace(/\\/g, "/").replace(/\/+$/, "")
      for (const sourceDir of Array.isArray(sourceDirs) ? sourceDirs : [sourceDirs]) {
        const packageSource = join(scopedRoot, "vendor", pkg.name, String(sourceDir).replace(/\/+$/, ""))
        try {
          const result = await stat(packageSource)
          if (!result.isDirectory()) {
            continue
          }
        } catch {
          continue
        }
        await cp(packageSource, join(thirdPartyTarget, namespacePath), { recursive: true })
      }
    }
  }
}

function dependencyNamespacePrefixes(packages: ComposerInstalledPackage[]): string[] {
  const prefixes = new Set<string>()
  for (const pkg of packages) {
    if (pkg.name === "wordpress/php-ai-client") {
      continue
    }
    for (const prefix of Object.keys(pkg.autoload?.["psr-4"] ?? {})) {
      if (prefix && !prefix.startsWith("WordPress\\AiClient\\")) {
        prefixes.add(prefix)
      }
    }
  }
  return [...prefixes].sort((a, b) => b.length - a.length)
}

async function scopePhpAiClientSourceDependencyReferences(sourceDirectory: string, namespacePrefixes: string[]): Promise<void> {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const path = join(sourceDirectory, entry.name)
    if (entry.isDirectory()) {
      await scopePhpAiClientSourceDependencyReferences(path, namespacePrefixes)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".php")) {
      continue
    }
    const original = await readFile(path, "utf8")
    const transformed = scopeNamespaceReferences(original, namespacePrefixes)
    if (transformed !== original) {
      await writeFile(path, transformed)
    }
  }
}

function scopeNamespaceReferences(contents: string, namespacePrefixes: string[]): string {
  let transformed = contents
  for (const namespacePrefix of namespacePrefixes) {
    const normalized = namespacePrefix.replace(/\\+$/, "\\")
    const namespaceName = normalized.replace(/\\+$/, "")
    const scoped = `WordPress\\AiClientDependencies\\${normalized}`
    const scopedNamespaceName = `WordPress\\AiClientDependencies\\${namespaceName}`
    const escaped = escapeRegExp(normalized)
    const escapedNamespaceName = escapeRegExp(namespaceName)
    transformed = transformed
      .replace(new RegExp(`namespace\\s+${escapedNamespaceName}\\s*;`, "g"), `namespace ${scopedNamespaceName};`)
      .replace(new RegExp(`([^A-Za-z0-9_\\\\])\\\\${escaped}`, "g"), (_match, prefix: string) => `${prefix}\\${scoped}`)
      .replace(new RegExp(`([^A-Za-z0-9_\\\\])${escaped}`, "g"), (_match, prefix: string) => `${prefix}${scoped}`)
  }
  return transformed
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface ComposerInstalledPackage {
  name: string
  autoload?: { "psr-4"?: Record<string, string | string[]> }
}

function composerInstalledPackages(installed: unknown): ComposerInstalledPackage[] {
  if (!installed || typeof installed !== "object") {
    throw new Error("Composer installed.json is not an object")
  }
  const data = installed as { packages?: unknown; [key: number]: unknown }
  const packages = Array.isArray(data.packages) ? data.packages : Array.isArray(installed) ? installed : undefined
  if (!packages) {
    throw new Error("Composer installed.json format is unsupported")
  }
  return packages.filter((pkg): pkg is ComposerInstalledPackage => Boolean(pkg && typeof pkg === "object" && typeof (pkg as ComposerInstalledPackage).name === "string"))
}

async function prunePhpAiClientThirdParty(thirdPartyTarget: string): Promise<void> {
  const removePaths = [
    "Http/Discovery/Composer",
    "Http/Client",
    "Http/Promise",
    "Http/Discovery/HttpClientDiscovery.php",
    "Http/Discovery/HttpAsyncClientDiscovery.php",
    "Http/Discovery/MessageFactoryDiscovery.php",
    "Http/Discovery/UriFactoryDiscovery.php",
    "Http/Discovery/StreamFactoryDiscovery.php",
    "Http/Discovery/NotFoundException.php",
    "Http/Discovery/Psr17Factory.php",
    "Http/Discovery/Psr18Client.php",
    "Http/Discovery/Strategy/MockClientStrategy.php",
    "Psr/EventDispatcher/ListenerProviderInterface.php",
    "Psr/EventDispatcher/StoppableEventInterface.php",
    "Psr/SimpleCache/CacheException.php",
    "Psr/SimpleCache/InvalidArgumentException.php",
  ]
  await Promise.all(removePaths.map((path) => rm(join(thirdPartyTarget, path), { recursive: true, force: true })))
}

async function writePhpAiClientAutoload(bundle: string): Promise<void> {
  await writeFile(join(bundle, "autoload.php"), `<?php
/**
 * Autoloader for the bundled PHP AI Client library.
 *
 * Generated by WP Codebox runtime overlay preparation.
 */

spl_autoload_register(
	static function ( $class_name ) {
		$client_prefix     = 'WordPress\\\\AiClient\\\\';
		$client_prefix_len = 19;
		$scoped_prefix     = 'WordPress\\\\AiClientDependencies\\\\';
		$scoped_prefix_len = 31;
		$base_dir          = __DIR__;

		if ( 0 === strncmp( $class_name, $client_prefix, $client_prefix_len ) ) {
			$relative_class = substr( $class_name, $client_prefix_len );
			$file           = $base_dir . '/src/' . str_replace( '\\\\', '/', $relative_class ) . '.php';
			if ( file_exists( $file ) ) {
				require $file;
			}
			return;
		}

		if ( 0 === strncmp( $class_name, $scoped_prefix, $scoped_prefix_len ) ) {
			$relative_class = substr( $class_name, $scoped_prefix_len );
			$file           = $base_dir . '/third-party/' . str_replace( '\\\\', '/', $relative_class ) . '.php';
			if ( file_exists( $file ) ) {
				require $file;
			}
		}
	}
);
`)
}

async function directoryContentDigest(directory: string): Promise<string> {
  const hash = createHash("sha256")
  await hashDirectory(directory, directory, hash)
  return hash.digest("hex")
}

async function hashDirectory(root: string, directory: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relativePath = relative(root, path).replace(/\\/g, "/")
    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\n`)
      await hashDirectory(root, path, hash)
    } else if (entry.isFile()) {
      hash.update(`file:${relativePath}\n`)
      hash.update(await readFile(path))
      hash.update("\n")
    }
  }
}

export async function stagedFileMountType(source: string): Promise<MountSpec["type"]> {
  return recipeMountType(source)
}

export async function recipeMountType(source: string, explicitType?: MountSpec["type"]): Promise<MountSpec["type"]> {
  if (explicitType === "directory" || explicitType === "file") {
    return explicitType
  }

  const result = await stat(source)
  if (result.isDirectory()) {
    return "directory"
  }
  if (result.isFile()) {
    return "file"
  }

  throw new Error(`Recipe mount source must be a file or directory: ${source}`)
}

export function stagedFileProvenance(stagedFile: WorkspaceRecipeStagedFile, recipeDirectory: string): RecipeStagedFileProvenance {
  return localPreparedSourceProvenance(stagedFile.source, recipeDirectory)
}

async function assertPreparedPluginFileExists(sourceDirectory: string, pluginFileRelativeToSource: string, sourceRef: string): Promise<void> {
  try {
    const result = await stat(join(sourceDirectory, pluginFileRelativeToSource))
    if (result.isFile()) {
      return
    }
  } catch {
    // Throw a stable message below.
  }

  throw new Error(`Recipe extra plugin source did not contain expected plugin file ${pluginFileRelativeToSource}: ${sourceRef}`)
}

async function prepareRecipeSource(sourceRef: string, recipeDirectory: string, slug: string, expectedSha256?: string): Promise<PreparedExternalSource> {
  const source = recipeSource(sourceRef, expectedSha256)
  if (source.type === "local") {
    return {
      source: resolve(recipeDirectory, sourceRef),
      cleanupPaths: [],
      provenance: recipeSourceProvenance(source, recipeDirectory),
    }
  }

  const [policyIssue] = evaluateRecipeSourcePolicy(source, expectedSha256)
  if (policyIssue) {
    throw new Error(policyIssue.message)
  }

  const preparedZip = await prepareZipSource(source, slug, recipeRedirectSource)

  return {
    source: await extractedPluginSourceDirectory(preparedZip.extractDirectory, slug),
    cleanupPaths: [preparedZip.root],
    provenance: {
      ...recipeSourceProvenance(source, recipeDirectory),
      digest: { sha256: preparedZip.digest, ...(source.expectedSha256 ? { expected: source.expectedSha256, verified: true } : {}) },
      policy: sourcePolicySnapshot(source.host),
      localPathCategory: "temporary-download",
    },
  }
}

async function extractedPluginSourceDirectory(extractDirectory: string, slug: string): Promise<string> {
  const slugDirectory = join(extractDirectory, slug)
  try {
    const result = await stat(slugDirectory)
    if (result.isDirectory()) {
      return slugDirectory
    }
  } catch {
    // Fall through to generic zip layout.
  }

  return extractDirectory
}

async function prepareRecipeWorkspace(workspace: WorkspaceRecipeWorkspace, recipeDirectory: string, slug: string): Promise<PreparedWorkspaceSource> {
  const directory = await mkdtemp(join(tmpdir(), `wp-codebox-${slug}-`))
  const baselineDirectory = await mkdtemp(join(tmpdir(), `wp-codebox-${slug}-baseline-`))
  if (workspace.seed.type === "directory") {
    const source = resolve(recipeDirectory, workspace.seed.source ?? "")
    await copyWorkspaceSeedDirectory(source, directory, workspace.seed.excludePaths)
    await copyWorkspaceSeedDirectory(source, baselineDirectory, workspace.seed.excludePaths)
    await ensureStandaloneGitPrimary(directory)
    return { source: directory, baselineSource: baselineDirectory, cleanupPaths: [directory, baselineDirectory] }
  }

  if (workspace.seed.type === "theme_scaffold") {
    await writeThemeScaffold(directory, slug, workspace.seed.name ?? titleFromSlug(slug))
    await writeThemeScaffold(baselineDirectory, slug, workspace.seed.name ?? titleFromSlug(slug))
    return { source: directory, baselineSource: baselineDirectory, cleanupPaths: [directory, baselineDirectory] }
  }

  await writePluginScaffold(directory, slug, workspace.seed.name ?? titleFromSlug(slug))
  await writePluginScaffold(baselineDirectory, slug, workspace.seed.name ?? titleFromSlug(slug))
  return { source: directory, baselineSource: baselineDirectory, cleanupPaths: [directory, baselineDirectory] }
}

async function ensureStandaloneGitPrimary(directory: string): Promise<void> {
  const gitPath = join(directory, ".git")
  try {
    const gitStat = await stat(gitPath)
    if (gitStat.isDirectory()) {
      return
    }

    await rm(gitPath, { force: true })
  } catch {
    // No Git metadata was copied; initialize a sandbox-local primary below.
  }

  await executeManagedHostCommand({ command: "git", args: ["init", "--quiet"], cwd: directory, allowedCwdRoots: [directory], label: "initialize standalone workspace git repository" })
}

export function defaultWorkspaceTarget(workspace: WorkspaceRecipeWorkspace, slug: string): string {
  if (workspace.seed.type === "theme_scaffold") {
    return `/wordpress/wp-content/themes/${slug}`
  }

  if (workspace.seed.type === "plugin_scaffold") {
    return `/wordpress/wp-content/plugins/${slug}`
  }

  if (workspace.target) {
    return workspace.target
  }

  return `${SANDBOX_WORKSPACE_ROOT}/${slug}`
}

async function writePluginScaffold(directory: string, slug: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${slug}.php`), `<?php
/**
 * Plugin Name: ${name}
 * Description: WP Codebox seeded plugin workspace.
 * Version: 0.1.0
 */

defined( 'ABSPATH' ) || exit;

add_action( 'init', static function (): void {
	do_action( '${slug.replace(/-/g, "_")}_loaded' );
} );
`)
  await writeFile(join(directory, "README.md"), `# ${name}

Seeded by WP Codebox.
`)
}

async function writeThemeScaffold(directory: string, slug: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "style.css"), `/*
Theme Name: ${name}
Description: WP Codebox seeded theme workspace.
Version: 0.1.0
*/
`)
  await writeFile(join(directory, "index.php"), `<?php
?><main id="site-content"><h1><?php bloginfo( 'name' ); ?></h1></main>
`)
  await writeFile(join(directory, "README.md"), `# ${name}

Seeded by WP Codebox.
`)
}

function titleFromSlug(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ")
}

export function recipeExtraPlugins(recipe: WorkspaceRecipe): WorkspaceRecipeExtraPlugin[] {
  return recipe.inputs?.extra_plugins ?? []
}

export function recipeSource(sourceRef: string, expectedSha256?: string): ParsedRecipeSource {
  let url: URL
  try {
    url = new URL(sourceRef)
  } catch {
    return { type: "local", resolvedUrl: sourceRef, host: "" }
  }

  if (url.protocol !== "https:") {
    throw new Error(`External recipe sources must use https:// URLs: ${sourceRef}`)
  }

  if (!url.pathname.toLowerCase().endsWith(".zip")) {
    throw new Error(`External recipe sources must point to .zip archives: ${sourceRef}`)
  }

  if (url.hostname === "downloads.wordpress.org" && url.pathname.startsWith("/plugin/")) {
    const filename = basename(url.pathname)
    const match = filename.match(/^([A-Za-z0-9_-]+)\./)
    return { type: "wporg_plugin_zip", resolvedUrl: url.toString(), host: url.hostname, ...(expectedSha256 ? { expectedSha256: expectedSha256.toLowerCase() } : {}), ...(match ? { wporgSlug: match[1] } : {}) }
  }

  return { type: "https_zip", resolvedUrl: url.toString(), host: url.hostname, ...(expectedSha256 ? { expectedSha256: expectedSha256.toLowerCase() } : {}) }
}

export function recipeRedirectSource(source: ParsedRecipeSource, finalSourceRef: string, headers?: Headers): ParsedRecipeSource {
  if (finalSourceRef === source.resolvedUrl) {
    return source
  }

  let url: URL
  try {
    url = new URL(finalSourceRef)
  } catch (error) {
    throw new Error(`Recipe source redirected to an invalid URL: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (url.protocol !== "https:") {
    throw new Error(`Recipe source redirected to a non-HTTPS URL: ${finalSourceRef}`)
  }

  const disposition = [headers?.get("content-disposition") ?? "", url.searchParams.get("response-content-disposition") ?? "", url.searchParams.get("rscd") ?? ""].join("\n")
  const finalPathIsZip = url.pathname.toLowerCase().endsWith(".zip")
  const finalNameIsZip = /filename\*?\s*=.*\.zip(?:[\s"']|$)/i.test(decodeURIComponent(disposition))
  if (!finalPathIsZip && !finalNameIsZip) {
    throw new Error(`Recipe source redirected to a URL that does not identify a zip archive: ${finalSourceRef}`)
  }

  return {
    ...source,
    resolvedUrl: url.toString(),
    host: url.hostname,
  }
}

export function recipeSourceProvenance(source: ParsedRecipeSource, recipeDirectory: string): RecipeSourceProvenance {
  if (source.type === "local") {
    return {
      kind: "local",
      original: source.resolvedUrl,
      localPathCategory: resolve(recipeDirectory, source.resolvedUrl).startsWith(recipeDirectory) ? "recipe-relative" : undefined,
    }
  }

  return {
    kind: source.type,
    original: source.resolvedUrl,
    resolvedUrl: source.resolvedUrl,
    ...(source.expectedSha256 ? { digest: { sha256: source.expectedSha256, expected: source.expectedSha256, verified: false } } : {}),
    policy: sourcePolicySnapshot(source.host),
  }
}

export function recipeExtraPluginSlug(plugin: WorkspaceRecipeExtraPlugin): string {
  if (plugin.slug) {
    return plugin.slug
  }

  const source = recipeSource(plugin.source, plugin.sha256)
  if (source.wporgSlug) {
    return source.wporgSlug
  }

  if (source.type !== "local") {
    throw new Error(`External extra_plugins sources require slug when it cannot be inferred from a WordPress.org plugin URL: ${plugin.source}`)
  }

  return basename(resolve(plugin.source))
}

export function recipeExtraPluginFile(plugin: WorkspaceRecipeExtraPlugin): string {
  const slug = recipeExtraPluginSlug(plugin)
  return plugin.pluginFile ?? `${slug}/${slug}.php`
}

export function pluginTarget(slug: string, loadAs: PreparedExtraPlugin["loadAs"]): string {
  if (loadAs === "mu-plugin") {
    return `/wordpress/wp-content/mu-plugins/contained-runtime/${slug}`
  }

  return `/wordpress/wp-content/plugins/${slug}`
}

export function isComposerPackageName(value: string): boolean {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value)
}

export function composerPackageVendorPath(packageName: string): string {
  if (!isComposerPackageName(packageName)) {
    throw new Error(`Composer package name is not safe for a vendor path: ${packageName}`)
  }

  return packageName
}

export async function resolveRecipeExtraPluginFile(plugin: WorkspaceRecipeExtraPlugin, recipeDirectory: string): Promise<string> {
  const slug = recipeExtraPluginSlug(plugin)
  if (plugin.pluginFile) {
    return plugin.pluginFile
  }

  const source = recipeSource(plugin.source, plugin.sha256)
  if (source.type === "local") {
    const pluginSource = resolve(recipeDirectory, plugin.source)
    return resolvePluginEntrypointContract({ source: pluginSource, slug, loadAs: plugin.loadAs }).pluginFile
  }

  return `${slug}/${slug}.php`
}

export function activeExtraPluginFiles(extraPlugins: BootActivePluginCandidate[]): string[] {
  return extraPlugins
    .filter((plugin) => plugin.loadAs === "plugin" && plugin.activate !== false)
    .map((plugin) => plugin.pluginFile)
}

export function recipeBlueprintWithBootActivePlugins(blueprint: unknown, _extraPlugins: BootActivePluginCandidate[]): unknown {
  return blueprint ?? { steps: [] }
}

export function installMuPluginsCode(extraPlugins: PreparedExtraPlugin[]): string | null {
  const muPlugins = extraPlugins
    .filter((plugin) => plugin.loadAs === "mu-plugin")
    .map((plugin) => plugin.pluginFile)

  if (muPlugins.length === 0) {
    return null
  }

  return `$plugins = ${JSON.stringify(muPlugins)};
$runtime_dir = WPMU_PLUGIN_DIR . '/contained-runtime';
if (!is_dir(WPMU_PLUGIN_DIR) && !mkdir(WPMU_PLUGIN_DIR, 0777, true) && !is_dir(WPMU_PLUGIN_DIR)) {
    throw new RuntimeException('Could not create mu-plugins directory.');
}
if (!is_dir($runtime_dir)) {
    throw new RuntimeException('WP Codebox runtime mu-plugin directory is not mounted.');
}
$loader = WPMU_PLUGIN_DIR . '/contained-runtime-loader.php';
$lines = array(
    '<?php',
    '/**',
    ' * Plugin Name: WP Codebox Runtime Loader',
    ' * Description: Loads WP Codebox runtime substrate as must-use plugins.',
    ' */',
    '',
    "defined( 'ABSPATH' ) || exit;",
    '',
);
foreach ($plugins as $plugin) {
    if ('' === $plugin || str_starts_with($plugin, '/') || str_contains($plugin, '..') || !str_ends_with($plugin, '.php')) {
        throw new RuntimeException('Unsafe WP Codebox runtime mu-plugin entry.');
    }
    $plugin_file = $runtime_dir . '/' . $plugin;
    if (!file_exists($plugin_file)) {
        throw new RuntimeException(sprintf('WP Codebox runtime mu-plugin is not mounted: %s', $plugin));
    }
    $lines[] = "require_once WPMU_PLUGIN_DIR . '/contained-runtime/" . str_replace("'", "\\'", $plugin) . "';";
}
if (false === file_put_contents($loader, implode("\\n", $lines) . "\\n")) {
    throw new RuntimeException('Could not write WP Codebox runtime mu-plugin loader.');
}
echo wp_json_encode(array('command' => 'install-mu-plugins', 'plugins' => $plugins, 'loader' => $loader), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}
