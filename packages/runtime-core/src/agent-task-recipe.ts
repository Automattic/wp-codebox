import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { SandboxToolPolicySnapshot } from "./sandbox-tool-policy.js"
import type { StructuredArtifactPayload } from "./structured-artifacts.js"
import type { TaskInput } from "./task-input.js"
import { isPlainObject, stringList, stripUndefined } from "./object-utils.js"
import type { WorkspaceRecipe, WorkspaceRecipeMount, WorkspaceRecipeStagedFile } from "./runtime-contracts.js"

/**
 * Consumer-facing agent-task request fields accepted by the reusable recipe builder.
 *
 * Runtime-internal metadata such as `session_id`, `sandbox_session_id`, `artifacts_path`,
 * `parent_request`, and `orchestrator` is passed through only where recipe execution needs
 * it. CLI parsing, command execution, and result presentation remain outside this contract.
 */
export interface AgentTaskRunInput {
  goal?: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  provider_plugin_paths?: string[]
  runtime_overlay_profiles?: string[]
  runtime_env?: Record<string, unknown>
  runtimeEnv?: Record<string, unknown>
  runtime_state_mounts?: WorkspaceRecipeMount[]
  runtimeStateMounts?: WorkspaceRecipeMount[]
  runtime_config_mounts?: WorkspaceRecipeMount[]
  runtimeConfigMounts?: WorkspaceRecipeMount[]
  secret_env?: string[]
  mounts?: NonNullable<WorkspaceRecipe["inputs"]>["mounts"]
  workspaces?: NonNullable<WorkspaceRecipe["inputs"]>["workspaces"]
  dependency_overlays?: NonNullable<WorkspaceRecipe["inputs"]>["dependency_overlays"]
  runtime_stack_mounts?: WorkspaceRecipeMount[]
  runtime_overlays?: Array<Record<string, unknown>>
  agent_bundles?: Array<Record<string, unknown>>
  stagedFiles?: WorkspaceRecipeStagedFile[]
  runtime_task?: Record<string, unknown>
  agent_bundle?: Record<string, unknown>
  sandbox_tool_policy?: SandboxToolPolicySnapshot
  structured_artifacts?: StructuredArtifactPayload[]
  max_turns?: number | string
  task_timeout_seconds?: number | string
  session_id?: string
  sandbox_session_id?: string
  artifacts_path?: string
  wp?: string
  component_contracts?: Array<Record<string, unknown>>
  verify_steps?: WorkspaceRecipe["workflow"]["after"]
  parent_request?: Record<string, unknown>
  orchestrator?: Record<string, unknown>
}

interface RuntimeOverlayProfileDefaults {
  runtimeOverlays: Array<Record<string, unknown>>
}

export function buildAgentTaskRecipe(input: AgentTaskRunInput, taskInput: TaskInput, wpVersion: string): WorkspaceRecipe {
  const artifacts = stringValue(input.artifacts_path)
  const profile = runtimeOverlayProfileDefaults(input)
  const runtimeMounts = runtimeStateMounts(input)
  const agentBundleStagedFiles = stagedAgentBundleSources(input.agent_bundles)
  const stagedFiles = [...(Array.isArray(input.stagedFiles) ? input.stagedFiles : []), ...agentBundleStagedFiles]
  const providerPlugins = stringList(input.provider_plugin_paths)
    .map((plugin) => {
      const slug = slugFromComposerPackage(plugin) || slugFromPath(plugin)
      return { source: prepareComposerPluginSource(plugin, slug, artifacts), slug, activate: true }
    })
  const providerSlugs = providerPlugins.map((plugin) => plugin.slug).join(",")
  const workflowArgs = [
    `task=${taskInput.goal}`,
    `agent=${stringValue(input.agent) || "wp-codebox-sandbox"}`,
    `mode=${stringValue(input.mode) || "sandbox"}`,
    `provider=${stringValue(input.provider)}`,
    `model=${stringValue(input.model)}`,
    `provider-plugin-slugs=${providerSlugs}`,
    `sandbox-tool-policy-json=${JSON.stringify(sandboxToolPolicy(input, taskInput))}`,
  ]
  if (stringValue(input.session_id)) {
    workflowArgs.push(`session-id=${stringValue(input.session_id)}`)
  }
  if (stringValue(input.max_turns)) {
    workflowArgs.push(`max-turns=${stringValue(input.max_turns)}`)
  }
  if (stringValue(input.task_timeout_seconds)) {
    workflowArgs.push(`timeout-seconds=${stringValue(input.task_timeout_seconds)}`)
  }
  if (Array.isArray(input.agent_bundles) && input.agent_bundles.length > 0) {
    workflowArgs.push(`agent-bundles-json=${JSON.stringify(input.agent_bundles)}`)
  }
  if (input.runtime_task && typeof input.runtime_task === "object" && !Array.isArray(input.runtime_task)) {
    workflowArgs.push(`runtime-task-json=${JSON.stringify(input.runtime_task)}`)
  }
  if (taskInput.structured_artifacts.length > 0) {
    workflowArgs.push(`structured-artifacts-json=${JSON.stringify(taskInput.structured_artifacts)}`)
  }

  return stripUndefined({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: stripUndefined({
      backend: "wordpress-playground",
      wp: wpVersion,
      blueprint: { steps: [] },
      stack: runtimeMounts.length > 0 ? { mounts: runtimeMounts } : undefined,
      overlays: runtimeOverlays(input, profile),
    }),
    inputs: stripUndefined({
      mounts: Array.isArray(input.mounts) ? input.mounts : [],
      workspaces: Array.isArray(input.workspaces) ? input.workspaces : [],
      dependency_overlays: Array.isArray(input.dependency_overlays) ? input.dependency_overlays : undefined,
      extra_plugins: [
        ...componentPlugins(input.component_contracts, artifacts),
        ...providerPlugins,
      ].filter(Boolean),
      runtimeEnv: runtimeEnv(input),
      secretEnv: stringList(input.secret_env),
      stagedFiles: stagedFiles.length > 0 ? stagedFiles : undefined,
      agent_bundles: Array.isArray(input.agent_bundles) && input.agent_bundles.length > 0 ? input.agent_bundles : undefined,
    }),
    workflow: stripUndefined({
      steps: [{ command: "wp-codebox.agent-sandbox-run", args: workflowArgs }],
      after: Array.isArray(input.verify_steps) && input.verify_steps.length > 0 ? input.verify_steps : undefined,
    }),
  }) as WorkspaceRecipe
}

function stagedAgentBundleSources(agentBundles: AgentTaskRunInput["agent_bundles"]): WorkspaceRecipeStagedFile[] {
  if (!Array.isArray(agentBundles)) return []

  const stagedFiles: WorkspaceRecipeStagedFile[] = []
  const seenTargets = new Set<string>()
  for (const bundle of agentBundles) {
    const source = stringValue(bundle.source)
    if (!source || bundle.bundle || seenTargets.has(source)) continue
    const localSource = localAgentBundleSource(source)
    if (!localSource) continue
    stagedFiles.push({
      source: localSource,
      target: source,
    })
    seenTargets.add(source)
  }
  return stagedFiles
}

function localAgentBundleSource(source: string): string {
  const direct = resolve(source)
  if (existsSync(direct)) return direct

  const workspacePrefix = "/workspace/"
  if (!source.startsWith(workspacePrefix)) return ""

  const relativeToWorkspace = source.slice(workspacePrefix.length).split("/").filter(Boolean).slice(1).join("/")
  if (!relativeToWorkspace) return ""

  const fromCwd = resolve(process.cwd(), relativeToWorkspace)
  return existsSync(fromCwd) ? fromCwd : ""
}

function runtimeOverlayProfileDefaults(input: AgentTaskRunInput): RuntimeOverlayProfileDefaults {
  const profiles = stringList(input.runtime_overlay_profiles)
  if (profiles.length === 0) return { runtimeOverlays: [] }

  for (const profile of profiles) {
    throw new Error(`Unknown runtime overlay profile: ${profile}`)
  }
  return { runtimeOverlays: [] }
}

function runtimeOverlays(input: AgentTaskRunInput, profile: RuntimeOverlayProfileDefaults): Array<Record<string, unknown>> | undefined {
  const overlays = [...profile.runtimeOverlays, ...(Array.isArray(input.runtime_overlays) ? input.runtime_overlays : [])]
  return overlays.length > 0 ? overlays : undefined
}

function runtimeEnv(input: AgentTaskRunInput): Record<string, string> | undefined {
  const raw = objectValue(input.runtime_env) || objectValue(input.runtimeEnv)
  if (!raw) return undefined
  const entries = Object.entries(raw)
    .map(([name, value]) => [name.trim(), stringValue(value)] as const)
    .filter(([name]) => /^[A-Z_][A-Z0-9_]*$/.test(name))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function runtimeStateMounts(input: AgentTaskRunInput): WorkspaceRecipeMount[] {
  return [
    ...(Array.isArray(input.runtime_stack_mounts) ? input.runtime_stack_mounts : []),
    ...runtimeMountList(input.runtime_config_mounts),
    ...runtimeMountList(input.runtimeConfigMounts),
    ...runtimeMountList(input.runtime_state_mounts),
    ...runtimeMountList(input.runtimeStateMounts),
  ]
}

function runtimeMountList(value: unknown): WorkspaceRecipeMount[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is WorkspaceRecipeMount => Boolean(objectValue(entry)))
}

function componentPlugins(contracts: Array<Record<string, unknown>> | undefined, artifactsRoot: string): Array<{ source: string; slug: string; activate: boolean; loadAs: string; metadata: Record<string, unknown> }> {
  if (!Array.isArray(contracts)) return []
  return contracts.flatMap((contract, index) => {
    const slug = slugFromPath(stringValue(contract.slug || contract.component || contract.name))
    const source = stringValue(contract.path || contract.source)
    const originalSource = stringValue(contract.original_source || contract.originalSource || contract.original_path || contract.originalPath)
    if (!slug || !source) return []
    const preparedSource = prepareComponentPluginSource(source, originalSource, slug, artifactsRoot)
    return [{
      source: preparedSource,
      slug,
      activate: Boolean(contract.activate),
      loadAs: stringValue(contract.loadAs) || "mu-plugin",
      metadata: stripUndefined({
        componentContract: {
          index,
          slug,
          requestedPath: source,
          originalPath: originalSource || undefined,
          preparedPath: preparedSource,
          loadAs: stringValue(contract.loadAs) || "mu-plugin",
          activate: Boolean(contract.activate),
        },
      }),
    }]
  })
}

function prepareComponentPluginSource(source: string, originalSource: string, slug: string, artifactsRoot: string): string {
  if (!artifactsRoot) {
    return prepareComposerPluginSource(originalSource || source, slug, artifactsRoot)
  }

  const preparedSource = preparedPluginSource(artifactsRoot, slug)
  const copySource = localSourcePath(originalSource || source)
  if (!pathExists(copySource)) {
    return prepareComposerPluginSource(source, slug, artifactsRoot)
  }

  if (resolve(copySource) !== resolve(preparedSource)) {
    rmSyncSafe(preparedSource)
    mkdirSyncSafe(preparedPluginRoot(artifactsRoot))
    cpSyncFiltered(copySource, preparedSource)
  } else {
    mkdirSyncSafe(preparedSource)
  }

  return installComposerDependenciesIfNeeded(preparedSource, slug)
}

function prepareComposerPluginSource(source: string, slug: string, artifactsRoot: string): string {
  if (!source) return source

  const localSource = localSourcePath(source)
  if (!pathExists(join(localSource, "composer.json"))) {
    return pathExists(localSource) ? localSource : source
  }
  if (pathExists(join(localSource, "vendor", "autoload.php"))) {
    return localSource
  }
  if (!artifactsRoot) {
    throw new Error(`Plugin ${slug} requires Composer dependencies but no artifacts directory is available for staging.`)
  }

  const preparedRoot = preparedPluginRoot(artifactsRoot)
  const preparedSource = preparedPluginSource(artifactsRoot, slug)
  if (resolve(localSource) !== resolve(preparedSource)) {
    rmSyncSafe(preparedSource)
    mkdirSyncSafe(preparedRoot)
    cpSyncFiltered(localSource, preparedSource)
  } else {
    mkdirSyncSafe(preparedSource)
  }

  return installComposerDependenciesIfNeeded(preparedSource, slug)
}

function installComposerDependenciesIfNeeded(source: string, slug: string): string {
  if (!pathExists(join(source, "composer.json")) || pathExists(join(source, "vendor", "autoload.php"))) {
    return source
  }

  const result = spawnSync("composer", ["install", "--no-interaction", "--prefer-dist", "--no-progress"], {
    cwd: source,
    encoding: "utf8",
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

function preparedPluginRoot(artifactsRoot: string): string {
  return resolve(artifactsRoot, "prepared-plugins")
}

function preparedPluginSource(artifactsRoot: string, slug: string): string {
  return join(preparedPluginRoot(artifactsRoot), slug)
}

function localSourcePath(source: string): string {
  return pathExists(source) ? resolve(source) : source
}

function pathExists(filePath: string): boolean {
  return existsSync(filePath)
}

function rmSyncSafe(filePath: string): void {
  rmSync(filePath, { recursive: true, force: true })
}

function mkdirSyncSafe(filePath: string): void {
  mkdirSync(filePath, { recursive: true })
}

function cpSyncFiltered(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    filter: (entry: string) => {
      const base = basename(entry)
      return base !== ".git" && base !== "node_modules" && base !== "vendor"
    },
  })
}

function sandboxToolPolicy(input: AgentTaskRunInput, taskInput: TaskInput): SandboxToolPolicySnapshot {
  const policy = objectValue(input.sandbox_tool_policy) || objectValue(taskInput.sandbox_tool_policy)
  if (policy) {
    return policy as unknown as SandboxToolPolicySnapshot
  }
  return {
    schema: "wp-codebox/sandbox-tool-policy/v1",
    version: 1,
    tools: [{ id: "deny-all", runtime_tool_id: "deny-all", execution_location: "parent", transport_visibility: "hidden", allowed: false, runtime: { environment: "control_plane", capability_scope: "control_plane" } }],
    metadata: { source: "wp-codebox.agent-task-run.default-deny" },
  }
}

function slugFromPath(source: string): string {
  const base = source.replace(/\/$/, "").split("/").pop() || "provider"
  return base.replace(/[^A-Za-z0-9_-]/g, "-")
}

function slugFromComposerPackage(source: string): string {
  try {
    const composer = JSON.parse(readFileSync(join(source, "composer.json"), "utf8")) as { name?: unknown }
    const name = stringValue(composer.name)
    if (!name) return ""
    return slugFromPath(name.split("/").pop() || name)
  } catch {
    return ""
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
