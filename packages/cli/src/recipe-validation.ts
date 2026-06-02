import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { recipeCommandDefinitions, validateBrowserInteractionScript, type MountSpec, type RuntimePolicy, type WorkspaceRecipe, type WorkspaceRecipeMount, type WorkspaceRecipePluginRuntime, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeRuntimeOverlay, type WorkspaceRecipeSiteSeed } from "@automattic/wp-codebox-core"
import { ALLOW_NETWORK_DOWNLOADS_ENV, REQUIRE_SOURCE_SHA256_ENV, allowedDownloadHosts, isSha256, recipeExtraPluginSlug, recipeExtraPlugins, recipeSource, resolveRecipeExtraPluginFile, sourceSha256Required } from "./recipe-sources.js"

export interface RecipeValidationIssue {
  code: string
  path: string
  message: string
}

export type RecipeWorkflowPhase = "setup" | "before" | "steps" | "after"

export const defaultPolicy: RuntimePolicy = {
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["inspect-mounted-inputs", "wordpress.run-php"],
  secrets: "none",
  approvals: "never",
}

const supportedRecipeCommands = new Set(recipeCommandDefinitions().map((command) => command.id))

export function parseWorkspaceRecipe(raw: string, recipePath: string): WorkspaceRecipe {
  const recipe = JSON.parse(raw) as WorkspaceRecipe

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
  }

  validateRecipeMounts(recipe.runtime?.stack?.mounts, "runtime stack", recipePath)
  validateRecipeRuntimeOverlays(recipe.runtime?.overlays, recipePath)
  validateRecipeMounts(recipe.inputs?.mounts, "mounts", recipePath)

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

  const rawExtraPlugins = recipe.inputs?.extra_plugins ?? recipe.inputs?.extraPlugins
  if (rawExtraPlugins && !Array.isArray(rawExtraPlugins)) {
    throw new Error(`Recipe extra_plugins must be an array: ${recipePath}`)
  }

  for (const plugin of recipeExtraPlugins(recipe)) {
    if (!plugin.source) {
      throw new Error(`Recipe extra_plugins entries must include source: ${recipePath}`)
    }

    if (plugin.slug && !/^[a-z0-9][a-z0-9-_]*$/i.test(plugin.slug)) {
      throw new Error(`Recipe extra_plugins slug must be a plugin-directory slug: ${recipePath}`)
    }

    if (plugin.loadAs && plugin.loadAs !== "plugin" && plugin.loadAs !== "mu-plugin") {
      throw new Error(`Recipe extra_plugins loadAs must be plugin or mu-plugin: ${recipePath}`)
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

  return recipe
}

function validateRecipeMounts(mounts: WorkspaceRecipeMount[] | undefined, label: string, recipePath: string): void {
  if (mounts && !Array.isArray(mounts)) {
    throw new Error(`Recipe ${label} mounts must be an array: ${recipePath}`)
  }

  for (const mount of mounts ?? []) {
    if (!mount.source || !mount.target) {
      throw new Error(`Recipe ${label} mounts must include source and target: ${recipePath}`)
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

  for (const overlay of overlays ?? []) {
    if (overlay.kind !== "bundled-library") {
      throw new Error(`Recipe runtime overlay kind is unsupported: ${recipePath}`)
    }
    if (overlay.library !== "php-ai-client") {
      throw new Error(`Recipe runtime overlay library is unsupported: ${recipePath}`)
    }
    if (overlay.strategy !== "wordpress-scoped-bundle") {
      throw new Error(`Recipe runtime overlay strategy is unsupported: ${recipePath}`)
    }
    if (!overlay.source || typeof overlay.source !== "string") {
      throw new Error(`Recipe runtime overlays must include source: ${recipePath}`)
    }
    if (overlay.target !== undefined && typeof overlay.target !== "string") {
      throw new Error(`Recipe runtime overlay target must be a string when provided: ${recipePath}`)
    }
    if (overlay.metadata !== undefined && (!overlay.metadata || typeof overlay.metadata !== "object" || Array.isArray(overlay.metadata))) {
      throw new Error(`Recipe runtime overlay metadata must be an object when provided: ${recipePath}`)
    }
  }
}

export async function validateWorkspaceRecipe(recipe: WorkspaceRecipe, recipePath: string): Promise<RecipeValidationIssue[]> {
  const recipeDirectory = dirname(recipePath)
  const issues: RecipeValidationIssue[] = []
  const addIssue = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message })
  }

  if (recipe.runtime?.backend && recipe.runtime.backend !== "wordpress-playground") {
    addIssue("unsupported-backend", "$.runtime.backend", `Unsupported recipe backend: ${recipe.runtime.backend}`)
  }

  for (const { phase, index, step } of recipeWorkflowSteps(recipe)) {
    const path = `$.workflow.${phase}[${index}]`
    if (!supportedRecipeCommands.has(step.command)) {
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
    validateAbsoluteSandboxPath(overlay.target ?? "/wordpress/wp-includes/php-ai-client", `${path}.target`, addIssue)
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
    let source: ReturnType<typeof recipeSource>
    try {
      source = recipeSource(plugin.source, plugin.sha256)
    } catch (error) {
      addIssue("invalid-source", `${path}.source`, error instanceof Error ? error.message : String(error))
      continue
    }
    const pluginSource = source.type === "local" ? resolve(recipeDirectory, plugin.source) : undefined
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

    if (!pluginFile.startsWith(`${slug}/`)) {
      addIssue("invalid-plugin-file", `${path}.pluginFile`, `Plugin file must be relative to the mounted plugin slug (${slug}/...).`)
      continue
    }

    if (pluginSource) {
      await validateExistingFile(join(pluginSource, pluginFile.slice(slug.length + 1)), `${path}.pluginFile`, addIssue)
    }
  }

  await validateRecipePluginRuntime(recipe.inputs?.pluginRuntime, addIssue)

  for (const [index, name] of (recipe.inputs?.secretEnv ?? []).entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-secret-env", `$.inputs.secretEnv[${index}]`, `Secret environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
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

  return issues
}

export function recipeWorkflowSteps(recipe: WorkspaceRecipe): Array<{ phase: Exclude<RecipeWorkflowPhase, "setup">; index: number; step: WorkspaceRecipe["workflow"]["steps"][number] }> {
  return [
    ...(recipe.workflow.before ?? []).map((step, index) => ({ phase: "before" as const, index, step })),
    ...recipe.workflow.steps.map((step, index) => ({ phase: "steps" as const, index, step })),
    ...(recipe.workflow.after ?? []).map((step, index) => ({ phase: "after" as const, index, step })),
  ]
}

export function recipePolicy(recipe: WorkspaceRecipe): RuntimePolicy {
  const pluginRuntimeCommands = [
    ...(recipe.inputs?.pluginRuntime?.setup ?? []),
    ...(recipe.inputs?.pluginRuntime?.healthProbes ?? []).map(pluginRuntimeHealthProbeStep),
  ].map((step) => step.command)
  const commands = [
    ...recipeWorkflowSteps(recipe).map(({ step }) => step.command.startsWith("wp-codebox.agent-") ? "wordpress.run-php" : step.command),
    ...pluginRuntimeCommands,
  ]
  if (recipeWorkflowSteps(recipe).some(({ step }) => step.command === "wp-codebox.agent-sandbox-run")) {
    commands.unshift("wordpress.wp-cli")
  }
  if (recipeWorkflowSteps(recipe).some(({ step }) => step.command === "wordpress.bench" && recipeBenchStepUsesWpCli(step))) {
    commands.unshift("wordpress.wp-cli")
  }
  if (recipeExtraPlugins(recipe).some((plugin) => plugin.activate !== false)) {
    commands.unshift("wordpress.run-php")
  }
  if ((recipe.inputs?.siteSeeds ?? []).some((siteSeed) => siteSeed.type === "fixture")) {
    commands.unshift("wordpress.run-php")
  }
  // Auto-grant the evaluate capability when a browser-actions step opts into the
  // arbitrary-JS escape hatch by including an evaluate step. Recipe authors opt in
  // by writing the step; direct `run` invocations still control the gate via --policy.
  if (recipeWorkflowSteps(recipe).some(({ step }) => step.command === "wordpress.browser-actions" && recipeStepUsesEvaluate(step))) {
    commands.push("wordpress.browser-actions.evaluate")
  }

  return {
    ...defaultPolicy,
    commands: [...new Set(commands)],
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
  const prefix = `${key}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
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
  }

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

  if (step.command === "wordpress.browser-probe") {
    if (!recipeStepArgValue(step.args ?? [], "url")?.trim()) {
      addIssue("missing-url", `${path}.args`, "wordpress.browser-probe requires url=<path-or-url>.")
    }

    const waitFor = recipeStepArgValue(step.args ?? [], "wait-for")
    if (waitFor && !["domcontentloaded", "load", "networkidle", "duration"].includes(waitFor) && !waitFor.startsWith("selector:")) {
      addIssue("invalid-wait-for", `${path}.args`, "wordpress.browser-probe wait-for must be domcontentloaded, load, networkidle, selector:<selector>, or duration.")
    }

    const duration = recipeStepArgValue(step.args ?? [], "duration")
    if (duration && !/^(\d+(?:\.\d+)?)(ms|s)$/.test(duration)) {
      addIssue("invalid-duration", `${path}.args`, "wordpress.browser-probe duration must look like 500ms or 2s.")
    }

    const repeat = recipeStepArgValue(step.args ?? [], "repeat")
    if (repeat && !/^[1-9]\d*$/.test(repeat)) {
      addIssue("invalid-repeat", `${path}.args`, "wordpress.browser-probe repeat must be a positive integer.")
    }

    const resetBetween = recipeStepArgValue(step.args ?? [], "reset-between")
    if (resetBetween && !["none", "reload", "new-page"].includes(resetBetween)) {
      addIssue("invalid-reset-between", `${path}.args`, "wordpress.browser-probe reset-between must be none, reload, or new-page.")
    }

    const capture = recipeStepArgValue(step.args ?? [], "capture")
    if (capture) {
      for (const item of capture.split(",").map((value) => value.trim()).filter(Boolean)) {
        if (!["console", "errors", "html", "network", "performance", "memory", "screenshot"].includes(item)) {
          addIssue("invalid-capture", `${path}.args`, `wordpress.browser-probe capture does not support: ${item}`)
        }
      }
    }
    return
  }

  if (step.command === "wordpress.browser-actions") {
    const stepsJson = recipeStepArgValue(step.args ?? [], "steps-json")
    const actionsJson = recipeStepArgValue(step.args ?? [], "actions-json")
    const url = recipeStepArgValue(step.args ?? [], "url")?.trim()
    if (!stepsJson && !actionsJson && !url) {
      addIssue("missing-steps", `${path}.args`, "wordpress.browser-actions requires steps-json=<array> (or actions-json=<array>) or url=<path-or-url>.")
    }

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

    for (const name of ["step-timeout", "timeout"] as const) {
      const value = recipeStepArgValue(step.args ?? [], name)
      if (value && /^(\d+(?:\.\d+)?)(ms|s)$/.test(value) === false) {
        addIssue("invalid-duration", `${path}.args`, `wordpress.browser-actions ${name} must look like 500ms or 2s.`)
      }
    }

    const capture = recipeStepArgValue(step.args ?? [], "capture")
    if (capture) {
      for (const item of capture.split(",").map((value) => value.trim()).filter(Boolean)) {
        if (!["steps", "actions", "console", "errors", "html", "network", "screenshot"].includes(item)) {
          addIssue("invalid-capture", `${path}.args`, `wordpress.browser-actions capture does not support: ${item}`)
        }
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
  if (!path.startsWith("/")) {
    addIssue("invalid-sandbox-path", issuePath, `Sandbox paths must be absolute: ${path}`)
  }
}

function validateRecipeSource(source: ReturnType<typeof recipeSource>, issuePath: string, addIssue: (code: string, path: string, message: string) => void, expectedSha256?: string): void {
  if (source.type === "local") {
    return
  }

  if (process.env[ALLOW_NETWORK_DOWNLOADS_ENV] !== "1") {
    addIssue(
      "network-downloads-disabled",
      issuePath,
      `External recipe sources require ${ALLOW_NETWORK_DOWNLOADS_ENV}=1 before WP Codebox downloads anything.`,
    )
  }

  if (!allowedDownloadHosts().includes(source.host)) {
    addIssue("download-host-not-allowed", issuePath, `External recipe source host is not allowed: ${source.host}`)
  }

  if (expectedSha256 !== undefined && !isSha256(expectedSha256)) {
    addIssue("invalid-source-sha256", issuePath, "External recipe source sha256 must be a 64-character hex digest.")
  }

  if (sourceSha256Required() && !expectedSha256) {
    addIssue("missing-source-sha256", issuePath, `External recipe sources require sha256 when ${REQUIRE_SOURCE_SHA256_ENV}=1.`)
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
  const workloadsArg = (step.args ?? []).find((arg) => arg.startsWith("workloads-json="))
  if (!workloadsArg) {
    return false
  }

  try {
    return recipeBenchWorkloadsUseWpCli(JSON.parse(workloadsArg.slice("workloads-json=".length)))
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
  const raw = recipeStepArgValue(step.args ?? [], "steps-json")
  if (!raw || raw.startsWith("@")) {
    return false
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.some((entry) => entry && typeof entry === "object" && (entry as { kind?: unknown }).kind === "evaluate")
  } catch {
    return false
  }
}
