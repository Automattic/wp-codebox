import { readFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { SANDBOX_WORKSPACE_ROOT, stripUndefined, validateRuntimePolicy, type MountSpec, type RuntimePolicy, type SandboxWorkspaceMode, type WorkspaceRecipe, type WorkspaceRecipePluginRuntime, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeSiteSeed, type WorkspaceRecipeWorkspace } from "@automattic/wp-codebox-core"
import { serializeError } from "./output.js"
import { defaultWorkspaceTarget, installMuPluginsCode, pluginTarget, recipeBlueprintWithBootActivePlugins, recipeExtraPluginFile, recipeExtraPluginSlug, recipeExtraPlugins, recipeMountType, recipeSource, recipeSourceProvenance, resolveRecipeExtraPluginFile, stagedFileMountType, stagedFileProvenance, type RecipeSourceProvenance, type RecipeSourceType, type RecipeStagedFileProvenance } from "./recipe-sources.js"
import { hasExplicitSiteSeedSelectors, parseWorkspaceRecipe, pluginRuntimeHealthProbeStep, recipePolicy, recipeWorkflowSteps, validateWorkspaceRecipe, type RecipeValidationIssue, type RecipeWorkflowPhase } from "./recipe-validation.js"

export interface RecipeDryRunOptions {
  recipePath: string
  artifactsDirectory?: string
}

export interface RecipeDryRunContext {
  defaultWordPressVersion: string
  resolveExecutionSpec(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string): Promise<{ command: string; args: string[] }>
}

export interface RecipeDryRunOutput {
  success: boolean
  schema: "wp-codebox/recipe-run-dry-run/v1"
  recipePath?: string
  dryRun: true
  valid: boolean
  validation: {
    issues: RecipeValidationIssue[]
  }
  plan?: RecipeDryRunPlan
  error?: {
    name: string
    message: string
    code?: string
  }
}

export interface RecipeDryRunPlan {
  runtime: {
    backend: string
    name: string
    wp: string
    blueprint: unknown
  }
  artifacts: {
    directory?: string
  }
  mounts: RecipeDryRunMount[]
  workspaces: RecipeDryRunWorkspace[]
  extra_plugins: RecipeDryRunExtraPlugin[]
  pluginRuntime?: RecipeDryRunPluginRuntime
  siteSeeds: RecipeDryRunSiteSeed[]
  stagedFiles: RecipeDryRunStagedFile[]
  secretEnv: Array<{ name: string; available: boolean }>
  policy: RuntimePolicy & {
    valid: boolean
    issues: ReturnType<typeof validateRuntimePolicy>["issues"]
  }
  workflow: {
    before?: RecipeDryRunStep[]
    steps: RecipeDryRunStep[]
    after?: RecipeDryRunStep[]
  }
}

interface RecipeDryRunMount {
  type: MountSpec["type"]
  source?: string
  target: string
  mode: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
  planned?: "existing" | "generated"
}

interface RecipeDryRunWorkspace {
  index: number
  source?: string
  target: string
  mode: "readonly" | "readwrite"
  sourceMode: SandboxWorkspaceMode
  seed: WorkspaceRecipeWorkspace["seed"]
  generated: boolean
  metadata: Record<string, unknown>
}

interface RecipeDryRunExtraPlugin {
  source: string
  sourceRef: string
  sourceType: RecipeSourceType
  slug: string
  target: string
  pluginFile: string
  activate: boolean
  loadAs: "plugin" | "mu-plugin"
  provenance: RecipeSourceProvenance
}

interface RecipeDryRunPluginRuntime {
  label?: string
  php?: WorkspaceRecipePluginRuntime["php"]
  wpConfigDefines?: WorkspaceRecipePluginRuntime["wpConfigDefines"]
  setup: RecipeDryRunStep[]
  healthProbes: RecipeDryRunPluginRuntimeHealthProbe[]
}

interface RecipeDryRunPluginRuntimeHealthProbe {
  index: number
  name: string
  type: WorkspaceRecipePluginRuntimeHealthProbe["type"]
  command: string
  args: string[]
  resolvedCommand: string
  resolvedArgs: string[]
  policy: RecipeDryRunStep["policy"]
}

export interface RecipeDryRunSiteSeed {
  index: number
  type: WorkspaceRecipeSiteSeed["type"]
  name: string
  source?: string
  format?: WorkspaceRecipeSiteSeed["format"]
  importer?: string
  scopes: WorkspaceRecipeSiteSeed["scopes"]
  bounded: boolean
  dryRunOnly: boolean
  privacy: {
    exportsParentSiteData: boolean
    importsIntoSandbox: boolean
    includesRecordData: boolean
    secrets: "excluded-by-default"
  }
}

export interface RecipeDryRunStagedFile {
  index: number
  source: string
  sourceRef: string
  target: string
  type: MountSpec["type"]
  provenance: RecipeStagedFileProvenance
}

interface RecipeDryRunStep {
  phase: RecipeWorkflowPhase
  index: number
  command: string
  args: string[]
  parsedArgs: Record<string, string | true>
  resolvedCommand: string
  resolvedArgs: string[]
  resolvedParsedArgs: Record<string, string | true>
  policy: {
    status: "allowed" | "denied"
    command: string
    allowedCommands: string[]
    approvals: RuntimePolicy["approvals"]
    filesystem: RuntimePolicy["filesystem"]
    secrets: RuntimePolicy["secrets"]
  }
}

export async function dryRunRecipe(options: RecipeDryRunOptions, context: RecipeDryRunContext): Promise<RecipeDryRunOutput> {
  const recipePath = resolve(options.recipePath)
  try {
    const recipeDirectory = dirname(recipePath)
    const raw = await readFile(recipePath, "utf8")
    const recipe = parseWorkspaceRecipe(raw, recipePath)
    const issues = await validateWorkspaceRecipe(recipe, recipePath)

    if (issues.length > 0) {
      return {
        success: false,
        schema: "wp-codebox/recipe-run-dry-run/v1",
        recipePath,
        dryRun: true,
        valid: false,
        validation: { issues },
        error: {
          name: "RecipeValidationError",
          message: `Recipe validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
        },
      }
    }

    return {
      success: true,
      schema: "wp-codebox/recipe-run-dry-run/v1",
      recipePath,
      dryRun: true,
      valid: true,
      validation: { issues },
      plan: await recipeDryRunPlan(recipe, recipeDirectory, options, context),
    }
  } catch (error) {
    return {
      success: false,
      schema: "wp-codebox/recipe-run-dry-run/v1",
      recipePath,
      dryRun: true,
      valid: false,
      validation: {
        issues: [
          {
            code: "invalid-recipe",
            path: "$",
            message: error instanceof SyntaxError ? `Recipe JSON is invalid: ${error.message}` : error instanceof Error ? error.message : String(error),
          },
        ],
      },
      error: serializeError(error),
    }
  }
}

async function recipeDryRunPlan(recipe: WorkspaceRecipe, recipeDirectory: string, options: RecipeDryRunOptions, context: RecipeDryRunContext): Promise<RecipeDryRunPlan> {
  const policy = recipePolicy(recipe)
  const policyValidation = validateRuntimePolicy(policy)
  const workspaces = recipeDryRunWorkspaces(recipe, recipeDirectory)
  const extraPlugins = recipeDryRunExtraPlugins(recipe, recipeDirectory)
  const pluginRuntime = await recipeDryRunPluginRuntime(recipe, recipeDirectory, policy, context)
  const siteSeeds = recipeDryRunSiteSeeds(recipe, recipeDirectory)
  const stagedFiles = await recipeDryRunStagedFiles(recipe, recipeDirectory)
  const workflowSteps = await recipeDryRunSteps(recipe, recipeDirectory, policy, context)
  const recipeMounts = await Promise.all((recipe.inputs?.mounts ?? []).map(async (mount) => {
    const source = resolve(recipeDirectory, mount.source)
    return {
      type: await recipeMountType(source, mount.type),
      source,
      target: mount.target,
      mode: mount.mode ?? "readwrite" as const,
      ...(mount.metadata ? { metadata: mount.metadata } : {}),
      planned: "existing" as const,
    }
  }))
  const runtimeOverlays = (recipe.runtime?.overlays ?? []).map((overlay, index) => ({
    type: "directory" as const,
    target: overlay.target ?? "/wordpress/wp-includes/php-ai-client",
    mode: "readonly" as const,
    metadata: {
      kind: "runtime-overlay",
      index,
      overlayKind: overlay.kind,
      library: overlay.library,
      strategy: overlay.strategy,
      source: overlay.source,
      target: overlay.target ?? "/wordpress/wp-includes/php-ai-client",
      ...(overlay.metadata ? { userMetadata: overlay.metadata } : {}),
    },
    planned: "generated" as const,
  }))
  const mounts: RecipeDryRunMount[] = [
    ...runtimeOverlays,
    ...workspaces.map((workspace) => ({
      type: "directory" as const,
      ...(workspace.source ? { source: workspace.source } : {}),
      target: workspace.target,
      mode: workspace.mode,
      metadata: workspace.metadata,
      planned: workspace.generated ? "generated" as const : "existing" as const,
    })),
    ...extraPlugins.map((plugin) => ({
      type: "directory" as const,
      source: plugin.source,
      target: plugin.target,
      mode: "readonly" as const,
      metadata: {
        kind: "extra-plugin",
        slug: plugin.slug,
        source: plugin.provenance,
      },
      planned: "existing" as const,
    })),
    ...recipeMounts,
    ...stagedFiles.map((stagedFile) => ({
      type: stagedFile.type,
      source: stagedFile.source,
      target: stagedFile.target,
      mode: "readwrite" as const,
      metadata: {
        kind: "staged-file",
        index: stagedFile.index,
        source: stagedFile.provenance,
      },
      planned: "generated" as const,
    })),
  ]

  return {
    runtime: {
      backend: recipe.runtime?.backend ?? "wordpress-playground",
      name: recipe.runtime?.name ?? "wp-codebox-recipe",
      wp: recipe.runtime?.wp ?? context.defaultWordPressVersion,
      blueprint: recipeBlueprintWithBootActivePlugins(recipe.runtime?.blueprint, extraPlugins),
    },
    artifacts: stripUndefined({
      directory: options.artifactsDirectory ?? recipe.artifacts?.directory,
    }),
    mounts,
    workspaces,
    extra_plugins: extraPlugins,
    ...(pluginRuntime ? { pluginRuntime } : {}),
    siteSeeds,
    stagedFiles,
    secretEnv: (recipe.inputs?.secretEnv ?? []).map((name) => ({
      name,
      available: process.env[name] !== undefined,
    })),
    policy: {
      ...policy,
      valid: policyValidation.valid,
      issues: policyValidation.issues,
    },
    workflow: {
      ...(recipe.workflow.before ? { before: workflowSteps.filter((step) => step.phase === "before") } : {}),
      steps: workflowSteps,
      ...(recipe.workflow.after ? { after: workflowSteps.filter((step) => step.phase === "after") } : {}),
    },
  }
}

async function recipeDryRunSteps(recipe: WorkspaceRecipe, recipeDirectory: string, policy: RuntimePolicy, context: RecipeDryRunContext): Promise<RecipeDryRunStep[]> {
  const steps: Array<Promise<RecipeDryRunStep>> = []
  const dryRunExtraPlugins = await Promise.all(recipeExtraPlugins(recipe).map(async (plugin) => {
    const slug = recipeExtraPluginSlug(plugin)
    return {
      source: plugin.source,
      slug,
      target: pluginTarget(slug, plugin.loadAs ?? "plugin"),
      pluginFile: await resolveRecipeExtraPluginFile(plugin, recipeDirectory),
      activate: plugin.activate !== false,
      loadAs: plugin.loadAs ?? "plugin",
      cleanupPaths: [],
      provenance: recipeSourceProvenance(recipeSource(plugin.source, plugin.sha256), recipeDirectory),
    }
  }))
  const muPluginInstallCode = installMuPluginsCode(dryRunExtraPlugins)
  if (muPluginInstallCode) {
    steps.push(recipeDryRunStep({ command: "wordpress.run-php", args: [`code=${muPluginInstallCode}`] }, recipeDirectory, policy, "setup", -2, context, "install-mu-plugins"))
  }
  for (const workflowStep of recipeWorkflowSteps(recipe)) {
    steps.push(recipeDryRunStep(workflowStep.step, recipeDirectory, policy, workflowStep.phase, workflowStep.index, context))
  }

  return Promise.all(steps)
}

async function recipeDryRunStep(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, policy: RuntimePolicy, phase: RecipeWorkflowPhase, index: number, context: RecipeDryRunContext, label?: string): Promise<RecipeDryRunStep> {
  const resolved = await context.resolveExecutionSpec(step, recipeDirectory)
  const allowed = policy.commands.includes(resolved.command)
  return {
    phase,
    index,
    command: label ?? step.command,
    args: step.args ?? [],
    parsedArgs: parseRecipeArgs(step.args ?? []),
    resolvedCommand: resolved.command,
    resolvedArgs: resolved.args,
    resolvedParsedArgs: parseRecipeArgs(resolved.args),
    policy: {
      status: allowed ? "allowed" : "denied",
      command: resolved.command,
      allowedCommands: policy.commands,
      approvals: policy.approvals,
      filesystem: policy.filesystem,
      secrets: policy.secrets,
    },
  }
}

function parseRecipeArgs(args: string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {}
  for (const arg of args) {
    const separator = arg.indexOf("=")
    if (separator === -1) {
      parsed[arg] = true
      continue
    }

    parsed[arg.slice(0, separator)] = arg.slice(separator + 1)
  }

  return parsed
}

function recipeDryRunWorkspaces(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunWorkspace[] {
  return (recipe.inputs?.workspaces ?? []).map((workspace, index) => {
    const slug = workspace.seed.slug ?? basename(resolve(recipeDirectory, workspace.seed.source ?? `workspace-${index}`))
    const target = workspace.target ?? defaultWorkspaceTarget(workspace, slug)
    const generated = workspace.seed.type !== "directory"
    const sourceMode = workspace.sourceMode ?? "repo-backed"
    const metadata = {
      kind: "recipe-workspace",
      index,
      seed: workspace.seed,
      target,
      workspaceRoot: SANDBOX_WORKSPACE_ROOT,
      sourceMode,
      dryRun: true,
    }

    return {
      index,
      ...(generated ? {} : { source: resolve(recipeDirectory, workspace.seed.source ?? "") }),
      target,
      mode: workspace.mode ?? "readwrite",
      sourceMode,
      seed: workspace.seed,
      generated,
      metadata,
    }
  })
}

function recipeDryRunExtraPlugins(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunExtraPlugin[] {
  return recipeExtraPlugins(recipe).map((plugin) => {
    const slug = recipeExtraPluginSlug(plugin)
    const source = recipeSource(plugin.source, plugin.sha256)
    const provenance = recipeSourceProvenance(source, recipeDirectory)
    return {
      source: source.type === "local" ? resolve(recipeDirectory, plugin.source) : source.resolvedUrl,
      sourceRef: plugin.source,
      sourceType: source.type,
      slug,
      target: pluginTarget(slug, plugin.loadAs ?? "plugin"),
      pluginFile: recipeExtraPluginFile(plugin),
      activate: plugin.activate !== false,
      loadAs: plugin.loadAs ?? "plugin",
      provenance,
    }
  })
}

async function recipeDryRunPluginRuntime(recipe: WorkspaceRecipe, recipeDirectory: string, policy: RuntimePolicy, context: RecipeDryRunContext): Promise<RecipeDryRunPluginRuntime | undefined> {
  const pluginRuntime = recipe.inputs?.pluginRuntime
  if (!pluginRuntime) {
    return undefined
  }

  const setup = await Promise.all((pluginRuntime.setup ?? []).map((step, index) => recipeDryRunStep(step, recipeDirectory, policy, "setup", pluginRuntimeSetupStepIndex(index), context, `plugin-runtime.setup:${index}`)))
  const healthProbes = await Promise.all((pluginRuntime.healthProbes ?? []).map(async (probe, index) => {
    const step = pluginRuntimeHealthProbeStep(probe)
    const dryRunStep = await recipeDryRunStep(step, recipeDirectory, policy, "setup", pluginRuntimeHealthProbeStepIndex(index), context, `plugin-runtime.health:${probe.name}`)
    return {
      index,
      name: probe.name,
      type: probe.type,
      command: dryRunStep.command,
      args: dryRunStep.args,
      resolvedCommand: dryRunStep.resolvedCommand,
      resolvedArgs: dryRunStep.resolvedArgs,
      policy: dryRunStep.policy,
    }
  }))

  return stripUndefined({
    label: pluginRuntime.label,
    php: pluginRuntime.php,
    wpConfigDefines: pluginRuntime.wpConfigDefines,
    setup,
    healthProbes,
  })
}

export function recipeDryRunSiteSeeds(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunSiteSeed[] {
  return (recipe.inputs?.siteSeeds ?? []).map((siteSeed, index) => ({
    index,
    type: siteSeed.type,
    name: siteSeed.name,
    ...(siteSeed.source ? { source: resolve(recipeDirectory, siteSeed.source) } : {}),
    ...(siteSeed.format ? { format: siteSeed.format } : {}),
    ...(siteSeed.type === "fixture" ? { importer: siteSeed.format ?? "json" } : {}),
    scopes: siteSeed.scopes,
    bounded: siteSeedScopesAreBounded(siteSeed),
    dryRunOnly: siteSeed.type !== "fixture",
    privacy: {
      exportsParentSiteData: false,
      importsIntoSandbox: siteSeed.type === "fixture",
      includesRecordData: siteSeed.type === "fixture",
      secrets: "excluded-by-default",
    },
  }))
}

async function recipeDryRunStagedFiles(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<RecipeDryRunStagedFile[]> {
  return Promise.all((recipe.inputs?.stagedFiles ?? []).map(async (stagedFile, index) => {
    const source = resolve(recipeDirectory, stagedFile.source)
    return {
      index,
      source,
      sourceRef: stagedFile.source,
      target: stagedFile.target,
      type: await stagedFileMountType(source),
      provenance: stagedFileProvenance(stagedFile, recipeDirectory),
    }
  }))
}

export function pluginRuntimeSetupStepIndex(index: number): number {
  return -1000 - index
}

export function pluginRuntimeHealthProbeStepIndex(index: number): number {
  return -2000 - index
}

export function siteSeedScopesAreBounded(siteSeed: WorkspaceRecipeSiteSeed): boolean {
  for (const [scopeName, scope] of Object.entries(siteSeed.scopes)) {
    if (!scope || scope === true) {
      continue
    }

    if (scopeName === "options" && (!scope.names || scope.names.length === 0)) {
      return false
    }

    if (siteSeed.type === "parent_site" && scope.maxRecords === undefined && !hasExplicitSiteSeedSelectors(scope)) {
      return false
    }

    if (scopeName === "users" && scope.anonymize === false) {
      return false
    }

    if (scopeName === "media" && scope.includeFiles === true && siteSeed.type === "parent_site") {
      return false
    }
  }

  return Object.values(siteSeed.scopes).some((scope) => scope !== undefined && scope !== false)
}
