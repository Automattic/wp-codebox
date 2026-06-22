import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { SandboxToolPolicySnapshot } from "./sandbox-tool-policy.js"
import type { StructuredArtifactPayload } from "./structured-artifacts.js"
import type { TaskInput } from "./task-input.js"
import { isPlainObject, stringList, stripUndefined } from "./object-utils.js"
import type { WorkspaceRecipe, WorkspaceRecipeComponentManifest, WorkspaceRecipeComponentManifestEntry, WorkspaceRecipeExtraPlugin, WorkspaceRecipeMount, WorkspaceRecipeStagedFile } from "./runtime-contracts.js"
import { resolvePluginEntrypointContract, sanitizePluginSlug } from "./component-contracts.js"
import { prepareRecipeSourcePackageSync } from "./recipe-source-packages.js"
import { workspacePreloadsFromTaskInputs } from "./workspace-preload-artifacts.js"

const AGENT_RUNTIME_ENV = { WP_AGENT_RUNTIME: "1" }

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
  extra_plugins?: WorkspaceRecipeExtraPlugin[]
  extraPlugins?: WorkspaceRecipeExtraPlugin[]
  runtime_stack_mounts?: WorkspaceRecipeMount[]
  runtime_overlays?: Array<Record<string, unknown>>
  agent_bundles?: Array<Record<string, unknown>>
  stagedFiles?: WorkspaceRecipeStagedFile[]
  runtime_task?: Record<string, unknown>
  agent_bundle?: Record<string, unknown>
  workspace_preloads?: unknown
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

export interface RuntimeDependencyPlanContractInput {
  selection?: Record<string, unknown>
  provider_plugin_paths?: unknown
  provider_plugins?: unknown
  component_plugins?: unknown
  runtime_overlays?: unknown
  inheritance_request?: { connectors?: unknown; settings?: unknown }
  inheritance?: { connectors?: unknown; settings?: unknown }
  agent_bundles?: unknown
  secret_env?: unknown
  runtime_env?: unknown
  runtimeEnv?: unknown
}

export function buildAgentTaskRecipe(input: AgentTaskRunInput, taskInput: TaskInput, wpVersion: string): WorkspaceRecipe {
  const artifacts = stringValue(input.artifacts_path)
  const profile = runtimeOverlayProfileDefaults(input)
  const runtimeMounts = runtimeStateMounts(input)
  const agentBundleStagedFiles = stagedAgentBundleSources(input.agent_bundles)
  const stagedFiles = [...(Array.isArray(input.stagedFiles) ? input.stagedFiles : []), ...agentBundleStagedFiles]
  const providerPlugins: WorkspaceRecipeExtraPlugin[] = stringList(input.provider_plugin_paths)
    .map((plugin) => {
      const slug = slugFromComposerPackage(plugin) || slugFromPath(plugin)
      const preparedSource = prepareRecipeSourcePackageSync({ source: plugin, slug, artifactsRoot: artifacts, packageRootName: "prepared-plugins" })
      const entrypoint = resolvePluginEntrypointContract({ source: preparedSource, slug })
      return { source: preparedSource, slug, pluginFile: entrypoint.pluginFile, activate: true, loadAs: "plugin" }
    })
  const providerSlugs = providerPlugins.map((plugin) => plugin.slug).join(",")
  const providerContracts = providerPlugins.map((plugin) => ({ slug: plugin.slug, pluginFile: plugin.pluginFile, loadAs: plugin.loadAs ?? "plugin" }))
  const componentPluginEntries = componentPlugins(input.component_contracts, artifacts)
  const callerExtraPlugins = agentTaskExtraPlugins(input)
  const defaultRuntimeComponents = defaultAgentRuntimeComponentPlugins(componentPluginEntries, callerExtraPlugins)
  const extraPlugins = dedupeExtraPlugins([
    ...defaultRuntimeComponents,
    ...componentPluginEntries,
    ...providerPlugins,
    ...callerExtraPlugins,
  ].filter(Boolean))
  const componentManifest = componentManifestForRuntimePlugins([...defaultRuntimeComponents, ...componentPluginEntries], providerPlugins)
  const workflowArgs = [
    `task=${taskInput.goal}`,
    `agent=${stringValue(input.agent) || "wp-codebox-sandbox"}`,
    `mode=${stringValue(input.mode) || "sandbox"}`,
    `provider=${stringValue(input.provider)}`,
    `model=${stringValue(input.model)}`,
    `provider-plugin-slugs=${providerSlugs}`,
    `provider-plugin-contracts-json=${JSON.stringify(providerContracts)}`,
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
      workspace_preloads: workspacePreloadsFromTaskInputs({ ...input, structured_artifacts: taskInput.structured_artifacts }),
      dependency_overlays: Array.isArray(input.dependency_overlays) ? input.dependency_overlays : undefined,
      extra_plugins: extraPlugins,
      component_manifest: componentManifest,
      runtimeEnv: { ...runtimeEnv(input), ...AGENT_RUNTIME_ENV },
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

function defaultAgentRuntimeComponentPlugins(componentPlugins: WorkspaceRecipeExtraPlugin[], callerExtraPlugins: WorkspaceRecipeExtraPlugin[]): WorkspaceRecipeExtraPlugin[] {
  const existingSlugs = new Set([...componentPlugins, ...callerExtraPlugins].map((plugin) => plugin.slug))
  const defaults: WorkspaceRecipeExtraPlugin[] = []

  for (const component of defaultRuntimeComponentPlugins()) {
    if (!existingSlugs.has(component.slug)) {
      defaults.push(component)
      existingSlugs.add(component.slug)
    }
  }

  return defaults
}

function defaultRuntimeComponentPlugins(): WorkspaceRecipeExtraPlugin[] {
  return defaultRuntimeComponentPaths().map((source) => {
    const entrypoint = resolvePluginEntrypointContract({ source, loadAs: "mu-plugin" })
    return {
      source,
      slug: entrypoint.slug,
      pluginFile: entrypoint.pluginFile,
      activate: false,
      loadAs: "mu-plugin" as const,
      metadata: { source: "wp-codebox-default-agent-runtime-substrate" },
    }
  })
}

function defaultRuntimeComponentPaths(): string[] {
  return (process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS ?? "")
    .split(/[,:]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value))
    .filter((source) => existsSync(source))
}

export function componentManifestForRuntimePlugins(componentPlugins: WorkspaceRecipeExtraPlugin[], providerPlugins: WorkspaceRecipeExtraPlugin[]): WorkspaceRecipeComponentManifest {
  return {
    schema: "wp-codebox/component-manifest/v1",
    components: componentPlugins.map(componentManifestEntry),
    providers: providerPlugins.map(componentManifestEntry),
  }
}

export function runtimeDependencyPlanContract(input: RuntimeDependencyPlanContractInput): Record<string, unknown> {
  const inheritance = input.inheritance && typeof input.inheritance === "object" ? input.inheritance : {}
  const inheritanceRequest = input.inheritance_request && typeof input.inheritance_request === "object" ? input.inheritance_request : {}
  return stripEmptyContractFields({
    schema: "wp-codebox/runtime-dependency-plan/v1",
    selection: stripEmptyRecordFields(input.selection ?? {}),
    provider_plugin_paths: stringList(input.provider_plugin_paths),
    provider_plugins: objectList(input.provider_plugins),
    component_plugins: objectList(input.component_plugins),
    runtime_overlays: objectList(input.runtime_overlays),
    inheritance_request: {
      connectors: stringList(inheritanceRequest.connectors),
      settings: stringList(inheritanceRequest.settings),
    },
    inheritance: {
      connectors: objectList(inheritance.connectors),
      settings: objectList(inheritance.settings),
    },
    agent_bundles: objectList(input.agent_bundles),
    secret_env: stringList(input.secret_env).filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)),
    runtime_env: runtimeEnvMap(input.runtime_env ?? input.runtimeEnv),
  })
}

function runtimeEnvMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, entry]) => /^[A-Z_][A-Z0-9_]*$/.test(name) && (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"))
      .map(([name, entry]) => [name, runtimeEnvString(entry)]),
  )
}

function runtimeEnvString(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "1" : "") : String(value)
}

function componentManifestEntry(plugin: WorkspaceRecipeExtraPlugin): WorkspaceRecipeComponentManifestEntry {
  const metadata = plugin.metadata && typeof plugin.metadata === "object" && !Array.isArray(plugin.metadata) ? plugin.metadata : {}
  const contract = metadata.componentContract && typeof metadata.componentContract === "object" && !Array.isArray(metadata.componentContract)
    ? metadata.componentContract as Record<string, unknown>
    : {}
  const pluginFile = stringValue(plugin.pluginFile)
  return stripUndefined({
    slug: stringValue(plugin.slug),
    source: stringValue(plugin.source),
    mountedPath: componentMountedPath(stringValue(plugin.slug), plugin.loadAs === "mu-plugin" ? "mu-plugin" : "plugin"),
    entrypoint: pluginFile,
    pluginFile,
    loadAs: plugin.loadAs,
    activate: plugin.activate,
    contractIndex: typeof contract.index === "number" ? contract.index : undefined,
    requestedPath: stringValue(contract.requestedPath) || undefined,
    provenance: Object.keys(metadata).length > 0 ? metadata : undefined,
  })
}

function objectList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isPlainObject) : []
}

function stripEmptyRecordFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== "" && !(Array.isArray(entry) && entry.length === 0)))
}

function stripEmptyContractFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== "" && !(Array.isArray(entry) && entry.length === 0)))
}

function componentMountedPath(slug: string, loadAs: "plugin" | "mu-plugin"): string {
  return loadAs === "mu-plugin"
    ? `/wordpress/wp-content/mu-plugins/wp-codebox-runtime/${slug}`
    : `/wordpress/wp-content/plugins/${slug}`
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

function agentTaskExtraPlugins(input: AgentTaskRunInput): WorkspaceRecipeExtraPlugin[] {
  return [
    ...normalizeAgentTaskExtraPlugins(input.extra_plugins),
    ...normalizeAgentTaskExtraPlugins(input.extraPlugins),
  ]
}

function dedupeExtraPlugins(plugins: WorkspaceRecipeExtraPlugin[]): WorkspaceRecipeExtraPlugin[] {
  const seen = new Set<string>()
  const deduped: WorkspaceRecipeExtraPlugin[] = []
  for (const plugin of plugins) {
    const key = `${stringValue(plugin.slug) || slugFromPath(stringValue(plugin.source))}:${plugin.loadAs === "plugin" ? "plugin" : "mu-plugin"}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(plugin)
  }
  return deduped
}

function normalizeAgentTaskExtraPlugins(value: unknown): WorkspaceRecipeExtraPlugin[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!isPlainObject(entry)) return []
    const source = stringValue(entry.source)
    if (!source) return []
    return [stripUndefined({
      source,
      slug: stringValue(entry.slug) || undefined,
      pluginFile: stringValue(entry.pluginFile) || undefined,
      activate: typeof entry.activate === "boolean" ? entry.activate : undefined,
      sha256: stringValue(entry.sha256) || undefined,
      loadAs: entry.loadAs === "plugin" || entry.loadAs === "mu-plugin" ? entry.loadAs : undefined,
      metadata: isPlainObject(entry.metadata) ? entry.metadata : undefined,
    }) as WorkspaceRecipeExtraPlugin]
  })
}

function componentPlugins(contracts: Array<Record<string, unknown>> | undefined, artifactsRoot: string): WorkspaceRecipeExtraPlugin[] {
  if (!Array.isArray(contracts)) return []
  return contracts.flatMap((contract, index) => {
    const slug = slugFromPath(stringValue(contract.slug || contract.component || contract.name))
    const source = stringValue(contract.path || contract.source)
    const originalSource = stringValue(contract.original_source || contract.originalSource || contract.original_path || contract.originalPath)
    if (!slug || !source) return []
    const preparedSource = prepareComponentPluginSource(source, originalSource, slug, artifactsRoot)
    const entrypoint = resolvePluginEntrypointContract({
      source: preparedSource,
      slug,
      pluginFile: stringValue(contract.pluginFile),
      loadAs: stringValue(contract.loadAs) === "plugin" ? "plugin" : "mu-plugin",
    })
    const loadAs = stringValue(contract.loadAs) === "plugin" ? "plugin" : "mu-plugin"
    return [{
      source: preparedSource,
      slug,
      pluginFile: entrypoint.pluginFile,
      activate: Boolean(contract.activate),
      loadAs,
      metadata: stripUndefined({
        componentContract: {
          index,
          slug,
          requestedPath: source,
          originalPath: originalSource || undefined,
          preparedPath: preparedSource,
          pluginFile: entrypoint.pluginFile,
          pluginEntrypointFallback: entrypoint.fallback,
          loadAs,
          activate: Boolean(contract.activate),
        },
      }),
    }]
  })
}

function prepareComponentPluginSource(source: string, originalSource: string, slug: string, artifactsRoot: string): string {
  return prepareRecipeSourcePackageSync({ source, originalSource, slug, artifactsRoot, packageRootName: "prepared-plugins" })
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
  return sanitizePluginSlug(base)
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
