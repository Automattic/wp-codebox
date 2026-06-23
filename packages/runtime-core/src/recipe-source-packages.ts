import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { safeArtifactRelativePath } from "./artifact-paths.js"
import type { ManagedHostCommandConfig } from "./managed-host-command.js"
import { prepareLocalSourceStageSync, preparedSourcePath, preparedSourceRoot } from "./prepared-source-staging.js"
import { SANDBOX_WORKSPACE_ROOT } from "./runtime-action-adapter.js"
import type { WorkspaceRecipe, WorkspaceRecipeDeclaredArtifact, WorkspaceRecipeSourcePackage, WorkspaceRecipeStagedFile } from "./runtime-contracts.js"

export interface SourcePackageBlocker {
  code: string
  path: string
  message: string
}

export interface CompiledSourcePackage {
  name: string
  stagedFile: WorkspaceRecipeStagedFile
  artifact?: WorkspaceRecipeDeclaredArtifact
}

export interface RecipeTemplateInput {
  recipe?: Partial<WorkspaceRecipe>
  sourcePackages?: WorkspaceRecipeSourcePackage[]
}

export interface PreparedRecipeSourcePackageOptions {
  source: string
  slug: string
  artifactsRoot: string
  originalSource?: string
  sourceSubpath?: string
  packageRootName?: string
  composerInstallArgs?: string[]
}

export interface CompiledRecipeTemplate {
  recipe: WorkspaceRecipe
  sourcePackages: CompiledSourcePackage[]
  blockers: SourcePackageBlocker[]
}

export function compileRecipeTemplate(input: RecipeTemplateInput): CompiledRecipeTemplate {
  const base = input.recipe ?? {}
  const sourcePackages = input.sourcePackages ?? base.inputs?.sourcePackages ?? []
  const blockers = sourcePackages.flatMap((sourcePackage, index) => validateSourcePackage(sourcePackage, `$.sourcePackages[${index}]`))
  const compiled = blockers.length > 0 ? [] : sourcePackages.map((sourcePackage) => compileSourcePackage(sourcePackage))
  const existingInputs = base.inputs ?? {}
  const existingArtifacts = base.artifacts ?? {}
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    ...base,
    inputs: {
      ...existingInputs,
      sourcePackages: sourcePackages.length > 0 ? sourcePackages : existingInputs.sourcePackages,
    },
    workflow: base.workflow && Array.isArray(base.workflow.steps) ? base.workflow : { steps: [{ command: "inspect-mounted-inputs" }] },
    artifacts: {
      ...existingArtifacts,
      paths: [...(existingArtifacts.paths ?? []), ...compiled.flatMap((entry) => entry.artifact ? [entry.artifact] : [])],
    },
  }

  return { recipe, sourcePackages: compiled, blockers }
}

export function compileSourcePackage(sourcePackage: WorkspaceRecipeSourcePackage): CompiledSourcePackage {
  const name = normalizeSourcePackageName(sourcePackage.name)
  const target = normalizeWorkspaceRelativeTarget(sourcePackage.target)
  const stagedFile: WorkspaceRecipeStagedFile = { source: sourcePackage.source, target }
  const artifact = sourcePackageArtifact(sourcePackage, name, target)
  return { name, stagedFile, ...(artifact ? { artifact } : {}) }
}

export function validateSourcePackage(sourcePackage: WorkspaceRecipeSourcePackage, path = "$"): SourcePackageBlocker[] {
  const blockers: SourcePackageBlocker[] = []
  try {
    normalizeSourcePackageName(sourcePackage.name)
  } catch (error) {
    blockers.push({ code: "invalid-source-package-name", path: `${path}.name`, message: errorMessage(error) })
  }
  try {
    normalizeWorkspaceRelativeTarget(sourcePackage.target)
  } catch (error) {
    blockers.push({ code: "invalid-source-package-target", path: `${path}.target`, message: errorMessage(error) })
  }
  for (const [index, pattern] of [...(sourcePackage.allow ?? []), ...(sourcePackage.deny ?? [])].entries()) {
    try {
      normalizeSourcePackagePattern(pattern)
    } catch (error) {
      blockers.push({ code: "invalid-source-package-filter", path: `${path}.filters[${index}]`, message: errorMessage(error) })
    }
  }
  return blockers
}

export function normalizeSourcePackageName(name: string): string {
  if (typeof name !== "string") {
    throw new Error("Source package names must be strings")
  }
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(name)) {
    throw new Error(`Source package names must be stable identifiers: ${name}`)
  }
  return name
}

export function normalizeWorkspaceRelativeTarget(target: string): string {
  const normalized = normalizeReviewerSafePath(target)
  if (normalized === SANDBOX_WORKSPACE_ROOT.slice(1) || normalized.startsWith(`${SANDBOX_WORKSPACE_ROOT.slice(1)}/`)) {
    return `/${normalized}`
  }
  return `${SANDBOX_WORKSPACE_ROOT}/${normalized}`
}

export function normalizeReviewerSafePath(path: string): string {
  if (typeof path !== "string") {
    throw new Error("Path must be a string")
  }
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized || /^[A-Za-z]:($|\/)/.test(normalized)) {
    throw new Error("Path must be relative and reviewer-safe")
  }
  const segments = normalized.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path must not contain current-directory or parent-directory segments")
  }
  return segments.join("/")
}

export function normalizeSourcePackagePattern(pattern: string): string {
  const normalized = normalizeReviewerSafePath(pattern.replace(/\*+$/g, ""))
  return pattern.endsWith("*") ? `${normalized}*` : normalized
}

export function sourcePackagePathAllowed(relativePath: string, allow: string[] = [], deny: string[] = []): boolean {
  const safePath = normalizeReviewerSafePath(relativePath)
  const denied = deny.some((pattern) => sourcePackagePatternMatches(safePath, pattern))
  if (denied) {
    return false
  }
  return allow.length === 0 || allow.some((pattern) => sourcePackagePatternMatches(safePath, pattern) || sourcePackagePatternDescendsFrom(safePath, pattern))
}

function sourcePackagePatternMatches(relativePath: string, pattern: string): boolean {
  const normalized = normalizeSourcePackagePattern(pattern)
  if (normalized.endsWith("*")) {
    return relativePath.startsWith(normalized.slice(0, -1))
  }
  return relativePath === normalized || relativePath.startsWith(`${normalized}/`)
}

function sourcePackagePatternDescendsFrom(relativePath: string, pattern: string): boolean {
  const normalized = normalizeSourcePackagePattern(pattern).replace(/\*$/, "")
  return normalized.startsWith(`${relativePath}/`)
}

function sourcePackageArtifact(sourcePackage: WorkspaceRecipeSourcePackage, name: string, target: string): WorkspaceRecipeDeclaredArtifact | undefined {
  if (!sourcePackage.artifact) {
    return undefined
  }
  const artifact = typeof sourcePackage.artifact === "object" ? sourcePackage.artifact : {}
  return {
    name: artifact.name ?? `source-package-${name}`,
    path: artifact.path ?? `${target.replace(/\/+$/, "")}/.wp-codebox-source-package.json`,
    required: artifact.required ?? false,
    parseJson: true,
    metadata: { kind: "source-package-provenance", sourcePackage: name },
  }
}

export function assertPathInside(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path))
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path must stay inside source package root: ${path}`)
  }
}

export function sourcePackageArtifactPath(path: string): string {
  return safeArtifactRelativePath(path)
}

export function prepareRecipeSourcePackageSync(options: PreparedRecipeSourcePackageOptions): string {
  const packageRootName = options.packageRootName ?? "prepared-source-packages"
  const source = options.source
  const originalSource = options.originalSource || source
  const sourceSubpath = options.sourceSubpath ? normalizeReviewerSafePath(options.sourceSubpath) : inferredSourceSubpath(source, originalSource)
  if (!source) return source

  if (!options.artifactsRoot) {
    return prepareRecipeSourcePackageWithoutArtifacts(source, originalSource, options.slug, sourceSubpath)
  }

  const preparedRoot = preparedSourceRoot(options.artifactsRoot, packageRootName)
  const preparedSource = preparedSourcePath(options.artifactsRoot, packageRootName, options.slug)
  const preparedPluginSource = sourceSubpath ? join(preparedSource, sourceSubpath) : preparedSource
  const copySource = localSourcePath(originalSource)
  if (pathExists(copySource)) {
    if (resolve(copySource) !== resolve(preparedSource)) {
      prepareLocalSourceStageSync({
        source: copySource,
        sourceRef: originalSource,
        targetRoot: preparedRoot,
        targetName: options.slug,
        cleanupRoot: false,
      })
    } else {
      mkdirSync(preparedSource, { recursive: true })
    }
    return installComposerDependenciesForSourcePackageSync(preparedPluginSource, options.slug, preparedRoot, options.composerInstallArgs)
  }

  return prepareRecipeSourcePackageWithoutArtifacts(source, source, options.slug, "")
}

export function composerManagedHostEnv(): Record<string, string> {
  const home = process.env.HOME || homedir()
  return {
    ...(home ? { HOME: home } : {}),
    ...(process.env.COMPOSER_HOME ? { COMPOSER_HOME: process.env.COMPOSER_HOME } : home ? { COMPOSER_HOME: join(home, ".composer") } : {}),
  }
}

export function composerManagedHostCommandConfig(options: {
  cwd: string
  allowedCwdRoots: string[]
  args?: string[]
  label: string
  timeoutMs?: number
  maxOutputBytes?: number
}): ManagedHostCommandConfig {
  return {
    command: "composer",
    args: options.args ?? ["install", "--no-dev", "--prefer-dist", "--no-interaction", "--no-progress", "--no-scripts", "--no-plugins"],
    cwd: options.cwd,
    env: composerManagedHostEnv(),
    allowedCwdRoots: options.allowedCwdRoots,
    inheritedEnv: ["HOME", "COMPOSER_HOME"],
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024 * 10,
    label: options.label,
  }
}

function prepareRecipeSourcePackageWithoutArtifacts(source: string, originalSource: string, slug: string, sourceSubpath: string): string {
  const localSource = localSourcePath(originalSource)
  const pluginSource = sourceSubpath ? join(localSource, sourceSubpath) : localSource
  if (!pathExists(join(pluginSource, "composer.json"))) {
    return pathExists(pluginSource) ? pluginSource : source
  }
  if (pathExists(join(pluginSource, "vendor", "autoload.php"))) {
    return pluginSource
  }
  throw new Error(`Plugin ${slug} requires Composer dependencies but no artifacts directory is available for staging.`)
}

function inferredSourceSubpath(source: string, originalSource: string): string {
  const localSource = localSourcePath(source)
  const localOriginalSource = localSourcePath(originalSource)
  const relativePath = relative(resolve(localOriginalSource), resolve(localSource))
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return ""
  }
  return normalizeReviewerSafePath(relativePath)
}

function installComposerDependenciesForSourcePackageSync(source: string, slug: string, allowedRoot: string, composerInstallArgs?: string[]): string {
  if (!pathExists(join(source, "composer.json")) || pathExists(join(source, "vendor", "autoload.php"))) {
    return source
  }

  const config = composerManagedHostCommandConfig({
    cwd: source,
    allowedCwdRoots: [allowedRoot],
    args: composerInstallArgs ?? ["install", "--no-dev", "--prefer-dist", "--no-interaction", "--no-progress", "--no-scripts", "--no-plugins"],
    label: `hydrate Composer source package ${slug}`,
  })
  const result = spawnSync(config.command, config.args, {
    cwd: source,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...config.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    throw new Error(`Composer install failed for plugin ${slug}: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
  if (!pathExists(join(source, "vendor", "autoload.php"))) {
    throw new Error(`Composer install for plugin ${slug} did not create vendor/autoload.php.`)
  }
  return source
}

function localSourcePath(source: string): string {
  return pathExists(source) ? resolve(source) : source
}

function pathExists(filePath: string): boolean {
  return existsSync(filePath)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
