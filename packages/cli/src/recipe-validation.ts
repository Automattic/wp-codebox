import { readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { assertFixtureImportDeterministicIdsSupported, assertWorkspaceRecipeJsonSchema, commandArgValue, normalizeRuntimeBackendKind, normalizeRuntimeMountTarget, parseCommandJson, safeArtifactRelativePath, validateBrowserInteractionScript, validateRuntimePolicy, validateSourcePackage, workspaceRecipeRuntimeCollectedArtifacts, type MountSpec, type RuntimeAssetSpec, type RuntimePolicy, type RuntimePreviewSpec, type WorkspaceRecipe, type WorkspaceRecipeDeclaredArtifact, type WorkspaceRecipeDependencyOverlay, type WorkspaceRecipeDistribution, type WorkspaceRecipeDistributionStartupProbe, type WorkspaceRecipeFixtureDatabase, type WorkspaceRecipeFuzzCasePhase, type WorkspaceRecipeMount, type WorkspaceRecipePluginRuntime, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeProbe, type WorkspaceRecipeRuntimeBackendPackage, type WorkspaceRecipeRuntimeOverlay, type WorkspaceRecipeSiteSeed } from "@automattic/wp-codebox-core"
import { commandValidationDescriptorFor, effectivePolicyCommandsFor, type CommandArgValidationDescriptor } from "@automattic/wp-codebox-core/contracts"
import { composerPackageVendorPath, evaluateRecipeSourcePolicy, isComposerPackageName, pluginTarget, recipeExtraPluginSlug, recipeExtraPluginSource, recipeExtraPluginSourceRoot, recipeExtraPluginSourceSubpath, recipeExtraPlugins, recipeSource, resolveRecipeExtraPluginFile } from "./recipe-sources.js"
import { loadConfiguredRuntimeOverlayDescriptors, registeredRuntimeOverlayDescriptors, runtimeOverlayDescriptor, runtimeOverlayTarget } from "./runtime-overlay-registry.js"
import { cliRuntimeBackendRecipePolicy, listCliRecipeCommandIds, listCliRuntimeBackendKinds } from "./runtime-backends.js"

export interface RecipeValidationIssue {
  code: string
  path: string
  message: string
}

export type RecipeWorkflowPhase = "setup" | "before" | "steps" | "after" | `fuzz:${WorkspaceRecipeFuzzCasePhase}`

export interface RecipeWorkflowStepRef {
  phase: Exclude<RecipeWorkflowPhase, "setup">
  index: number
  step: WorkspaceRecipe["workflow"]["steps"][number]
  fuzzCaseId?: string
  fuzzCaseIndex?: number
  fuzzPhase?: WorkspaceRecipeFuzzCasePhase
  fuzzStepIndex?: number
}

export const defaultPolicy: RuntimePolicy = {
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["inspect-mounted-inputs", "wordpress.run-php"],
  secrets: "none",
  approvals: "never",
}

const cliRuntimeRecipePolicy = cliRuntimeBackendRecipePolicy()
const cliRecipeCommandDefinitions = cliRuntimeRecipePolicy.recipeCommands
const supportedRecipeCommands = new Set(listCliRecipeCommandIds())
const hostRecipeCommandPattern = /^host\/[A-Za-z0-9._/-]+$/
loadConfiguredRuntimeOverlayDescriptors()

export async function loadWorkspaceRecipe(recipePath: string): Promise<WorkspaceRecipe> {
  return parseWorkspaceRecipe(await readFile(recipePath, "utf8"), recipePath)
}

export function parseWorkspaceRecipe(raw: string, recipePath: string): WorkspaceRecipe {
  const recipe = parseWorkspaceRecipeJson(raw)
  normalizeWorkspaceRecipeCompatibility(recipe)
  validateWorkspaceRecipeShape(recipe, recipePath)
  assertWorkspaceRecipeJsonSchema(recipe, {
    recipePath,
    recipeCommands: cliRecipeCommandDefinitions,
    runtimeBackendKinds: listCliRuntimeBackendKinds(),
    runtimeWordPressInstallModes: cliRuntimeRecipePolicy.wordpressInstallModes,
    runtimeOverlayKinds: uniqueRuntimeOverlayDescriptorValues("kind"),
    runtimeOverlayLibraries: uniqueRuntimeOverlayDescriptorValues("library"),
    runtimeOverlayStrategies: uniqueRuntimeOverlayDescriptorValues("strategy"),
  })

  return recipe
}

export function parseWorkspaceRecipeJson(raw: string): WorkspaceRecipe {
  return parseCommandJson(raw, "workspace recipe") as WorkspaceRecipe
}

export function normalizeWorkspaceRecipeCompatibility(recipe: WorkspaceRecipe): WorkspaceRecipe {
  if (recipe.runtime) {
    recipe.runtime.backend = normalizeRuntimeBackendKind(recipe.runtime.backend)
  }

  return recipe
}

export function validateWorkspaceRecipeShape(recipe: WorkspaceRecipe, recipePath: string): void {
  if (recipe.schema !== "wp-codebox/workspace-recipe/v1") {
    throw new Error(`Unsupported recipe schema in ${recipePath}`)
  }

  if (!recipe.workflow || !Array.isArray(recipe.workflow.steps) || recipe.workflow.steps.length === 0) {
    throw new Error(`Recipe must include at least one workflow step: ${recipePath}`)
  }

  for (const phase of ["before", "after"] as const) {
    if (recipe.workflow[phase] !== undefined && !Array.isArray(recipe.workflow[phase])) {
      throw new Error(`Recipe workflow ${phase} must be an array: ${recipePath}`)
    }
  }

  for (const { phase, step } of recipeWorkflowSteps(recipe)) {
    if (!step || typeof step.command !== "string" || step.command === "") {
      throw new Error(`Recipe workflow ${phase} entries must include a command: ${recipePath}`)
    }

    if (step.args && !Array.isArray(step.args)) {
      throw new Error(`Recipe workflow ${phase} args must be arrays: ${recipePath}`)
    }

    if (step.diagnostics !== undefined && (!step.diagnostics || typeof step.diagnostics !== "object" || Array.isArray(step.diagnostics))) {
      throw new Error(`Recipe workflow ${phase} diagnostics must be an object: ${recipePath}`)
    }

    if (step.metadata !== undefined && (!step.metadata || typeof step.metadata !== "object" || Array.isArray(step.metadata))) {
      throw new Error(`Recipe workflow ${phase} metadata must be an object: ${recipePath}`)
    }

    if (step.allowFailure !== undefined && typeof step.allowFailure !== "boolean") {
      throw new Error(`Recipe workflow ${phase} allowFailure must be boolean: ${recipePath}`)
    }

    if (step.advisory !== undefined && typeof step.advisory !== "boolean") {
      throw new Error(`Recipe workflow ${phase} advisory must be boolean: ${recipePath}`)
    }
  }

  if (recipe.distribution !== undefined) {
    if (!recipe.distribution || typeof recipe.distribution !== "object" || Array.isArray(recipe.distribution)) {
      throw new Error(`Recipe distribution must be an object: ${recipePath}`)
    }
    if (!recipe.distribution.name || typeof recipe.distribution.name !== "string") {
      throw new Error(`Recipe distribution requires name: ${recipePath}`)
    }
    if (!recipe.distribution.wordpress || typeof recipe.distribution.wordpress !== "object" || Array.isArray(recipe.distribution.wordpress)) {
      throw new Error(`Recipe distribution requires wordpress: ${recipePath}`)
    }
    if (!recipe.distribution.wordpress.root || typeof recipe.distribution.wordpress.root !== "string") {
      throw new Error(`Recipe distribution wordpress requires root: ${recipePath}`)
    }
    for (const field of ["sourceMounts", "serviceFakes", "routeAliases", "setupArtifacts", "startupProbes", "artifacts"] as const) {
      if (recipe.distribution[field] !== undefined && !Array.isArray(recipe.distribution[field])) {
        throw new Error(`Recipe distribution ${field} must be an array: ${recipePath}`)
      }
    }
  }

  validateRecipeMounts(recipe.runtime?.stack?.mounts, "runtime stack", recipePath)
  validateRecipeRuntimeBackendPackage(recipe.runtime?.backendPackage, recipePath)
  validateRecipeRuntimeOverlays(recipe.runtime?.overlays, recipePath)
  validateRecipeRuntimeAssets(recipe.runtime?.assets, recipePath)
  validateRecipeRuntimeWordPressInstallMode(recipe.runtime?.wordpressInstallMode, recipePath)
  validateRecipeRuntimePreview(recipe.runtime?.preview, recipePath)
  validateRecipeMounts(recipe.inputs?.mounts, "mounts", recipePath)
  validateRecipeDependencyOverlays(recipe.inputs?.dependency_overlays, recipePath)

  if (recipe.inputs && "extraPlugins" in recipe.inputs) {
    throw new Error(`Recipe inputs.extraPlugins is unsupported; use inputs.extra_plugins: ${recipePath}`)
  }

  const workspaces = recipe.inputs?.workspaces ?? []
  if (!Array.isArray(workspaces)) {
    throw new Error(`Recipe workspaces must be an array: ${recipePath}`)
  }

  for (const workspace of workspaces) {
    if (!workspace.seed || typeof workspace.seed !== "object") {
      throw new Error(`Recipe workspaces entries must include a seed object: ${recipePath}`)
    }

    if (!["plugin_scaffold", "theme_scaffold", "directory"].includes(workspace.seed.type)) {
      throw new Error(`Recipe workspace seed type is unsupported: ${recipePath}`)
    }

    if ((workspace.seed.type === "plugin_scaffold" || workspace.seed.type === "theme_scaffold") && !workspace.seed.slug) {
      throw new Error(`Recipe ${workspace.seed.type} workspace seeds require slug: ${recipePath}`)
    }

    if (workspace.seed.type === "directory" && !workspace.seed.source) {
      throw new Error(`Recipe directory workspace seeds require source: ${recipePath}`)
    }

    if (workspace.mode && workspace.mode !== "readonly" && workspace.mode !== "readwrite") {
      throw new Error(`Recipe workspace mode must be readonly or readwrite: ${recipePath}`)
    }

    if (workspace.sourceMode && workspace.sourceMode !== "repo-backed" && workspace.sourceMode !== "site-backed") {
      throw new Error(`Recipe workspace sourceMode must be repo-backed or site-backed: ${recipePath}`)
    }
  }

  const rawExtraPlugins = recipe.inputs?.extra_plugins
  if (rawExtraPlugins && !Array.isArray(rawExtraPlugins)) {
    throw new Error(`Recipe extra_plugins must be an array: ${recipePath}`)
  }

  for (const plugin of recipeExtraPlugins(recipe)) {
    if (!plugin.source && !plugin.sourcePath) {
      throw new Error(`Recipe extra_plugins entries must include source or sourcePath: ${recipePath}`)
    }

    if (plugin.slug && !/^[a-z0-9][a-z0-9-_]*$/i.test(plugin.slug)) {
      throw new Error(`Recipe extra_plugins slug must be a plugin-directory slug: ${recipePath}`)
    }

    if (plugin.mountSlug && !/^[a-z0-9][a-z0-9-_]*$/i.test(plugin.mountSlug)) {
      throw new Error(`Recipe extra_plugins mountSlug must be a plugin-directory slug: ${recipePath}`)
    }

    if (plugin.loadAs && plugin.loadAs !== "plugin" && plugin.loadAs !== "mu-plugin") {
      throw new Error(`Recipe extra_plugins loadAs must be plugin or mu-plugin: ${recipePath}`)
    }

    if (plugin.metadata !== undefined && (!plugin.metadata || typeof plugin.metadata !== "object" || Array.isArray(plugin.metadata))) {
      throw new Error(`Recipe extra_plugins metadata must be an object when provided: ${recipePath}`)
    }
  }

  const pluginRuntime = recipe.inputs?.pluginRuntime
  if (pluginRuntime) {
    if (pluginRuntime.setup && !Array.isArray(pluginRuntime.setup)) {
      throw new Error(`Recipe pluginRuntime setup must be an array: ${recipePath}`)
    }
    if (pluginRuntime.healthProbes && !Array.isArray(pluginRuntime.healthProbes)) {
      throw new Error(`Recipe pluginRuntime healthProbes must be an array: ${recipePath}`)
    }
  }

  validateFixtureDatabases(recipe.inputs?.fixtureDatabases, recipePath)
  validateRecipeProbes(recipe.probes, recipePath)
  validateRecipeFuzzRun(recipe.fuzzRun, recipePath)
  validateDeclaredArtifacts(recipe.artifacts?.paths, recipePath)

  const siteSeeds = recipe.inputs?.siteSeeds ?? []
  if (!Array.isArray(siteSeeds)) {
    throw new Error(`Recipe siteSeeds must be an array: ${recipePath}`)
  }

  for (const siteSeed of siteSeeds) {
    if (!siteSeed || typeof siteSeed !== "object") {
      throw new Error(`Recipe siteSeeds entries must be objects: ${recipePath}`)
    }

    if (siteSeed.type !== "fixture" && siteSeed.type !== "parent_site") {
      throw new Error(`Recipe siteSeeds type is unsupported: ${recipePath}`)
    }

    if (!siteSeed.name || typeof siteSeed.name !== "string") {
      throw new Error(`Recipe siteSeeds entries must include name: ${recipePath}`)
    }

    if (siteSeed.type === "fixture" && !siteSeed.source) {
      throw new Error(`Recipe fixture siteSeeds require source: ${recipePath}`)
    }

    if (!siteSeed.scopes || typeof siteSeed.scopes !== "object" || Array.isArray(siteSeed.scopes)) {
      throw new Error(`Recipe siteSeeds entries must include scopes: ${recipePath}`)
    }
  }

  const stagedFiles = recipe.inputs?.stagedFiles ?? []
  if (!Array.isArray(stagedFiles)) {
    throw new Error(`Recipe stagedFiles must be an array: ${recipePath}`)
  }

  const sourcePackages = recipe.inputs?.sourcePackages ?? []
  if (!Array.isArray(sourcePackages)) {
    throw new Error(`Recipe sourcePackages must be an array: ${recipePath}`)
  }

  for (const stagedFile of stagedFiles) {
    if (!stagedFile || typeof stagedFile !== "object") {
      throw new Error(`Recipe stagedFiles entries must be objects: ${recipePath}`)
    }

    if (!stagedFile.source || typeof stagedFile.source !== "string") {
      throw new Error(`Recipe stagedFiles entries must include source: ${recipePath}`)
    }

    if (!stagedFile.target || typeof stagedFile.target !== "string") {
      throw new Error(`Recipe stagedFiles entries must include target: ${recipePath}`)
    }
  }

  for (const [index, sourcePackage] of sourcePackages.entries()) {
    if (!sourcePackage || typeof sourcePackage !== "object") {
      throw new Error(`Recipe sourcePackages entries must be objects: ${recipePath}`)
    }
    for (const blocker of validateSourcePackage(sourcePackage, `$.inputs.sourcePackages[${index}]`)) {
      throw new Error(`${blocker.message}: ${recipePath}`)
    }
  }

}

function validateRecipeRuntimePreview(preview: RuntimePreviewSpec | undefined, recipePath: string): void {
  if (preview === undefined) {
    return
  }

  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new Error(`Recipe runtime preview must be an object: ${recipePath}`)
  }

  for (const key of ["publicUrl", "siteUrl"] as const) {
    if (preview[key] !== undefined) {
      if (typeof preview[key] !== "string") {
        throw new Error(`Recipe runtime preview ${key} must be a string: ${recipePath}`)
      }
      validatePreviewHttpUrl(preview[key], `Recipe runtime preview ${key}`, recipePath)
    }
  }

  if (preview.port !== undefined && (!Number.isSafeInteger(preview.port) || preview.port < 1 || preview.port > 65535)) {
    throw new Error(`Recipe runtime preview port must be an integer between 1 and 65535: ${recipePath}`)
  }

  if (preview.bind !== undefined && (typeof preview.bind !== "string" || preview.bind.trim() === "" || /[/\\\s]/.test(preview.bind))) {
    throw new Error(`Recipe runtime preview bind must be a hostname or IP address: ${recipePath}`)
  }

  if (preview.bind !== undefined && preview.port === undefined) {
    throw new Error(`Recipe runtime preview bind requires port: ${recipePath}`)
  }
}

function validatePreviewHttpUrl(value: string, label: string, recipePath: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be an http or https URL with a hostname: ${recipePath}`)
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`${label} must be an http or https URL with a hostname: ${recipePath}`)
  }
}

function validateRecipeRuntimeAssets(assets: RuntimeAssetSpec | undefined, recipePath: string): void {
  if (assets === undefined) {
    return
  }

  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    throw new Error(`Recipe runtime assets must be an object: ${recipePath}`)
  }

  if (assets.wordpressZip !== undefined && typeof assets.wordpressZip !== "string") {
    throw new Error(`Recipe runtime assets wordpressZip must be a string: ${recipePath}`)
  }
}

function validateRecipeRuntimeWordPressInstallMode(mode: NonNullable<WorkspaceRecipe["runtime"]>["wordpressInstallMode"] | undefined, recipePath: string): void {
  if (mode === undefined) {
    return
  }

  if (!(cliRuntimeRecipePolicy.wordpressInstallModes as readonly string[]).includes(mode)) {
    throw new Error(`Recipe runtime wordpressInstallMode is unsupported: ${recipePath}`)
  }
}

function validateRecipeRuntimeBackendPackage(backendPackage: WorkspaceRecipeRuntimeBackendPackage | undefined, recipePath: string): void {
  if (backendPackage === undefined) {
    return
  }

  if (!backendPackage || typeof backendPackage !== "object" || Array.isArray(backendPackage)) {
    throw new Error(`Recipe runtime backendPackage must be an object: ${recipePath}`)
  }
  if (!backendPackage.kind || typeof backendPackage.kind !== "string") {
    throw new Error(`Recipe runtime backendPackage kind must be a string: ${recipePath}`)
  }
  if (!backendPackage.source || typeof backendPackage.source !== "string") {
    throw new Error(`Recipe runtime backendPackage must include source: ${recipePath}`)
  }
  if (backendPackage.package !== undefined && typeof backendPackage.package !== "string") {
    throw new Error(`Recipe runtime backendPackage package must be a string when provided: ${recipePath}`)
  }
  if (backendPackage.entrypoint !== undefined && typeof backendPackage.entrypoint !== "string") {
    throw new Error(`Recipe runtime backendPackage entrypoint must be a string when provided: ${recipePath}`)
  }
  if (backendPackage.metadata !== undefined && (!backendPackage.metadata || typeof backendPackage.metadata !== "object" || Array.isArray(backendPackage.metadata))) {
    throw new Error(`Recipe runtime backendPackage metadata must be an object when provided: ${recipePath}`)
  }
}

function validateRecipeMounts(mounts: WorkspaceRecipeMount[] | undefined, label: string, recipePath: string): void {
  if (mounts && !Array.isArray(mounts)) {
    throw new Error(`Recipe ${label} mounts must be an array: ${recipePath}`)
  }

  for (const mount of mounts ?? []) {
    if (!mount.source || !mount.target) {
      throw new Error(`Recipe ${label} mounts must include source and target: ${recipePath}`)
    }

    try {
      normalizeRuntimeMountTarget(mount.target, `Recipe ${label} mount`)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${recipePath}`)
    }

    if (mount.type && mount.type !== "directory" && mount.type !== "file") {
      throw new Error(`Recipe ${label} mount type must be directory or file: ${recipePath}`)
    }

    if (mount.mode && mount.mode !== "readonly" && mount.mode !== "readwrite") {
      throw new Error(`Recipe ${label} mount mode must be readonly or readwrite: ${recipePath}`)
    }

    if (mount.metadata !== undefined && (!mount.metadata || typeof mount.metadata !== "object" || Array.isArray(mount.metadata))) {
      throw new Error(`Recipe ${label} mount metadata must be an object when provided: ${recipePath}`)
    }
  }
}

function validateRecipeRuntimeOverlays(overlays: WorkspaceRecipeRuntimeOverlay[] | undefined, recipePath: string): void {
  if (overlays && !Array.isArray(overlays)) {
    throw new Error(`Recipe runtime overlays must be an array: ${recipePath}`)
  }

  for (const [index, overlay] of (overlays ?? []).entries()) {
    const path = `runtime_overlays[${index}] ($.runtime.overlays[${index}])`
    if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
      throw new Error(runtimeOverlayValidationMessage(path, "entry", "must be an object", recipePath))
    }
    if (typeof overlay.kind !== "string" || overlay.kind === "") {
      throw new Error(runtimeOverlayValidationMessage(path, "kind", "must be a non-empty string", recipePath))
    }
    if (typeof overlay.library !== "string" || overlay.library === "") {
      throw new Error(runtimeOverlayValidationMessage(path, "library", "must be a non-empty string", recipePath))
    }
    if (typeof overlay.strategy !== "string" || overlay.strategy === "") {
      throw new Error(runtimeOverlayValidationMessage(path, "strategy", "must be a non-empty string", recipePath))
    }
    if (!runtimeOverlayDescriptor(overlay)) {
      throw new Error(runtimeOverlayValidationMessage(path, "descriptor", `must match a registered runtime overlay descriptor; accepted descriptors: ${runtimeOverlayDescriptorNames()}`, recipePath))
    }
    if (!overlay.source || typeof overlay.source !== "string") {
      throw new Error(runtimeOverlayValidationMessage(path, "source", "must be a non-empty string", recipePath))
    }
    if (overlay.target !== undefined && typeof overlay.target !== "string") {
      throw new Error(runtimeOverlayValidationMessage(path, "target", "must be a string when provided", recipePath))
    }
    if (overlay.metadata !== undefined && (!overlay.metadata || typeof overlay.metadata !== "object" || Array.isArray(overlay.metadata))) {
      throw new Error(runtimeOverlayValidationMessage(path, "metadata", "must be an object when provided", recipePath))
    }
  }
}

function runtimeOverlayValidationMessage(path: string, field: string, problem: string, recipePath: string): string {
  return `Recipe runtime overlay is unsupported at ${path}; field ${field} ${problem}; accepted canonical kind values: ${uniqueRuntimeOverlayDescriptorValues("kind").join(", ")}; recipe: ${recipePath}`
}

function uniqueRuntimeOverlayDescriptorValues(field: "kind" | "library" | "strategy"): string[] {
  return [...new Set(registeredRuntimeOverlayDescriptors().map((descriptor) => descriptor[field]))]
}

function runtimeOverlayDescriptorNames(): string {
  return registeredRuntimeOverlayDescriptors()
    .map((descriptor) => `${descriptor.kind}/${descriptor.library}/${descriptor.strategy}`)
    .join(", ")
}

function validateRecipeDependencyOverlays(overlays: WorkspaceRecipeDependencyOverlay[] | undefined, recipePath: string): void {
  if (overlays && !Array.isArray(overlays)) {
    throw new Error(`Recipe dependency_overlays must be an array: ${recipePath}`)
  }

  for (const overlay of overlays ?? []) {
    if (overlay.kind !== "composer-package") {
      throw new Error(`Recipe dependency overlay kind is unsupported: ${recipePath}`)
    }
    if (!overlay.package || typeof overlay.package !== "string") {
      throw new Error(`Recipe dependency overlays must include package: ${recipePath}`)
    }
    if (!overlay.source || typeof overlay.source !== "string") {
      throw new Error(`Recipe dependency overlays must include source: ${recipePath}`)
    }
    if (!overlay.consumer || typeof overlay.consumer !== "string") {
      throw new Error(`Recipe dependency overlays must include consumer: ${recipePath}`)
    }
    if (overlay.metadata !== undefined && (!overlay.metadata || typeof overlay.metadata !== "object" || Array.isArray(overlay.metadata))) {
      throw new Error(`Recipe dependency overlay metadata must be an object when provided: ${recipePath}`)
    }
  }
}

export async function validateWorkspaceRecipe(recipe: WorkspaceRecipe, recipePath: string): Promise<RecipeValidationIssue[]> {
  return validateWorkspaceRecipeSemantics(recipe, recipePath)
}

export function validateRecipeRuntimePolicy(recipe: WorkspaceRecipe, policy: RuntimePolicy | undefined): RecipeValidationIssue[] {
  if (!policy) {
    return []
  }

  const issues: RecipeValidationIssue[] = []
  const policyValidation = validateRuntimePolicy(policy)
  for (const issue of policyValidation.issues) {
    issues.push({
      code: issue.code,
      path: `$.policy.${issue.field}`,
      message: issue.message,
    })
  }

  const requiredCommands = recipePolicy(recipe).commands
  for (const command of requiredCommands) {
    if (!policy.commands.includes(command)) {
      issues.push({
        code: "runtime-policy-missing-command",
        path: "$.policy.commands",
        message: `Runtime policy commands must include ${command} for this recipe. Run recipe-run --dry-run --json to inspect the resolved plan.policy.commands list.`,
      })
    }
  }

  return issues
}

export async function validateWorkspaceRecipeSemantics(recipe: WorkspaceRecipe, recipePath: string): Promise<RecipeValidationIssue[]> {
  const recipeDirectory = dirname(recipePath)
  const issues: RecipeValidationIssue[] = []
  const addIssue = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message })
  }

  await validateRecipeDistribution(recipe.distribution, recipeDirectory, addIssue)

  if (recipe.runtime?.backendPackage) {
    await validateExistingBackendPackageSource(resolve(recipeDirectory, recipe.runtime.backendPackage.source), "$.runtime.backendPackage.source", addIssue)
  }

  for (const { phase, index, step } of recipeWorkflowSteps(recipe)) {
    const path = `$.workflow.${phase}[${index}]`
    if (!supportedRecipeCommands.has(step.command) && !hostRecipeCommandPattern.test(step.command)) {
      addIssue("unsupported-command", `${path}.command`, `Unsupported recipe command: ${step.command}`)
      continue
    }

    await validateRecipeStepArgs(step, path, addIssue)
  }

  for (const [index, mount] of (recipe.inputs?.mounts ?? []).entries()) {
    const path = `$.inputs.mounts[${index}]`
    await validateExistingMountSource(resolve(recipeDirectory, mount.source), mount.type, `${path}.source`, addIssue)
    validateAbsoluteSandboxPath(mount.target, `${path}.target`, addIssue)
  }

  for (const [index, overlay] of (recipe.runtime?.overlays ?? []).entries()) {
    const path = `$.runtime.overlays[${index}]`
    await validateExistingDirectory(resolve(recipeDirectory, overlay.source), `${path}.source`, addIssue)
    validateAbsoluteSandboxPath(runtimeOverlayTarget(overlay), `${path}.target`, addIssue)
  }

  for (const [index, workspace] of (recipe.inputs?.workspaces ?? []).entries()) {
    const path = `$.inputs.workspaces[${index}]`
    if (workspace.seed.type === "directory") {
      await validateExistingDirectory(resolve(recipeDirectory, workspace.seed.source ?? ""), `${path}.seed.source`, addIssue)
    }

    if (workspace.target) {
      validateAbsoluteSandboxPath(workspace.target, `${path}.target`, addIssue)
    }

    if (workspace.seed.slug && !/^[a-z0-9][a-z0-9-_]*$/i.test(workspace.seed.slug)) {
      addIssue("invalid-slug", `${path}.seed.slug`, `Workspace slug must be a plugin/theme directory slug: ${workspace.seed.slug}`)
    }
  }

  for (const [index, plugin] of recipeExtraPlugins(recipe).entries()) {
    const path = `$.inputs.extra_plugins[${index}]`
    let sourceRef: string
    try {
      sourceRef = recipeExtraPluginSource(plugin)
    } catch (error) {
      addIssue("missing-source", `${path}.source`, error instanceof Error ? error.message : String(error))
      continue
    }
    let source: ReturnType<typeof recipeSource>
    try {
      source = recipeSource(sourceRef, plugin.sha256)
    } catch (error) {
      addIssue("invalid-source", `${path}.source`, error instanceof Error ? error.message : String(error))
      continue
    }
    const sourceRoot = recipeExtraPluginSourceRoot(plugin, recipeDirectory)
    let sourceSubpath = ""
    try {
      sourceSubpath = recipeExtraPluginSourceSubpath(plugin, recipeDirectory)
    } catch (error) {
      addIssue("invalid-source-subdir", `${path}.${plugin.sourceSubdir !== undefined ? "sourceSubdir" : "sourceSubpath"}`, error instanceof Error ? error.message : String(error))
      continue
    }
    const pluginSource = source.type === "local" ? resolve(recipeDirectory, sourceRef) : undefined
    const sourceRootPath = resolve(recipeDirectory, sourceRoot)
    const pluginMountedSource = source.type === "local" ? resolve(sourceRootPath, sourceSubpath) : undefined
    let slug: string
    try {
      slug = recipeExtraPluginSlug(plugin)
    } catch (error) {
      addIssue("invalid-slug", `${path}.slug`, error instanceof Error ? error.message : String(error))
      continue
    }
    const pluginFile = await resolveRecipeExtraPluginFile(plugin, recipeDirectory)

    validateRecipeSource(source, `${path}.source`, addIssue, plugin.sha256)
    if (pluginSource) {
      await validateExistingDirectory(pluginSource, `${path}.source`, addIssue)
    }
    if (sourceRoot !== sourceRef) {
      await validateExistingDirectory(resolve(recipeDirectory, sourceRoot), `${path}.sourceRoot`, addIssue)
    }
    if (pluginMountedSource && !pluginMountedSource.startsWith(`${sourceRootPath}/`) && pluginMountedSource !== sourceRootPath) {
      addIssue("invalid-source-subdir", `${path}.${plugin.sourceSubdir !== undefined ? "sourceSubdir" : "sourceSubpath"}`, "Plugin source subdirectory must stay inside the source root.")
      continue
    }
    if (sourceSubpath && pluginMountedSource) {
      await validateExistingDirectory(pluginMountedSource, `${path}.${plugin.sourceSubdir !== undefined ? "sourceSubdir" : "sourceSubpath"}`, addIssue)
    }

    if (!/^[^/][^:]*\.php$/.test(pluginFile) || pluginFile.includes("..") || !pluginFile.startsWith(`${slug}/`)) {
      addIssue("invalid-plugin-file", `${path}.pluginFile`, `Plugin file must be relative to the mounted plugin slug (${slug}/...).`)
      continue
    }

    if (pluginMountedSource) {
      await validateExistingFile(join(pluginMountedSource, pluginFile.slice(slug.length + 1)), `${path}.pluginFile`, addIssue)
    }
  }

  const extraPluginSlugs = new Set(recipeExtraPlugins(recipe).map((plugin) => recipeExtraPluginSlug(plugin)))
  for (const [index, overlay] of (recipe.inputs?.dependency_overlays ?? []).entries()) {
    const path = `$.inputs.dependency_overlays[${index}]`
    await validateExistingDirectory(resolve(recipeDirectory, overlay.source), `${path}.source`, addIssue)
    if (!extraPluginSlugs.has(overlay.consumer)) {
      addIssue("unknown-dependency-overlay-consumer", `${path}.consumer`, `Dependency overlay consumer must match an inputs.extra_plugins slug: ${overlay.consumer}`)
    }
    if (!isComposerPackageName(overlay.package)) {
      addIssue("invalid-composer-package", `${path}.package`, `Dependency overlay package must be a safe Composer package name: ${overlay.package}`)
      continue
    }

    const consumerPlugin = recipeExtraPlugins(recipe).find((plugin) => recipeExtraPluginSlug(plugin) === overlay.consumer)
    const loadAs = consumerPlugin?.loadAs ?? "plugin"
    validateAbsoluteSandboxPath(`${pluginTarget(overlay.consumer, loadAs)}/vendor/${composerPackageVendorPath(overlay.package)}`, `${path}.target`, addIssue)
  }

  await validateRecipePluginRuntime(recipe.inputs?.pluginRuntime, addIssue)

  for (const [index, fixture] of (recipe.inputs?.fixtureDatabases ?? []).entries()) {
    const path = `$.inputs.fixtureDatabases[${index}]`
    await validateExistingFile(resolve(recipeDirectory, fixture.source), `${path}.source`, addIssue)
    for (const [tableIndex, table] of (fixture.reset?.tables ?? []).entries()) {
      if (!/^[A-Za-z0-9_$]+$/.test(table)) {
        addIssue("invalid-fixture-reset-table", `${path}.reset.tables[${tableIndex}]`, `Fixture database reset table names must be simple identifiers: ${table}`)
      }
    }
  }

  for (const [index, probe] of (recipe.probes ?? []).entries()) {
    const path = `$.probes[${index}].step`
    if (!supportedRecipeCommands.has(probe.step.command)) {
      addIssue("unsupported-command", `${path}.command`, `Unsupported recipe probe command: ${probe.step.command}`)
      continue
    }
    await validateRecipeStepArgs(probe.step, path, addIssue)
  }

  for (const [index, name] of (recipe.inputs?.secretEnv ?? []).entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-secret-env", `$.inputs.secretEnv[${index}]`, `Secret environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
    }
  }

  validateRecipeExternalServiceBoundaries(recipe, addIssue)
  validateRecipeRuntimeServices(recipe, addIssue)

  for (const [name, value] of Object.entries(recipe.inputs?.runtimeEnv ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-runtime-env", `$.inputs.runtimeEnv.${name}`, `Runtime environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
    }
    if (typeof value !== "string") {
      addIssue("invalid-runtime-env-value", `$.inputs.runtimeEnv.${name}`, `Runtime environment values must be strings: ${name}`)
    }
  }

  for (const [index, siteSeed] of (recipe.inputs?.siteSeeds ?? []).entries()) {
    await validateRecipeSiteSeed(siteSeed, recipeDirectory, `$.inputs.siteSeeds[${index}]`, addIssue)
  }

  for (const [index, stagedFile] of (recipe.inputs?.stagedFiles ?? []).entries()) {
    const path = `$.inputs.stagedFiles[${index}]`
    await validateExistingFileOrDirectory(resolve(recipeDirectory, stagedFile.source), `${path}.source`, addIssue)
    validateAbsoluteSandboxPath(stagedFile.target, `${path}.target`, addIssue)
  }

  for (const [index, sourcePackage] of (recipe.inputs?.sourcePackages ?? []).entries()) {
    const path = `$.inputs.sourcePackages[${index}]`
    await validateExistingDirectory(resolve(recipeDirectory, sourcePackage.source), `${path}.source`, addIssue)
    for (const blocker of validateSourcePackage(sourcePackage, path)) {
      addIssue(blocker.code, blocker.path, blocker.message)
    }
  }

  for (const [index, artifact] of (recipe.artifacts?.paths ?? []).entries()) {
    validateAbsoluteSandboxPath(artifact.path, `$.artifacts.paths[${index}].path`, addIssue)
  }

  return issues
}

function validateRecipeRuntimeServices(recipe: WorkspaceRecipe, addIssue: (code: string, path: string, message: string) => void): void {
  const ids = new Set<string>()
  const environment = new Set<string>([
    ...Object.keys(recipe.distribution?.env ?? {}),
    ...Object.keys(recipe.inputs?.runtimeEnv ?? {}),
    ...(recipe.inputs?.secretEnv ?? []),
  ])
  for (const [index, service] of (recipe.inputs?.services ?? []).entries()) {
    const path = `$.inputs.services[${index}]`
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(service.id)) addIssue("invalid-runtime-service-id", `${path}.id`, "Runtime service ids must be stable identifiers.")
    if (ids.has(service.id)) addIssue("duplicate-runtime-service-id", `${path}.id`, `Runtime service ids must be unique: ${service.id}`)
    ids.add(service.id)
    if (service.kind !== "mysql") addIssue("unsupported-runtime-service-kind", `${path}.kind`, `Unsupported managed runtime service kind: ${service.kind}`)
    for (const [output, name] of Object.entries(service.outputs)) {
      if (!/^(host|port|username|password|database)$/.test(output)) addIssue("unknown-runtime-service-output", `${path}.outputs.${output}`, `Unsupported ${service.kind} service output: ${output}`)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) addIssue("invalid-runtime-service-env", `${path}.outputs.${output}`, "Runtime service environment variable names must match /^[A-Z_][A-Z0-9_]*$/.")
      if (environment.has(name)) addIssue("duplicate-runtime-service-env", `${path}.outputs.${output}`, `Runtime service output environment variable is already declared: ${name}`)
      environment.add(name)
    }
  }
}

function validateRecipeExternalServiceBoundaries(recipe: WorkspaceRecipe, addIssue: (code: string, path: string, message: string) => void): void {
  const seenIds = new Set<string>()
  for (const [index, boundary] of (recipe.inputs?.externalServices ?? []).entries()) {
    const path = `$.inputs.externalServices[${index}]`
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(boundary.id)) {
      addIssue("invalid-external-service-id", `${path}.id`, `External service boundary ids must be stable identifiers: ${boundary.id}`)
    }
    if (seenIds.has(boundary.id)) {
      addIssue("duplicate-external-service-id", `${path}.id`, `External service boundary ids must be unique: ${boundary.id}`)
    }
    seenIds.add(boundary.id)

    for (const [hostIndex, host] of [...(boundary.allowedHosts ?? []), ...(boundary.blockedHosts ?? [])].entries()) {
      if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
        addIssue("invalid-external-service-host", `${path}.${hostIndex < (boundary.allowedHosts ?? []).length ? "allowedHosts" : "blockedHosts"}[${hostIndex < (boundary.allowedHosts ?? []).length ? hostIndex : hostIndex - (boundary.allowedHosts ?? []).length}]`, `External service hosts must be hostnames with optional ports: ${host}`)
      }
    }

    for (const [secretIndex, name] of (boundary.secretEnv ?? []).entries()) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        addIssue("invalid-external-service-secret-env", `${path}.secretEnv[${secretIndex}]`, `External service secret environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
      }
    }
  }
}

async function validateRecipeDistribution(distribution: WorkspaceRecipeDistribution | undefined, recipeDirectory: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (!distribution) {
    return
  }

  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(distribution.name)) {
    addIssue("invalid-distribution-name", "$.distribution.name", `Distribution names must be stable identifiers: ${distribution.name}`)
  }

  if (!distribution.wordpress || typeof distribution.wordpress !== "object") {
    addIssue("missing-distribution-wordpress", "$.distribution.wordpress", "Distribution recipes must declare wordpress.root.")
  } else {
    validateAbsoluteSandboxPath(distribution.wordpress.root, "$.distribution.wordpress.root", addIssue)
    if (distribution.wordpress.bootstrapFile) {
      validateAbsoluteSandboxPath(distribution.wordpress.bootstrapFile, "$.distribution.wordpress.bootstrapFile", addIssue)
    }
  }

  for (const [name, value] of Object.entries(distribution.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-distribution-env", `$.distribution.env.${name}`, "Distribution env keys must match /^[A-Z_][A-Z0-9_]*$/.")
    }
    validateDistributionScalar(value, `$.distribution.env.${name}`, addIssue)
  }

  for (const [name, value] of Object.entries(distribution.constants ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-distribution-constant", `$.distribution.constants.${name}`, "Distribution constants must be valid PHP-style constant names.")
    }
    validateDistributionScalar(value, `$.distribution.constants.${name}`, addIssue)
  }

  for (const [index, mount] of (distribution.sourceMounts ?? []).entries()) {
    const path = `$.distribution.sourceMounts[${index}]`
    await validateExistingMountSource(resolve(recipeDirectory, mount.source), mount.type, `${path}.source`, addIssue)
    validateAbsoluteSandboxPath(mount.target, `${path}.target`, addIssue)
  }

  for (const [index, fake] of (distribution.serviceFakes ?? []).entries()) {
    const path = `$.distribution.serviceFakes[${index}]`
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(fake.name)) {
      addIssue("invalid-service-fake-name", `${path}.name`, `Service fake names must be stable identifiers: ${fake.name}`)
    }
    await validateExistingFile(resolve(recipeDirectory, fake.source), `${path}.source`, addIssue)
    if (fake.load && !["pre-bootstrap", "mu-plugin", "manual"].includes(fake.load)) {
      addIssue("invalid-service-fake-load", `${path}.load`, "Service fake load must be pre-bootstrap, mu-plugin, or manual.")
    }
    if (fake.sideEffectsArtifact && !isRelativeArtifactPath(fake.sideEffectsArtifact)) {
      addIssue("invalid-service-fake-artifact", `${path}.sideEffectsArtifact`, "Service fake sideEffectsArtifact must be a relative artifact path.")
    }
  }

  for (const [index, alias] of (distribution.routeAliases ?? []).entries()) {
    const path = `$.distribution.routeAliases[${index}]`
    if (!alias.host && !alias.path) {
      addIssue("missing-route-alias-source", path, "Route aliases must declare at least one host or path.")
    }
    if (alias.path) {
      validateAbsoluteSandboxPath(alias.path, `${path}.path`, addIssue)
    }
    if (!alias.target || typeof alias.target !== "string") {
      addIssue("missing-route-alias-target", `${path}.target`, "Route aliases require a target.")
    }
  }

  for (const [index, probe] of (distribution.startupProbes ?? []).entries()) {
    validateDistributionStartupProbe(probe, `$.distribution.startupProbes[${index}]`, addIssue)
  }

  for (const [index, artifact] of (distribution.setupArtifacts ?? []).entries()) {
    const path = `$.distribution.setupArtifacts[${index}]`
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(artifact.name)) {
      addIssue("invalid-distribution-setup-artifact-name", `${path}.name`, `Distribution setup artifact names must be stable identifiers: ${artifact.name}`)
    }
    if (artifact.type !== "sql") {
      addIssue("invalid-distribution-setup-artifact-type", `${path}.type`, "Distribution setup artifacts currently support sql only.")
    }
    await validateExistingFile(resolve(recipeDirectory, artifact.source), `${path}.source`, addIssue)
  }

  for (const [index, artifact] of (distribution.artifacts ?? []).entries()) {
    if (!artifact.path || !isRelativeArtifactPath(artifact.path)) {
      addIssue("invalid-distribution-artifact", `$.distribution.artifacts[${index}].path`, "Distribution artifact paths must be relative artifact paths.")
    }
  }

  for (const [index, host] of (distribution.safety?.allowedHosts ?? []).entries()) {
    if ((distribution.safety?.network ?? "deny") !== "declared") {
      addIssue("undeclared-distribution-network", `$.distribution.safety.allowedHosts[${index}]`, "Distribution allowedHosts require safety.network to be declared.")
    }
    if (!/^[a-z0-9.-]+$/i.test(host)) {
      addIssue("invalid-distribution-network-host", `$.distribution.safety.allowedHosts[${index}]`, `Distribution allowed host is invalid: ${host}`)
    }
  }

  for (const [index, name] of (distribution.safety?.secretEnv ?? []).entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-distribution-secret-env", `$.distribution.safety.secretEnv[${index}]`, `Distribution secret environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
    }
  }
}

function validateDistributionStartupProbe(probe: WorkspaceRecipeDistributionStartupProbe, path: string, addIssue: (code: string, path: string, message: string) => void): void {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(probe.name)) {
    addIssue("invalid-startup-probe-name", `${path}.name`, `Startup probe names must be stable identifiers: ${probe.name}`)
  }

  if (probe.type === "http" || probe.type === "browser") {
    if (!probe.url) {
      addIssue("missing-startup-probe-url", `${path}.url`, `${probe.type} startup probes require url.`)
    }
    return
  }

  if (probe.type === "wp-cli") {
    if (!probe.command) {
      addIssue("missing-startup-probe-command", `${path}.command`, "wp-cli startup probes require command.")
    }
    return
  }

  if (probe.type === "php") {
    if (!probe.code) {
      addIssue("missing-startup-probe-code", `${path}.code`, "php startup probes require code.")
    }
    return
  }

  addIssue("unsupported-startup-probe", `${path}.type`, `Unsupported startup probe type: ${probe.type}`)
}

function validateDistributionScalar(value: unknown, path: string, addIssue: (code: string, path: string, message: string) => void): void {
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
    addIssue("invalid-distribution-scalar", path, "Distribution env/constants values must be string, number, boolean, or null.")
  }
}

function isRelativeArtifactPath(path: string): boolean {
  try {
    safeArtifactRelativePath(path)
    return true
  } catch {
    return false
  }
}

export function recipeWorkflowSteps(recipe: WorkspaceRecipe): RecipeWorkflowStepRef[] {
  return [
    ...(recipe.workflow.before ?? []).map((step, index) => ({ phase: "before" as const, index, step })),
    ...recipe.workflow.steps.map((step, index) => ({ phase: "steps" as const, index, step })),
    ...(recipe.workflow.after ?? []).map((step, index) => ({ phase: "after" as const, index, step })),
    ...recipeFuzzWorkflowSteps(recipe),
  ]
}

function recipeFuzzWorkflowSteps(recipe: WorkspaceRecipe): RecipeWorkflowStepRef[] {
  const phaseNames: WorkspaceRecipeFuzzCasePhase[] = ["setup", "action", "assert", "teardown"]
  return (recipe.fuzzRun?.cases ?? []).flatMap((fuzzCase, fuzzCaseIndex) => phaseNames.flatMap((fuzzPhase) => (fuzzCase.phases[fuzzPhase] ?? []).map((step, fuzzStepIndex) => ({
    phase: `fuzz:${fuzzPhase}` as const,
    index: fuzzStepIndex,
    step,
    fuzzCaseId: fuzzCase.case_id,
    fuzzCaseIndex,
    fuzzPhase,
    fuzzStepIndex,
  }))))
}

export function recipePolicy(recipe: WorkspaceRecipe): RuntimePolicy {
  const pluginRuntimeCommands = [
    ...(recipe.inputs?.pluginRuntime?.setup ?? []),
    ...(recipe.inputs?.pluginRuntime?.healthProbes ?? []).map(pluginRuntimeHealthProbeStep),
  ].map((step) => step.command)
  const distributionStartupProbeCommands = (recipe.distribution?.startupProbes ?? []).flatMap((probe) => {
    if (probe.type === "wp-cli") return ["wordpress.wp-cli"]
    if (probe.type === "php") return ["wordpress.run-php"]
    if (probe.type === "browser") return ["wordpress.browser-probe"]
    if (probe.type === "http") return ["wordpress.http-request"]
    return []
  })
  const commands = [
    ...effectivePolicyCommandsFor(recipeWorkflowSteps(recipe).map(({ step }) => step.command), cliRecipeCommandDefinitions),
    ...effectivePolicyCommandsFor(pluginRuntimeCommands, cliRecipeCommandDefinitions),
    ...effectivePolicyCommandsFor(distributionStartupProbeCommands, cliRecipeCommandDefinitions),
    ...effectivePolicyCommandsFor((recipe.probes ?? []).map((probe) => probe.step.command), cliRecipeCommandDefinitions),
  ]
  if (recipeWorkflowSteps(recipe).some(({ step }) => step.command === "wordpress.bench")) {
    commands.unshift("wordpress.run-php")
  }
  if (recipeWorkflowSteps(recipe).some(({ step }) => step.command === "wordpress.bench" && recipeBenchStepUsesWpCli(step))) {
    commands.unshift("wordpress.wp-cli")
  }
  if (recipeExtraPlugins(recipe).length > 0) {
    commands.unshift("wordpress.run-php")
  }
  if ((recipe.inputs?.siteSeeds ?? []).some((siteSeed) => siteSeed.type === "fixture")) {
    commands.unshift("wordpress.run-php")
  }
  if ((recipe.inputs?.fixtureDatabases ?? []).length > 0 || workspaceRecipeRuntimeCollectedArtifacts(recipe).length > 0) {
    commands.unshift("wordpress.run-php")
  }
  if ((recipe.distribution?.setupArtifacts ?? []).length > 0) {
    commands.unshift("wordpress.run-php")
  }
  // Auto-grant the evaluate capability when a browser-actions step opts into the
  // arbitrary-JS escape hatch by including an evaluate step. Recipe authors opt in
  // by writing the step; direct `run` invocations still control the gate via --policy.
  if (recipeWorkflowSteps(recipe).some(({ step }) => (step.command === "wordpress.browser-actions" || step.command === "wordpress.browser-scenario") && recipeStepUsesEvaluate(step))) {
    commands.push("wordpress.browser-actions.evaluate")
  }

  return {
    ...defaultPolicy,
    commands: [...new Set(commands)],
  }
}

function validateFixtureDatabases(fixtureDatabases: WorkspaceRecipeFixtureDatabase[] | undefined, recipePath: string): void {
  if (fixtureDatabases && !Array.isArray(fixtureDatabases)) {
    throw new Error(`Recipe fixtureDatabases must be an array: ${recipePath}`)
  }

  for (const fixture of fixtureDatabases ?? []) {
    if (!fixture || typeof fixture !== "object") {
      throw new Error(`Recipe fixtureDatabases entries must be objects: ${recipePath}`)
    }
    if (!fixture.name || typeof fixture.name !== "string") {
      throw new Error(`Recipe fixtureDatabases entries must include name: ${recipePath}`)
    }
    if (!fixture.version || typeof fixture.version !== "string") {
      throw new Error(`Recipe fixtureDatabases entries must include version: ${recipePath}`)
    }
    if (!fixture.source || typeof fixture.source !== "string") {
      throw new Error(`Recipe fixtureDatabases entries must include source: ${recipePath}`)
    }
    if (fixture.format !== undefined && fixture.format !== "sql") {
      throw new Error(`Recipe fixtureDatabases format is unsupported: ${recipePath}`)
    }
    if (fixture.reset?.strategy !== undefined && fixture.reset.strategy !== "none" && fixture.reset.strategy !== "truncate-tables") {
      throw new Error(`Recipe fixtureDatabases reset strategy is unsupported: ${recipePath}`)
    }
    if (fixture.reset?.tables !== undefined && !Array.isArray(fixture.reset.tables)) {
      throw new Error(`Recipe fixtureDatabases reset tables must be an array: ${recipePath}`)
    }
  }
}

function validateRecipeProbes(probes: WorkspaceRecipeProbe[] | undefined, recipePath: string): void {
  if (probes && !Array.isArray(probes)) {
    throw new Error(`Recipe probes must be an array: ${recipePath}`)
  }

  for (const probe of probes ?? []) {
    if (!probe || typeof probe !== "object") {
      throw new Error(`Recipe probes entries must be objects: ${recipePath}`)
    }
    if (!probe.name || typeof probe.name !== "string") {
      throw new Error(`Recipe probes entries must include name: ${recipePath}`)
    }
    if (!probe.step || typeof probe.step !== "object" || !probe.step.command) {
      throw new Error(`Recipe probes entries must include a step command: ${recipePath}`)
    }
    if (probe.step.args !== undefined && !Array.isArray(probe.step.args)) {
      throw new Error(`Recipe probes step args must be arrays: ${recipePath}`)
    }
  }
}

function validateRecipeFuzzRun(fuzzRun: WorkspaceRecipe["fuzzRun"] | undefined, recipePath: string): void {
  if (fuzzRun === undefined) {
    return
  }
  if (!fuzzRun || typeof fuzzRun !== "object" || Array.isArray(fuzzRun)) {
    throw new Error(`Recipe fuzzRun must be an object: ${recipePath}`)
  }
  if (fuzzRun.schema !== "wp-codebox/fuzz-run/v1") {
    throw new Error(`Recipe fuzzRun schema is unsupported: ${recipePath}`)
  }
  if (!Array.isArray(fuzzRun.cases) || fuzzRun.cases.length === 0) {
    throw new Error(`Recipe fuzzRun cases must be a non-empty array: ${recipePath}`)
  }

  const seenCaseIds = new Set<string>()
  for (const [caseIndex, fuzzCase] of fuzzRun.cases.entries()) {
    const casePath = `$.fuzzRun.cases[${caseIndex}]`
    if (!fuzzCase || typeof fuzzCase !== "object") {
      throw new Error(`Recipe fuzzRun cases entries must be objects: ${recipePath}`)
    }
    if (!/^[A-Za-z0-9._-]+$/.test(fuzzCase.case_id ?? "")) {
      throw new Error(`Recipe fuzzRun case_id must be deterministic and URL-safe at ${casePath}: ${recipePath}`)
    }
    if (seenCaseIds.has(fuzzCase.case_id)) {
      throw new Error(`Recipe fuzzRun case_id must be unique: ${fuzzCase.case_id}: ${recipePath}`)
    }
    seenCaseIds.add(fuzzCase.case_id)

    const phases = fuzzCase.phases
    if (!phases || typeof phases !== "object" || Array.isArray(phases)) {
      throw new Error(`Recipe fuzzRun phases must be an object at ${casePath}: ${recipePath}`)
    }
    if (!Array.isArray(phases.action) || phases.action.length === 0) {
      throw new Error(`Recipe fuzzRun cases require at least one action step at ${casePath}: ${recipePath}`)
    }
    for (const phase of ["setup", "action", "assert", "teardown"] as const) {
      const steps = phases[phase]
      if (steps === undefined) {
        continue
      }
      if (!Array.isArray(steps)) {
        throw new Error(`Recipe fuzzRun ${phase} phase must be an array at ${casePath}: ${recipePath}`)
      }
      for (const [stepIndex, step] of steps.entries()) {
        if (!step || typeof step.command !== "string" || step.command === "") {
          throw new Error(`Recipe fuzzRun ${phase}[${stepIndex}] entries must include a command at ${casePath}: ${recipePath}`)
        }
        if (step.args !== undefined && !Array.isArray(step.args)) {
          throw new Error(`Recipe fuzzRun ${phase}[${stepIndex}] args must be arrays at ${casePath}: ${recipePath}`)
        }
      }
    }
  }
}

function validateDeclaredArtifacts(paths: WorkspaceRecipeDeclaredArtifact[] | undefined, recipePath: string): void {
  if (paths && !Array.isArray(paths)) {
    throw new Error(`Recipe artifacts.paths must be an array: ${recipePath}`)
  }

  for (const artifact of paths ?? []) {
    if (!artifact || typeof artifact !== "object") {
      throw new Error(`Recipe artifacts.paths entries must be objects: ${recipePath}`)
    }
    if (!artifact.name || typeof artifact.name !== "string") {
      throw new Error(`Recipe artifacts.paths entries must include name: ${recipePath}`)
    }
    if (!artifact.path || typeof artifact.path !== "string") {
      throw new Error(`Recipe artifacts.paths entries must include path: ${recipePath}`)
    }
  }
}

export function runPolicy(command: string): RuntimePolicy {
  return {
    ...defaultPolicy,
    commands: [...new Set([...defaultPolicy.commands, command])],
  }
}

export function pluginRuntimeHealthProbeStep(probe: WorkspaceRecipePluginRuntimeHealthProbe): WorkspaceRecipe["workflow"]["steps"][number] {
  if (probe.type === "plugin-active") {
    return {
      command: "wordpress.run-php",
      args: [`code=${pluginRuntimePluginActiveProbeCode(probe.pluginFile ?? "")}`],
    }
  }

  if (probe.type === "wp-cli") {
    return {
      command: "wordpress.wp-cli",
      args: [`command=${probe.command ?? ""}`],
    }
  }

  return {
    command: "wordpress.run-php",
    args: [`code=${probe.code ?? ""}`],
  }
}

export function recipeStepArgValue(args: string[], key: string): string | undefined {
  return commandArgValue(args, key)
}

export function recipeWpCliCommandFromArgs(args: string[]): string {
  return recipeStepArgValue(args, "command")?.trim() ?? args.join(" ").trim()
}

async function validateRecipePluginRuntime(pluginRuntime: WorkspaceRecipePluginRuntime | undefined, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (!pluginRuntime) {
    return
  }

  const memoryLimit = pluginRuntime.php?.memoryLimit
  if (memoryLimit !== undefined && !/^[0-9]+[KMG]?$/.test(memoryLimit)) {
    addIssue("invalid-plugin-runtime-memory-limit", "$.inputs.pluginRuntime.php.memoryLimit", "Plugin runtime memoryLimit must be a PHP shorthand size such as 256M.")
  }

  const maxExecutionTime = pluginRuntime.php?.maxExecutionTime
  if (maxExecutionTime !== undefined && (!Number.isInteger(maxExecutionTime) || maxExecutionTime < 0 || maxExecutionTime > 3600)) {
    addIssue("invalid-plugin-runtime-max-execution-time", "$.inputs.pluginRuntime.php.maxExecutionTime", "Plugin runtime maxExecutionTime must be an integer from 0 through 3600.")
  }

  for (const [name, value] of Object.entries(pluginRuntime.php?.iniEntries ?? {})) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      addIssue("invalid-plugin-runtime-php-ini-entry", `$.inputs.pluginRuntime.php.iniEntries.${name}`, "PHP ini entry names may contain only letters, numbers, dots, underscores, and hyphens.")
    }
    if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
      addIssue("invalid-plugin-runtime-php-ini-entry-value", `$.inputs.pluginRuntime.php.iniEntries.${name}`, "PHP ini entry values must be string, number, boolean, or null.")
    }
  }

  for (const [name, value] of Object.entries(pluginRuntime.php?.bootstrapIniEntries ?? {})) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      addIssue("invalid-plugin-runtime-bootstrap-php-ini-entry", `$.inputs.pluginRuntime.php.bootstrapIniEntries.${name}`, "Bootstrap PHP ini entry names may contain only letters, numbers, dots, underscores, and hyphens.")
    }
    if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
      addIssue("invalid-plugin-runtime-bootstrap-php-ini-entry-value", `$.inputs.pluginRuntime.php.bootstrapIniEntries.${name}`, "Bootstrap PHP ini entry values must be string, number, boolean, or null.")
    }
  }

  for (const [name, value] of Object.entries(pluginRuntime.wpConfigDefines ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      addIssue("invalid-plugin-runtime-wp-config-define", `$.inputs.pluginRuntime.wpConfigDefines.${name}`, "wpConfigDefines keys must be valid PHP constant names.")
    }
    if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
      addIssue("invalid-plugin-runtime-wp-config-define-value", `$.inputs.pluginRuntime.wpConfigDefines.${name}`, "wpConfigDefines values must be string, number, boolean, or null.")
    }
  }

  for (const [index, step] of (pluginRuntime.setup ?? []).entries()) {
    const path = `$.inputs.pluginRuntime.setup[${index}]`
    if (!supportedRecipeCommands.has(step.command)) {
      addIssue("unsupported-plugin-runtime-setup-command", `${path}.command`, `Unsupported plugin runtime setup command: ${step.command}`)
      continue
    }
    await validateRecipeStepArgs(step, path, addIssue)
  }

  for (const [index, probe] of (pluginRuntime.healthProbes ?? []).entries()) {
    const path = `$.inputs.pluginRuntime.healthProbes[${index}]`
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(probe.name)) {
      addIssue("invalid-plugin-runtime-health-probe-name", `${path}.name`, `Plugin runtime health probe names must be stable identifiers: ${probe.name}`)
    }
    if (probe.type === "plugin-active") {
      if (!probe.pluginFile || !/^[^/][^:]*\.php$/.test(probe.pluginFile) || probe.pluginFile.includes("..")) {
        addIssue("invalid-plugin-runtime-health-probe-plugin", `${path}.pluginFile`, "plugin-active health probes require a relative pluginFile ending in .php.")
      }
      continue
    }
    if (probe.type === "php") {
      if (!probe.code || typeof probe.code !== "string") {
        addIssue("missing-plugin-runtime-health-probe-code", `${path}.code`, "php health probes require inline code.")
      }
      continue
    }
    if (probe.type === "wp-cli") {
      if (!probe.command || typeof probe.command !== "string") {
        addIssue("missing-plugin-runtime-health-probe-command", `${path}.command`, "wp-cli health probes require a command.")
      }
      continue
    }
    addIssue("unsupported-plugin-runtime-health-probe", `${path}.type`, `Unsupported plugin runtime health probe type: ${probe.type}`)
  }
}

async function validateRecipeSiteSeed(siteSeed: WorkspaceRecipeSiteSeed, recipeDirectory: string, path: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(siteSeed.name)) {
    addIssue("invalid-site-seed-name", `${path}.name`, `Site seed names must be stable identifiers: ${siteSeed.name}`)
  }

  if (siteSeed.type === "fixture") {
    await validateExistingFile(resolve(recipeDirectory, siteSeed.source ?? ""), `${path}.source`, addIssue)
    if (siteSeed.format === undefined || siteSeed.format === "json") {
      try {
        const rawSeed = JSON.parse(await readFile(resolve(recipeDirectory, siteSeed.source ?? ""), "utf8"))
        assertFixtureImportDeterministicIdsSupported(siteSeed, rawSeed)
      } catch (error) {
        if (siteSeed.deterministicIds?.onUnsupported === "block") {
          addIssue("unsupported-deterministic-site-seed-ids", `${path}.deterministicIds`, error instanceof Error ? error.message : String(error))
        }
      }
    } else if (siteSeed.deterministicIds?.strategy === "numeric" && siteSeed.deterministicIds.onUnsupported === "block") {
      addIssue("unsupported-deterministic-site-seed-ids", `${path}.deterministicIds`, "Numeric deterministic IDs require importer-specific support; no generic platform API can guarantee primary keys.")
    }
  }

  if (siteSeed.deterministicIds) {
    if (!["platform-identifiers", "numeric"].includes(siteSeed.deterministicIds.strategy)) {
      addIssue("invalid-deterministic-site-seed-strategy", `${path}.deterministicIds.strategy`, "Deterministic ID strategy must be platform-identifiers or numeric.")
    }
    if (!["block", "warn"].includes(siteSeed.deterministicIds.onUnsupported)) {
      addIssue("invalid-deterministic-site-seed-policy", `${path}.deterministicIds.onUnsupported`, "Unsupported deterministic ID policy must be block or warn.")
    }
  }

  validateSiteSeedBootstrap(siteSeed, path, addIssue)

  if (siteSeed.type === "parent_site" && siteSeed.source) {
    addIssue("invalid-site-seed-source", `${path}.source`, "Parent-site seed declarations must not name a source file until explicit parent export support lands.")
  }

  const scopeEntries = Object.entries(siteSeed.scopes).filter(([, value]) => value !== undefined && value !== false)
  if (scopeEntries.length === 0) {
    addIssue("missing-site-seed-scopes", `${path}.scopes`, "Site seed declarations must opt in to at least one bounded scope.")
  }

  for (const [scopeName, scope] of scopeEntries) {
    if (scope === true) {
      continue
    }

    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      addIssue("invalid-site-seed-scope", `${path}.scopes.${scopeName}`, "Site seed scopes must be objects or explicit true flags where supported.")
      continue
    }

    validateSiteSeedScopeBounds(scope as NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>, `${path}.scopes.${scopeName}`, scopeName, siteSeed.type, addIssue)
  }
}

function validateSiteSeedBootstrap(siteSeed: WorkspaceRecipeSiteSeed, path: string, addIssue: (code: string, path: string, message: string) => void): void {
  const bootstrap = siteSeed.bootstrap
  if (!bootstrap) {
    return
  }

  if (bootstrap.multisite?.enabled && siteSeed.type === "fixture") {
    addIssue("unsupported-site-seed-multisite-bootstrap", `${path}.bootstrap.multisite`, "Multisite bootstrap is a reusable declaration only until the runtime exposes a platform setup primitive.")
  }

  for (const [index, site] of (bootstrap.multisite?.sites ?? []).entries()) {
    if (!site.domain || typeof site.domain !== "string") {
      addIssue("invalid-site-seed-bootstrap-domain", `${path}.bootstrap.multisite.sites[${index}].domain`, "Bootstrap sites require a domain.")
    }
  }

  for (const [index, domain] of (bootstrap.domains ?? []).entries()) {
    if (!domain.domain || typeof domain.domain !== "string") {
      addIssue("invalid-site-seed-bootstrap-domain", `${path}.bootstrap.domains[${index}].domain`, "Bootstrap domains require a domain.")
    }
  }
}

function validateSiteSeedScopeBounds(scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>, path: string, scopeName: string, seedType: WorkspaceRecipeSiteSeed["type"], addIssue: (code: string, path: string, message: string) => void): void {
  const maxRecords = scope.maxRecords
  if (maxRecords !== undefined && (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100)) {
    addIssue("invalid-site-seed-bound", `${path}.maxRecords`, "Site seed maxRecords must be an integer from 1 through 100.")
  }

  if (seedType === "parent_site" && maxRecords === undefined && !hasExplicitSiteSeedSelectors(scope)) {
    addIssue("unbounded-site-seed-scope", path, "Parent-site scopes require maxRecords or explicit ids/slugs/names selectors before any future export can run.")
  }

  if (scopeName === "options" && (!scope.names || scope.names.length === 0)) {
    addIssue("unbounded-site-seed-options", `${path}.names`, "Option seed scopes must name explicit option keys; wildcard option export is not supported.")
  }

  if (scopeName === "users" && scope.anonymize === false) {
    addIssue("unsafe-site-seed-users", `${path}.anonymize`, "User seed scopes must keep anonymization enabled unless a future importer explicitly supports reviewed identities.")
  }

  if (scopeName === "media" && scope.includeFiles === true && seedType === "parent_site") {
    addIssue("unsafe-site-seed-media-files", `${path}.includeFiles`, "Parent-site media file copying is outside this dry-run-only slice; declare metadata selectors without includeFiles.")
  }
}

export function hasExplicitSiteSeedSelectors(scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>): boolean {
  return [scope.ids, scope.slugs, scope.names].some((values) => Array.isArray(values) && values.length > 0)
}

async function validateRecipeStepArgs(step: WorkspaceRecipe["workflow"]["steps"][number], path: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  validateRecipeStepDescriptorArgs(step, path, addIssue)

  if (step.command === "wordpress.run-php" || step.command === "wordpress.phpunit" || step.command === "wordpress.core-phpunit") {
    const code = recipeStepArgValue(step.args ?? [], "code")
    const codeFile = recipeStepArgValue(step.args ?? [], "code-file")
    const pluginSlug = recipeStepArgValue(step.args ?? [], "plugin-slug")
    if (!code && !codeFile && step.command === "wordpress.run-php") {
      addIssue("missing-code", `${path}.args`, `${step.command} requires code=<php> or code-file=<path>.`)
    }
    if (!code && !codeFile && step.command === "wordpress.phpunit" && !pluginSlug) {
      addIssue("missing-plugin-slug", `${path}.args`, "wordpress.phpunit requires plugin-slug=<slug> when code/code-file is not provided.")
    }
    if (code && codeFile) {
      addIssue("ambiguous-code", `${path}.args`, `${step.command} accepts either code=<php> or code-file=<path>, not both.`)
    }
    if (codeFile) {
      await validateExistingFile(resolve(codeFile), `${path}.args`, addIssue)
    }
    return
  }

  if (step.command === "wordpress.wp-cli" && recipeWpCliCommandFromArgs(step.args ?? []).length === 0) {
    addIssue("missing-command", `${path}.args`, "wordpress.wp-cli requires a non-empty command.")
    return
  }

  if (step.command === "wordpress.bench") {
    if (!recipeStepArgValue(step.args ?? [], "plugin-slug")?.trim()) {
      addIssue("missing-plugin-slug", `${path}.args`, "wordpress.bench requires plugin-slug=<slug>.")
    }

    validateInlineJsonArg(step, "workloads-json", "array", path, addIssue)
    validateInlineJsonArg(step, "scenario-ids-json", "array", path, addIssue)
    validateInlineJsonArg(step, "lifecycle-json", "object", path, addIssue)
    const resetPolicy = validateInlineJsonArg(step, "reset-policy-json", "object", path, addIssue)
    if (resetPolicy && typeof resetPolicy === "object" && !Array.isArray(resetPolicy)) {
      for (const key of ["betweenIterations", "betweenScenarios"] as const) {
        const value = (resetPolicy as Record<string, unknown>)[key]
        if (value !== undefined && value !== "none" && value !== "object-cache") {
          addIssue("invalid-reset-policy", `${path}.args`, `wordpress.bench reset-policy-json ${key} must be none or object-cache.`)
        }
      }
    }
    return
  }

  if (step.command === "wordpress.browser-probe") {
    for (const assertion of (step.args ?? []).filter((arg) => arg.startsWith("assert=")).map((arg) => arg.slice("assert=".length).trim())) {
      const rawNormalized = assertion.startsWith("advisory:") ? assertion.slice("advisory:".length).trim() : assertion
      const frameSeparator = rawNormalized.startsWith("frame:") || rawNormalized.startsWith("frame-url:") ? rawNormalized.indexOf("|") : -1
      const normalized = frameSeparator > -1 ? rawNormalized.slice(frameSeparator + 1).trim() : rawNormalized
      const frameAssertionIsSupported = frameSeparator === -1 || normalized.startsWith("exists:") || normalized.startsWith("not-exists:") || normalized.startsWith("visible:") || normalized.startsWith("hidden:") || normalized.startsWith("count:") || normalized.startsWith("text:") || normalized.startsWith("attr:")
      if (
        !frameAssertionIsSupported
        || !normalized.startsWith("exists:")
        && !normalized.startsWith("not-exists:")
        && !normalized.startsWith("visible:")
        && !normalized.startsWith("hidden:")
        && !normalized.startsWith("count:")
        && !normalized.startsWith("text:")
        && !normalized.startsWith("attr:")
        && normalized !== "no-console-errors"
        && normalized !== "no-page-errors"
        && normalized !== "no-errors"
        && !normalized.startsWith("request-count-by-host:")
        && !normalized.startsWith("request-count-by-type:")
        && !normalized.startsWith("total-transfer-size")
        && !normalized.startsWith("metric:")
        && !/^[a-zA-Z_][a-zA-Z0-9_]*(>=|<=|==|!=|=|>|<)\s*\d+(?:\.\d+)?$/.test(normalized)
      ) {
        addIssue("invalid-assert", `${path}.args`, `wordpress.browser-probe assert does not support: ${assertion}`)
      }
    }
    return
  }

  if (step.command === "wordpress.editor-canvas-probe") {
    if (!recipeStepArgValue(step.args ?? [], "url")?.trim()) {
      addIssue("missing-url", `${path}.args`, "wordpress.editor-canvas-probe requires url=<path-or-url>.")
    }

    const timeoutMs = recipeStepArgValue(step.args ?? [], "timeout-ms") ?? recipeStepArgValue(step.args ?? [], "timeoutMs")
    if (timeoutMs && !/^[1-9]\d*$/.test(timeoutMs)) {
      addIssue("invalid-timeout-ms", `${path}.args`, "wordpress.editor-canvas-probe timeout-ms must be a positive integer.")
    }

    const timeout = recipeStepArgValue(step.args ?? [], "timeout")
    if (timeout && /^\d+(?:\.\d+)?(?:ms|s)$/.test(timeout) === false) {
      addIssue("invalid-duration", `${path}.args`, "wordpress.editor-canvas-probe timeout must look like 500ms or 2s.")
    }

    const screenshot = recipeStepArgValue(step.args ?? [], "screenshot")
    if (screenshot && !["1", "0", "true", "false", "yes", "no", "on", "off"].includes(screenshot.toLowerCase())) {
      addIssue("invalid-screenshot", `${path}.args`, "wordpress.editor-canvas-probe screenshot must be true or false.")
    }

    const capture = recipeStepArgValue(step.args ?? [], "capture")
    if (capture) {
      for (const item of capture.split(",").map((value) => value.trim()).filter(Boolean)) {
        if (item !== "screenshot") {
          addIssue("invalid-capture", `${path}.args`, `wordpress.editor-canvas-probe capture does not support: ${item}`)
        }
      }
    }

    const selectorGroupsJson = recipeStepArgValue(step.args ?? [], "selector-groups-json")
    if (selectorGroupsJson && !selectorGroupsJson.startsWith("@")) {
      try {
        const parsed = JSON.parse(selectorGroupsJson) as unknown
        if (!Array.isArray(parsed)) {
          addIssue("invalid-selector-groups-json", `${path}.args`, "wordpress.editor-canvas-probe selector-groups-json must be a JSON array.")
        }
      } catch (error) {
        addIssue("invalid-selector-groups-json", `${path}.args`, `wordpress.editor-canvas-probe selector-groups-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return
  }

  if (step.command === "wordpress.browser-actions") {
    const stepsJson = recipeStepArgValue(step.args ?? [], "steps-json")

    if (stepsJson && !stepsJson.startsWith("@")) {
      let parsed: unknown
      try {
        parsed = JSON.parse(stepsJson)
      } catch (error) {
        addIssue("invalid-steps-json", `${path}.args`, `wordpress.browser-actions steps-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
        parsed = undefined
      }
      if (parsed !== undefined) {
        const result = validateBrowserInteractionScript(parsed)
        for (const issue of result.issues) {
          addIssue("invalid-step", `${path}.args`, `wordpress.browser-actions steps-json[${issue.index}]: ${issue.message}`)
        }
      }
    }
    return
  }

  if (step.command === "wordpress.browser-scenario") {
    const scenarioJson = recipeStepArgValue(step.args ?? [], "scenario-json")

    if (scenarioJson && !scenarioJson.startsWith("@")) {
      try {
        const parsed = JSON.parse(scenarioJson) as unknown
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          addIssue("invalid-scenario-json", `${path}.args`, "wordpress.browser-scenario scenario-json must be a JSON object.")
        } else {
          const steps = (parsed as { steps?: unknown }).steps
          if (steps !== undefined) {
            const result = validateBrowserInteractionScript(normalizeBrowserScenarioStepsForValidation(steps))
            for (const issue of result.issues) {
              addIssue("invalid-step", `${path}.args`, `wordpress.browser-scenario scenario-json.steps[${issue.index}]: ${issue.message}`)
            }
          }
        }
      } catch (error) {
        addIssue("invalid-scenario-json", `${path}.args`, `wordpress.browser-scenario scenario-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const stepsJson = recipeStepArgValue(step.args ?? [], "steps-json")
    if (stepsJson && !stepsJson.startsWith("@")) {
      let parsed: unknown
      try {
        parsed = JSON.parse(stepsJson)
      } catch (error) {
        addIssue("invalid-steps-json", `${path}.args`, `wordpress.browser-scenario steps-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (parsed !== undefined) {
        const result = validateBrowserInteractionScript(parsed)
        for (const issue of result.issues) {
          addIssue("invalid-step", `${path}.args`, `wordpress.browser-scenario steps-json[${issue.index}]: ${issue.message}`)
        }
      }
    }
    return
  }

  if (step.command === "wordpress.editor-actions") {
    const stepsJson = recipeStepArgValue(step.args ?? [], "steps-json")

    if (stepsJson && !stepsJson.startsWith("@")) {
      let parsed: unknown
      try {
        parsed = JSON.parse(stepsJson)
      } catch (error) {
        addIssue("invalid-steps-json", `${path}.args`, `wordpress.editor-actions steps-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
        parsed = undefined
      }
      if (parsed !== undefined && !Array.isArray(parsed)) {
        addIssue("invalid-steps-json", `${path}.args`, "wordpress.editor-actions steps-json must be a JSON array.")
      }
    }
    return
  }

  if (step.command === "wordpress.ability") {
    if (!recipeStepArgValue(step.args ?? [], "name")?.trim()) {
      addIssue("missing-ability-name", `${path}.args`, "wordpress.ability requires name=<ability-name>.")
    }

    const input = recipeStepArgValue(step.args ?? [], "input")
    if (input) {
      try {
        JSON.parse(input)
      } catch (error) {
        addIssue("invalid-ability-input", `${path}.args`, `wordpress.ability input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

function validateRecipeStepDescriptorArgs(step: WorkspaceRecipe["workflow"]["steps"][number], path: string, addIssue: (code: string, path: string, message: string) => void): void {
  const descriptor = commandValidationDescriptorFor(step.command)
  if (!descriptor) {
    return
  }

  const args = step.args ?? []
  for (const requirement of descriptor.requiredArgs ?? []) {
    if (!recipeStepArgValue(args, requirement.name)?.trim()) {
      addIssue(requirement.code, `${path}.args`, requirement.message)
    }
  }

  for (const requirement of descriptor.requiredAnyArgs ?? []) {
    if (!requirement.names.some((name) => Boolean(recipeStepArgValue(args, name)?.trim()))) {
      addIssue(requirement.code, `${path}.args`, requirement.message)
    }
  }

  for (const rule of descriptor.argRules ?? []) {
    validateRecipeStepDescriptorArgRule(args, rule, `${path}.args`, addIssue)
  }
}

function validateRecipeStepDescriptorArgRule(args: string[], rule: CommandArgValidationDescriptor, issuePath: string, addIssue: (code: string, path: string, message: string) => void): void {
  const raw = recipeStepArgValue(args, rule.name)
  if (!raw) {
    return
  }

  if (rule.kind === "boolean") {
    if (!["1", "0", "true", "false", "yes", "no", "on", "off"].includes(raw.toLowerCase())) {
      addIssue(rule.code, issuePath, rule.message)
    }
    return
  }

  if (rule.kind === "duration") {
    if (!/^(\d+(?:\.\d+)?)(ms|s)$/.test(raw)) {
      addIssue(rule.code, issuePath, rule.message)
    }
    return
  }

  if (rule.kind === "positive-integer") {
    if (!/^[1-9]\d*$/.test(raw)) {
      addIssue(rule.code, issuePath, rule.message)
    }
    return
  }

  if (rule.kind === "viewport") {
    if (!/^\d+x\d+$/i.test(raw)) {
      addIssue(rule.code, issuePath, rule.message)
    }
    return
  }

  if (rule.kind === "enum") {
    if (!(rule.values as readonly string[]).includes(raw) && !(rule.prefixes ?? []).some((prefix) => raw.startsWith(prefix))) {
      addIssue(rule.code, issuePath, descriptorValueMessage(rule, raw))
    }
    return
  }

  for (const value of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!(rule.values as readonly string[]).includes(value)) {
      addIssue(rule.code, issuePath, descriptorValueMessage(rule, value))
    }
  }
}

function descriptorValueMessage(rule: Extract<CommandArgValidationDescriptor, { kind: "enum" | "comma-list-enum" }>, value: string): string {
  if (rule.message.endsWith(".")) {
    return rule.message
  }
  return `${rule.message}: ${value}`
}

function validateInlineJsonArg(step: WorkspaceRecipe["workflow"]["steps"][number], name: string, shape: "array" | "object", path: string, addIssue: (code: string, path: string, message: string) => void): unknown {
  const raw = recipeStepArgValue(step.args ?? [], name)
  if (!raw || raw.startsWith("@")) {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    if (shape === "array" && !Array.isArray(parsed)) {
      addIssue(`invalid-${name}`, `${path}.args`, `wordpress.bench ${name} must be a JSON array.`)
      return undefined
    }
    if (shape === "object" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
      addIssue(`invalid-${name}`, `${path}.args`, `wordpress.bench ${name} must be a JSON object.`)
      return undefined
    }
    return parsed
  } catch (error) {
    addIssue(`invalid-${name}`, `${path}.args`, `wordpress.bench ${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

async function validateExistingDirectory(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  try {
    const result = await stat(path)
    if (!result.isDirectory()) {
      addIssue("not-directory", issuePath, `Expected directory: ${path}`)
    }
  } catch {
    addIssue("missing-path", issuePath, `Directory does not exist: ${path}`)
  }
}

async function validateExistingBackendPackageSource(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  try {
    const result = await stat(path)
    if (result.isDirectory() || result.isFile()) {
      return
    }
  } catch {
    // Report below.
  }

  addIssue("missing-backend-package-source", issuePath, `Runtime backend package source must be an existing file or directory: ${path}`)
}

async function validateExistingFile(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  try {
    const result = await stat(path)
    if (!result.isFile()) {
      addIssue("not-file", issuePath, `Expected file: ${path}`)
    }
  } catch {
    addIssue("missing-path", issuePath, `File does not exist: ${path}`)
  }
}

async function validateExistingFileOrDirectory(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  try {
    const result = await stat(path)
    if (!result.isFile() && !result.isDirectory()) {
      addIssue("unsupported-path", issuePath, `Expected file or directory: ${path}`)
    }
  } catch {
    addIssue("missing-path", issuePath, `File or directory does not exist: ${path}`)
  }
}

async function validateExistingMountSource(path: string, type: MountSpec["type"] | undefined, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (type === "directory") {
    await validateExistingDirectory(path, issuePath, addIssue)
    return
  }

  if (type === "file") {
    await validateExistingFile(path, issuePath, addIssue)
    return
  }

  await validateExistingFileOrDirectory(path, issuePath, addIssue)
}

function validateAbsoluteSandboxPath(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): void {
  try {
    normalizeRuntimeMountTarget(path, "Sandbox path")
  } catch (error) {
    addIssue("invalid-sandbox-path", issuePath, error instanceof Error ? error.message : String(error))
  }
}

function validateRecipeSource(source: ReturnType<typeof recipeSource>, issuePath: string, addIssue: (code: string, path: string, message: string) => void, expectedSha256?: string): void {
  for (const issue of evaluateRecipeSourcePolicy(source, expectedSha256)) {
    addIssue(issue.code, issuePath, issue.message)
  }
}

function pluginRuntimePluginActiveProbeCode(pluginFile: string): string {
  return `require_once ABSPATH . 'wp-admin/includes/plugin.php';
$plugin = ${JSON.stringify(pluginFile)};
if (!is_plugin_active($plugin)) {
    throw new RuntimeException(sprintf('Plugin runtime health probe failed: plugin is not active: %s', $plugin));
}
echo wp_json_encode(array('command' => 'plugin-runtime.health', 'type' => 'plugin-active', 'pluginFile' => $plugin, 'active' => true), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function recipeBenchStepUsesWpCli(step: WorkspaceRecipe["workflow"]["steps"][number]): boolean {
  const workloadsArg = recipeStepArgValue(step.args ?? [], "workloads-json")
  const lifecycleArg = recipeStepArgValue(step.args ?? [], "lifecycle-json")

  try {
    return Boolean(workloadsArg && recipeBenchWorkloadsUseWpCli(parseCommandJson(workloadsArg, "workloads-json")))
      || Boolean(lifecycleArg && recipeBenchWorkloadsUseWpCli(parseCommandJson(lifecycleArg, "lifecycle-json")))
  } catch {
    return false
  }
}

function recipeBenchWorkloadsUseWpCli(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(recipeBenchWorkloadsUseWpCli)
  }
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as { type?: unknown; run?: unknown }
  return record.type === "wp-cli" || recipeBenchWorkloadsUseWpCli(record.run)
}

function recipeStepUsesEvaluate(step: WorkspaceRecipe["workflow"]["steps"][number]): boolean {
  const scenarioRaw = recipeStepArgValue(step.args ?? [], "scenario-json")
  if (scenarioRaw && !scenarioRaw.startsWith("@")) {
    try {
      const parsed = parseCommandJson(scenarioRaw, "scenario-json") as { steps?: unknown; assertions?: unknown }
      const steps = normalizeBrowserScenarioStepsForValidation(parsed.steps)
      const assertions = normalizeBrowserScenarioAssertionsForValidation(parsed.assertions)
      return [...steps, ...assertions].some((entry) => entry && typeof entry === "object" && (entry as { kind?: unknown }).kind === "evaluate")
    } catch {
      return false
    }
  }

  const raw = recipeStepArgValue(step.args ?? [], "steps-json")
  if (!raw || raw.startsWith("@")) {
    return false
  }
  try {
    const parsed = parseCommandJson(raw, "steps-json")
    return Array.isArray(parsed) && parsed.some((entry) => entry && typeof entry === "object" && (entry as { kind?: unknown }).kind === "evaluate")
  } catch {
    return false
  }
}

function normalizeBrowserScenarioStepsForValidation(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry
    }
    const step = entry as Record<string, unknown>
    const type = typeof step.type === "string" ? step.type : undefined
    const kind = typeof step.kind === "string" ? step.kind : type
    if (kind === "wait" && typeof step.ms === "number") {
      return { kind: "waitFor", waitFor: "duration", duration: `${step.ms}ms` }
    }
    if (kind === "scrollTo" && typeof step.selector === "string") {
      return { kind: "evaluate", expression: `document.querySelector(${JSON.stringify(step.selector)})?.scrollIntoView({ block: "center", inline: "center" })` }
    }
    const { type: _type, ...rest } = step
    return { ...rest, kind: kind === "wait" ? "waitFor" : kind }
  })
}

function normalizeBrowserScenarioAssertionsForValidation(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry
    }
    const assertion = entry as Record<string, unknown>
    if (assertion.type === "selectorVisible" && typeof assertion.selector === "string") {
      return { kind: "expect", selector: assertion.selector, state: "visible", ...(typeof assertion.withinMs === "number" ? { timeout: `${assertion.withinMs}ms` } : {}) }
    }
    if (assertion.type === "noPageErrors") {
      return { kind: "evaluate", expression: "window.__wpCodeboxBrowserErrors?.length ?? 0", assert: 0 }
    }
    if (typeof assertion.type === "string") {
      const { type: _type, ...rest } = assertion
      return { ...rest, kind: assertion.type }
    }
    return assertion
  })
}
