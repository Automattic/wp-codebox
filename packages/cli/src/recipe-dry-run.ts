import { basename, dirname, resolve } from "node:path"
import { fixtureImportDeterministicIdPlan, normalizeRuntimeBackendKind, validateRuntimePolicy, type FixtureImportDeterministicIdPlan, type MountSpec, type RuntimePolicy, type RuntimeWordPressInstallMode, type SandboxWorkspaceMode, type WorkspaceRecipe, type WorkspaceRecipeDeclaredArtifact, type WorkspaceRecipeDistribution, type WorkspaceRecipeDistributionStartupProbe, type WorkspaceRecipeFixtureDatabase, type WorkspaceRecipePluginRuntime, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeSiteSeed, type WorkspaceRecipeSiteSeedBootstrap, type WorkspaceRecipeWorkspace } from "@automattic/wp-codebox-core"
import { SANDBOX_WORKSPACE_ROOT, stripUndefined } from "@automattic/wp-codebox-core/internals"
import { serializeError } from "./output.js"
import { RecipeArtifactsMountConflictError, recipeArtifactsMountConflict } from "./commands/recipe-run-artifacts-mount-guard.js"
import { resolveRecipeSecretEnv, type RecipeSecretEnvSummaryEntry } from "./recipe-secret-env.js"
import { recipeExternalServiceBoundarySummaries, type RecipeExternalServiceBoundarySummary } from "./recipe-external-services.js"
import { composerPackageVendorPath, defaultWorkspaceTarget, installMuPluginsCode, pluginTarget, recipeBlueprintWithBootActivePlugins, recipeExtraPluginFile, recipeExtraPluginSlug, recipeExtraPluginSource, recipeExtraPluginSourceRoot, recipeExtraPluginSourceSubpath, recipeExtraPlugins, recipeMountType, recipeSource, recipeSourceProvenance, resolveRecipeExtraPluginFile, stagedFileMountType, stagedFileProvenance, type RecipeSourceProvenance, type RecipeSourceType, type RecipeStagedFileProvenance } from "./recipe-sources.js"
import { hasExplicitSiteSeedSelectors, loadWorkspaceRecipe, pluginRuntimeHealthProbeStep, recipePolicy, recipeWorkflowSteps, validateWorkspaceRecipe, type RecipeValidationIssue, type RecipeWorkflowPhase } from "./recipe-validation.js"
import { runtimeOverlayTarget } from "./runtime-overlay-registry.js"

export interface RecipeDryRunOptions {
  recipePath: string
  artifactsDirectory?: string
}

export interface RecipeDryRunContext {
  defaultWordPressVersion: string
  resolveExecutionSpec(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string): Promise<{ command: string; args: string[] }>
}

export type RecipePlanOptions = RecipeDryRunOptions
export type RecipePlanContext = RecipeDryRunContext

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

export interface RecipePlan {
  runtime: {
    backend: string
    backendPackage?: {
      kind: string
      source: string
      package?: string
      entrypoint?: string
      metadata?: Record<string, unknown>
    }
    name: string
    wp: string
    phpVersion?: string
    wordpressInstallMode?: RuntimeWordPressInstallMode
    blueprint: unknown
  }
  distribution?: RecipeDryRunDistribution
  artifacts: {
    directory?: string
    paths?: RecipeDryRunDeclaredArtifact[]
  }
  mounts: RecipeDryRunMount[]
  workspaces: RecipeDryRunWorkspace[]
  extra_plugins: RecipeDryRunExtraPlugin[]
  pluginRuntime?: RecipeDryRunPluginRuntime
  fixtureDatabases: RecipeDryRunFixtureDatabase[]
  siteSeeds: RecipeDryRunSiteSeed[]
  stagedFiles: RecipeDryRunStagedFile[]
  externalServices: RecipeExternalServiceBoundarySummary[]
  probes: RecipeDryRunProbe[]
  secretEnv: Array<{ name: string; available: boolean; status: RecipeSecretEnvSummaryEntry["status"]; source?: string }>
  policy: RuntimePolicy & {
    valid: boolean
    issues: ReturnType<typeof validateRuntimePolicy>["issues"]
  }
  workflow: {
    before?: RecipeDryRunStep[]
    steps: RecipeDryRunStep[]
    after?: RecipeDryRunStep[]
  }
  metadata?: Record<string, unknown>
}

export type RecipeDryRunPlan = RecipePlan

interface RecipeDryRunDistribution {
  name: string
  wordpress: WorkspaceRecipeDistribution["wordpress"]
  sourceMounts: RecipeDryRunDistributionSourceMount[]
  env: Record<string, string | number | boolean | null>
  constants: Record<string, string | number | boolean | null>
  serviceFakes: RecipeDryRunDistributionServiceFake[]
  routeAliases: NonNullable<WorkspaceRecipeDistribution["routeAliases"]>
  setupArtifacts: Array<NonNullable<WorkspaceRecipeDistribution["setupArtifacts"]>[number] & { source: string; planned: "local-artifact" }>
  startupProbes: RecipeDryRunDistributionStartupProbe[]
  artifacts: NonNullable<WorkspaceRecipeDistribution["artifacts"]>
  safety: {
    network: "deny" | "declared"
    allowedHosts: string[]
    secretEnv: Array<{ name: string; available: boolean; status: RecipeSecretEnvSummaryEntry["status"]; source?: string }>
    ambientSecrets: false
  }
}

interface RecipeDryRunDistributionSourceMount extends RecipeDryRunMount {
  role?: string
  ref?: string
}

interface RecipeDryRunDistributionServiceFake {
  name: string
  source: string
  load: "pre-bootstrap" | "mu-plugin" | "manual"
  sideEffectsArtifact?: string
  metadata?: Record<string, unknown>
}

interface RecipeDryRunDistributionStartupProbe extends WorkspaceRecipeDistributionStartupProbe {
  command?: string
  args?: string[]
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

interface RecipeDryRunFixtureDatabase {
  index: number
  name: string
  version: string
  source: string
  format: "sql"
  reset: {
    strategy: "none" | "truncate-tables"
    tables: string[]
  }
  metadata?: Record<string, unknown>
}

interface RecipeDryRunProbe extends RecipeDryRunStep {
  name: string
  expectJson: boolean
  allowFailure: boolean
  metadata?: Record<string, unknown>
}

interface RecipeDryRunDeclaredArtifact {
  index: number
  name: string
  path: string
  required: boolean
  parseJson: boolean
  metadata?: Record<string, unknown>
}

export interface RecipeDryRunSiteSeed {
  index: number
  type: WorkspaceRecipeSiteSeed["type"]
  name: string
  source?: string
  format?: WorkspaceRecipeSiteSeed["format"]
  importer?: string
  deterministicIds?: FixtureImportDeterministicIdPlan
  bootstrap?: WorkspaceRecipeSiteSeedBootstrap
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
    const recipe = await loadWorkspaceRecipe(recipePath)
    const artifactMountConflict = recipeArtifactsMountConflict(recipe, recipeDirectory, options.artifactsDirectory ?? recipe.artifacts?.directory)
    if (artifactMountConflict) {
      return {
        success: false,
        schema: "wp-codebox/recipe-run-dry-run/v1",
        recipePath,
        dryRun: true,
        valid: false,
        validation: { issues: [] },
        error: serializeError(new RecipeArtifactsMountConflictError(artifactMountConflict)),
      }
    }

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
      plan: await planWorkspaceRecipe(recipe, recipeDirectory, options, context),
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

export async function planWorkspaceRecipe(recipe: WorkspaceRecipe, recipeDirectory: string, options: RecipePlanOptions, context: RecipePlanContext): Promise<RecipePlan> {
  const policy = recipePolicy(recipe)
  const policyValidation = validateRuntimePolicy(policy)
  const workspaces = recipeDryRunWorkspaces(recipe, recipeDirectory)
  const extraPlugins = recipeDryRunExtraPlugins(recipe, recipeDirectory)
  const pluginRuntime = await recipeDryRunPluginRuntime(recipe, recipeDirectory, policy, context)
  const fixtureDatabases = recipeDryRunFixtureDatabases(recipe, recipeDirectory)
  const distribution = await recipeDryRunDistribution(recipe.distribution, recipeDirectory)
  const siteSeeds = recipeDryRunSiteSeeds(recipe, recipeDirectory)
  const stagedFiles = await recipeDryRunStagedFiles(recipe, recipeDirectory)
  const workflowSteps = await recipeDryRunSteps(recipe, recipeDirectory, policy, context)
  const secretEnvSummary = resolveRecipeSecretEnv(recipe.inputs?.secretEnv ?? []).summary
  const probes = await recipeDryRunProbes(recipe, recipeDirectory, policy, context)
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
    target: runtimeOverlayTarget(overlay),
    mode: "readonly" as const,
    metadata: {
      kind: "runtime-overlay",
      index,
      overlayKind: overlay.kind,
      library: overlay.library,
      strategy: overlay.strategy,
      source: overlay.source,
      target: runtimeOverlayTarget(overlay),
      ...(overlay.metadata ? { userMetadata: overlay.metadata } : {}),
    },
    planned: "generated" as const,
  }))
  const dependencyOverlays = (recipe.inputs?.dependency_overlays ?? []).map((overlay, index) => {
    const consumer = extraPlugins.find((plugin) => plugin.slug === overlay.consumer)
    const target = `${consumer?.target ?? pluginTarget(overlay.consumer, "plugin")}/vendor/${composerPackageVendorPath(overlay.package)}`
    return {
      type: "directory" as const,
      source: resolve(recipeDirectory, overlay.source),
      target,
      mode: "readonly" as const,
      metadata: {
        kind: "dependency-overlay",
        index,
        overlayKind: overlay.kind,
        package: overlay.package,
        source: overlay.source,
        consumer: overlay.consumer,
        target,
        ...(overlay.metadata ? { userMetadata: overlay.metadata } : {}),
      },
      planned: "existing" as const,
    }
  })
  const mounts: RecipeDryRunMount[] = [
    ...runtimeOverlays,
    ...(distribution?.sourceMounts ?? []).map((mount) => ({
      type: mount.type,
      source: mount.source,
      target: mount.target,
      mode: mount.mode,
      metadata: {
        ...(mount.metadata ?? {}),
        kind: "distribution-source-mount",
        ...(mount.role ? { role: mount.role } : {}),
        ...(mount.ref ? { ref: mount.ref } : {}),
      },
      planned: mount.planned,
    })),
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
    ...dependencyOverlays,
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
      backend: normalizeRuntimeBackendKind(recipe.runtime?.backend),
      ...(recipe.runtime?.backendPackage ? { backendPackage: recipe.runtime.backendPackage } : {}),
      name: recipe.runtime?.name ?? "wp-codebox-recipe",
      wp: recipe.runtime?.wp ?? context.defaultWordPressVersion,
      ...(recipe.runtime?.phpVersion ? { phpVersion: recipe.runtime.phpVersion } : {}),
      ...(recipe.runtime?.wordpressInstallMode ? { wordpressInstallMode: recipe.runtime.wordpressInstallMode } : {}),
      blueprint: recipeBlueprintWithBootActivePlugins(recipe.runtime?.blueprint, extraPlugins),
    },
    ...(distribution ? { distribution } : {}),
    artifacts: stripUndefined({
      directory: options.artifactsDirectory ?? recipe.artifacts?.directory,
      paths: recipeDryRunDeclaredArtifacts(recipe),
    }),
    mounts,
    workspaces,
    extra_plugins: extraPlugins,
    ...(pluginRuntime ? { pluginRuntime } : {}),
    fixtureDatabases,
    siteSeeds,
    stagedFiles,
    externalServices: recipeExternalServiceBoundarySummaries(recipe),
    probes,
    secretEnv: secretEnvSummary.map(recipeDryRunSecretEnvEntry),
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
    ...(recipe.metadata ? { metadata: recipe.metadata } : {}),
  }
}

function recipeDryRunFixtureDatabases(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunFixtureDatabase[] {
  return (recipe.inputs?.fixtureDatabases ?? []).map((fixture: WorkspaceRecipeFixtureDatabase, index) => ({
    index,
    name: fixture.name,
    version: fixture.version,
    source: resolve(recipeDirectory, fixture.source),
    format: fixture.format ?? "sql",
    reset: {
      strategy: fixture.reset?.strategy ?? "truncate-tables",
      tables: fixture.reset?.tables ?? [],
    },
    ...(fixture.metadata ? { metadata: fixture.metadata } : {}),
  }))
}

async function recipeDryRunProbes(recipe: WorkspaceRecipe, recipeDirectory: string, policy: RuntimePolicy, context: RecipeDryRunContext): Promise<RecipeDryRunProbe[]> {
  return Promise.all((recipe.probes ?? []).map(async (probe, index) => ({
    ...await recipeDryRunStep(probe.step, recipeDirectory, policy, "setup", index, context, `probe:${probe.name}`),
    name: probe.name,
    expectJson: probe.expectJson === true,
    allowFailure: probe.allowFailure === true,
    ...(probe.metadata ? { metadata: probe.metadata } : {}),
  })))
}

function recipeDryRunDeclaredArtifacts(recipe: WorkspaceRecipe): RecipeDryRunDeclaredArtifact[] {
  return (recipe.artifacts?.paths ?? []).map((artifact: WorkspaceRecipeDeclaredArtifact, index) => ({
    index,
    name: artifact.name,
    path: artifact.path,
    required: artifact.required !== false,
    parseJson: artifact.parseJson === true,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  }))
}

async function recipeDryRunDistribution(distribution: WorkspaceRecipeDistribution | undefined, recipeDirectory: string): Promise<RecipeDryRunDistribution | undefined> {
  if (!distribution) {
    return undefined
  }

  const sourceMounts = await Promise.all((distribution.sourceMounts ?? []).map(async (mount): Promise<RecipeDryRunDistributionSourceMount> => {
    const source = resolve(recipeDirectory, mount.source)
    return {
      type: await recipeMountType(source, mount.type),
      source,
      target: mount.target,
      mode: mount.mode ?? "readonly",
      ...(mount.metadata ? { metadata: mount.metadata } : {}),
      ...(mount.role ? { role: mount.role } : {}),
      ...(mount.ref ? { ref: mount.ref } : {}),
      planned: "existing",
    }
  }))

  return {
    name: distribution.name,
    wordpress: distribution.wordpress,
    sourceMounts,
    env: distribution.env ?? {},
    constants: distribution.constants ?? {},
    serviceFakes: (distribution.serviceFakes ?? []).map((fake) => ({
      name: fake.name,
      source: resolve(recipeDirectory, fake.source),
      load: fake.load ?? "pre-bootstrap",
      ...(fake.sideEffectsArtifact ? { sideEffectsArtifact: fake.sideEffectsArtifact } : {}),
      ...(fake.metadata ? { metadata: fake.metadata } : {}),
    })),
    routeAliases: distribution.routeAliases ?? [],
    setupArtifacts: (distribution.setupArtifacts ?? []).map((artifact) => ({
      ...artifact,
      source: resolve(recipeDirectory, artifact.source),
      planned: "local-artifact" as const,
    })),
    startupProbes: (distribution.startupProbes ?? []).map(distributionStartupProbePlan),
    artifacts: distribution.artifacts ?? [],
    safety: {
      network: distribution.safety?.network ?? "deny",
      allowedHosts: distribution.safety?.allowedHosts ?? [],
      secretEnv: resolveRecipeSecretEnv(distribution.safety?.secretEnv ?? []).summary.map(recipeDryRunSecretEnvEntry),
      ambientSecrets: false,
    },
  }
}

function recipeDryRunSecretEnvEntry(entry: RecipeSecretEnvSummaryEntry): { name: string; available: boolean; status: RecipeSecretEnvSummaryEntry["status"]; source?: string } {
  return {
    name: entry.name,
    available: entry.status === "available",
    status: entry.status,
    ...(entry.source ? { source: entry.source } : {}),
  }
}

function distributionStartupProbePlan(probe: WorkspaceRecipeDistributionStartupProbe): RecipeDryRunDistributionStartupProbe {
  if (probe.type === "http" || probe.type === "browser") {
    return probe
  }

  if (probe.type === "wp-cli") {
    return {
      ...probe,
      command: "wordpress.wp-cli",
      args: [`command=${probe.command ?? ""}`],
    }
  }

  return {
    ...probe,
    command: "wordpress.run-php",
    args: [`code=${probe.code ?? ""}`],
  }
}

async function recipeDryRunSteps(recipe: WorkspaceRecipe, recipeDirectory: string, policy: RuntimePolicy, context: RecipeDryRunContext): Promise<RecipeDryRunStep[]> {
  const steps: Array<Promise<RecipeDryRunStep>> = []
  const dryRunExtraPlugins = await Promise.all(recipeExtraPlugins(recipe).map(async (plugin) => {
    const slug = recipeExtraPluginSlug(plugin)
    const sourceRef = recipeExtraPluginSource(plugin)
    const sourceRoot = recipeExtraPluginSourceRoot(plugin, recipeDirectory)
    return {
      source: sourceRef,
      slug,
      target: pluginTarget(slug, plugin.loadAs ?? "plugin"),
      pluginFile: await resolveRecipeExtraPluginFile(plugin, recipeDirectory),
      activate: plugin.activate !== false,
      loadAs: plugin.loadAs ?? "plugin",
      cleanupPaths: [],
      provenance: recipeSourceProvenance(recipeSource(sourceRoot, plugin.sha256), recipeDirectory),
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
    const sourceRef = recipeExtraPluginSource(plugin)
    const sourceRoot = recipeExtraPluginSourceRoot(plugin, recipeDirectory)
    const sourceSubpath = recipeExtraPluginSourceSubpath(plugin, recipeDirectory)
    const source = recipeSource(sourceRoot, plugin.sha256)
    const provenance = recipeSourceProvenance(source, recipeDirectory)
    return {
      source: source.type === "local" ? resolve(recipeDirectory, sourceRoot, sourceSubpath) : source.resolvedUrl,
      sourceRef,
      sourceRoot,
      sourceSubpath,
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
    ...(siteSeed.deterministicIds ? { deterministicIds: fixtureImportDeterministicIdPlan(siteSeed) } : {}),
    ...(siteSeed.bootstrap ? { bootstrap: siteSeed.bootstrap } : {}),
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
