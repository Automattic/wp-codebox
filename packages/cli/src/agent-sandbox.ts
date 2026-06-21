import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { commandArgValue, commandDiagnosticsCaptureArgs, normalizeSandboxToolPolicySnapshot, normalizeStructuredArtifacts, parseCommandJson, parseCommandJsonArray, parseCommandJsonObject, type ExecutionSpec, type MountSpec, type RuntimePolicy, type SandboxToolPolicySnapshot, type SandboxWorkspaceContract, type SandboxWorkspaceMode, type StructuredArtifactPayload, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { resolvePluginEntrypointContract, type ComponentLoadMode } from "@automattic/wp-codebox-core"
import { SANDBOX_WORKSPACE_ROOT, stripUndefined } from "@automattic/wp-codebox-core/internals"
import { agentRuntimeProbeCode, agentSandboxRunCode, resolveSandboxTaskCode } from "./agent-code.js"
import type { AgentBundleSpec } from "./agent-code.js"
import type { PreparedWorkspaceMount } from "./recipe-sources.js"
import { defaultPolicy } from "./recipe-validation.js"

export interface AgentRuntimeProbeOptions {
  providerPluginPaths: string[]
  components: AgentRuntimeComponent[]
  mounts: AgentRuntimeMount[]
  wpVersion?: string
  artifactsDirectory?: string
  secretEnvNames?: string[]
  json: boolean
}

export interface AgentSandboxRunOptions extends AgentRuntimeProbeOptions {
  task: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  sessionId?: string
  maxTurns?: string
  timeoutSeconds?: string
  agentBundles?: AgentBundleSpec[]
  runtimeTask?: Record<string, unknown>
  structuredArtifacts?: StructuredArtifactPayload[]
  sandboxToolPolicy?: SandboxToolPolicySnapshot
  code?: string
  codeFile?: string
  sandboxWorkspace?: SandboxWorkspaceContract
}

export interface AgentSandboxBatchOptions extends AgentRuntimeProbeOptions {
  tasks: string[]
  agent?: string
  mode?: string
  provider?: string
  model?: string
  maxTurns?: string
  concurrency?: string
}

export interface AgentSandboxBatchOutput {
  success: boolean
  schema: "wp-codebox/agent-sandbox-batch/v1"
  concurrency: number
  total: number
  completed: number
  failed: number
  runs: Array<{ success: boolean; index: number; task: string }>
}

export type AgentRuntimeMount = {
  type?: MountSpec["type"]
  source: string
  target: string
  mode: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
}

export type AgentRuntimeComponent = {
  source: string
  slug: string
  pluginFile: string
  loadAs: ComponentLoadMode
  kind: "component" | "provider-plugin"
}

const secretEnvPolicy: RuntimePolicy = {
  ...defaultPolicy,
  secrets: "connector-scoped",
}

export function agentRuntimeMounts(options: AgentRuntimeProbeOptions): AgentRuntimeMount[] {
  const components = agentRuntimeComponents(options)
  return [
    ...components.map((component) => ({
      source: component.source,
      target: pluginTarget(component.slug, component.loadAs),
      mode: "readonly" as const,
      metadata: {
        kind: component.kind,
        slug: component.slug,
        pluginFile: component.pluginFile,
        loadAs: component.loadAs,
      },
    })),
    ...providerPluginMounts(options).map((plugin) => ({
      source: plugin.source,
      target: pluginTarget(plugin.slug, plugin.loadAs),
      mode: "readonly" as const,
      metadata: {
        kind: "provider-plugin",
        slug: plugin.slug,
        pluginFile: plugin.pluginFile,
        loadAs: plugin.loadAs,
      },
    })),
    ...options.mounts,
  ]
}

export async function recipeExecutionSpec(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, sandboxWorkspace?: SandboxWorkspaceContract): Promise<ExecutionSpec & { args: string[] }> {
  if (step.command === "wp-codebox.agent-runtime-probe") {
    return {
      command: "wordpress.run-php",
      args: [`code=${agentRuntimeProbeCode(providerPluginContracts(step.args ?? []))}`, ...commandDiagnosticsCaptureArgs(step.diagnostics)],
      diagnostics: step.diagnostics,
    }
  }

  if (step.command === "wp-codebox.agent-sandbox-run") {
    const args = step.args ?? []
    const task = commandArgValue(args, "task")
    if (!task) {
      throw new Error("wp-codebox.agent-sandbox-run requires task=<task>")
    }

    const codeFile = commandArgValue(args, "code-file")
    const code = commandArgValue(args, "code")
    if (code && codeFile) {
      throw new Error("Use either code=<php> or code-file=<path>, not both")
    }
    const body = codeFile ? await readFile(resolve(recipeDirectory, codeFile), "utf8") : (code ?? await resolveSandboxTaskCode({
      task,
      agent: commandArgValue(args, "agent"),
      mode: commandArgValue(args, "mode"),
      provider: commandArgValue(args, "provider"),
      model: commandArgValue(args, "model"),
      sessionId: commandArgValue(args, "session-id"),
      maxTurns: commandArgValue(args, "max-turns"),
      timeoutSeconds: commandArgValue(args, "timeout-seconds"),
      agentBundles: parseAgentBundles(args),
      runtimeTask: parseRuntimeTask(args),
      structuredArtifacts: parseStructuredArtifacts(args),
      sandboxWorkspace: parseSandboxWorkspace(args) ?? sandboxWorkspace,
      sandboxToolPolicy: parseSandboxToolPolicy(args),
    }))

    return {
      command: "wordpress.run-php",
      args: [
        `code=${agentSandboxRunCode(task, body, providerPluginContracts(args))}`,
        "wp-cli-bridge=1",
        ...commandDiagnosticsCaptureArgs(step.diagnostics),
      ],
      diagnostics: step.diagnostics,
    }
  }

  return { command: step.command, args: [...(step.args ?? []), ...commandDiagnosticsCaptureArgs(step.diagnostics)], diagnostics: step.diagnostics }
}

export function agentRuntimeMetadata(options: AgentRuntimeProbeOptions, runtimeMetadata: (artifactsDirectory: string | undefined, wpVersion: string) => Record<string, unknown>, defaultWordPressVersion: string): Record<string, unknown> {
  const base = runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? defaultWordPressVersion)

  return {
    ...base,
    task: {
      ...(base.task as Record<string, unknown>),
      kind: "agent-runtime-probe",
      secretEnv: options.secretEnvNames ?? [],
    },
  }
}

export function agentSandboxRunMetadata(options: AgentSandboxRunOptions, runtimeMetadata: (artifactsDirectory: string | undefined, wpVersion: string) => Record<string, unknown>, defaultWordPressVersion: string): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? defaultWordPressVersion),
    task: stripUndefined({
      kind: "agent-sandbox-run",
      input: options.task,
      sessionId: options.sessionId,
      maxTurns: options.maxTurns,
      timeoutSeconds: options.timeoutSeconds,
      hasCodeOverride: Boolean(options.code || options.codeFile),
      secretEnv: options.secretEnvNames ?? [],
    }),
    agent: stripUndefined({
      agent: options.agent,
      mode: options.mode,
      provider: options.provider,
      model: options.model,
    }),
  }
}

export function parseAgentRuntimeProbeOptions(args: string[], parseMount: (value: string) => AgentRuntimeMount, extraOptions: string[] = []): AgentRuntimeProbeOptions {
  const options: Partial<AgentRuntimeProbeOptions> = { json: false, mounts: [], components: [] }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--agents-api":
        options.components = [...(options.components ?? []), componentFromPath(value, "agents-api", undefined, "mu-plugin", "component")]
        break
      case "--provider-plugin":
        options.providerPluginPaths = [...(options.providerPluginPaths ?? []), value]
        break
      case "--component":
        options.components = [...(options.components ?? []), parseComponentOption(value, "component")]
        break
      case "--mount":
        options.mounts = [...(options.mounts ?? []), parseMount(value)]
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--secret-env":
        options.secretEnvNames = [...(options.secretEnvNames ?? []), value]
        break
      default:
        if (extraOptions.includes(name)) {
          break
        }
        throw new Error(`Unknown option: ${name}`)
    }
  }

  options.providerPluginPaths = options.providerPluginPaths ?? []
  options.mounts = options.mounts ?? []
  options.components = options.components ?? []

  return options as AgentRuntimeProbeOptions
}

export function parseAgentSandboxRunOptions(args: string[], parseMount: (value: string) => AgentRuntimeMount): AgentSandboxRunOptions {
  const options = parseAgentRuntimeProbeOptions(args, parseMount, ["--task", "--agent", "--mode", "--provider", "--model", "--session-id", "--max-turns", "--timeout-seconds", "--agent-bundles-json", "--runtime-task-json", "--structured-artifacts-json", "--sandbox-tool-policy-json", "--code", "--code-file", "--workspace-context-json", "--secret-env", "--mount"]) as Partial<AgentSandboxRunOptions>

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[index + 1]

    switch (name) {
      case "--task":
        options.task = value
        break
      case "--agent":
        options.agent = value
        break
      case "--mode":
        options.mode = value
        break
      case "--provider":
        options.provider = value
        break
      case "--model":
        options.model = value
        break
      case "--session-id":
        options.sessionId = value
        break
      case "--max-turns":
        options.maxTurns = value
        break
      case "--timeout-seconds":
        options.timeoutSeconds = value
        break
      case "--code":
        options.code = value
        break
      case "--code-file":
        options.codeFile = value
        break
      case "--agent-bundles-json":
        options.agentBundles = parseAgentBundleList(value)
        break
      case "--runtime-task-json":
        options.runtimeTask = parseRuntimeTaskValue(value)
        break
      case "--structured-artifacts-json":
        options.structuredArtifacts = parseStructuredArtifactsValue(value)
        break
      case "--sandbox-tool-policy-json":
        options.sandboxToolPolicy = normalizeSandboxToolPolicySnapshot(parseCommandJson(value, "sandbox-tool-policy-json"))
        break
      case "--workspace-context-json":
        options.sandboxWorkspace = parseSandboxWorkspaceValue(value)
        break
    }
  }

  if (!options.task) {
    throw new Error("Missing required option: --task")
  }

  if (options.code && options.codeFile) {
    throw new Error("Use either --code or --code-file, not both")
  }

  return options as AgentSandboxRunOptions
}

function parseAgentBundles(args: string[]): AgentBundleSpec[] {
  return parseAgentBundleList(commandArgValue(args, "agent-bundles-json") ?? "[]")
}

function parseRuntimeTask(args: string[]): Record<string, unknown> | undefined {
  const value = commandArgValue(args, "runtime-task-json")
  return value ? parseRuntimeTaskValue(value) : undefined
}

function parseStructuredArtifacts(args: string[]): StructuredArtifactPayload[] {
  const value = commandArgValue(args, "structured-artifacts-json")
  return value ? parseStructuredArtifactsValue(value) : []
}

function parseStructuredArtifactsValue(value: string): StructuredArtifactPayload[] {
  if (!value.trim()) return []
  return normalizeStructuredArtifacts(parseCommandJson(value, "structured-artifacts-json"), "input")
}

function parseRuntimeTaskValue(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined
  return parseCommandJsonObject(value, "runtime-task-json")
}

function parseSandboxWorkspace(args: string[]): SandboxWorkspaceContract | undefined {
  const value = commandArgValue(args, "workspace-context-json")
  return value ? parseSandboxWorkspaceValue(value) : undefined
}

function parseSandboxWorkspaceValue(value: string): SandboxWorkspaceContract | undefined {
  if (!value.trim()) return undefined
  const parsed = parseCommandJsonObject(value, "workspace-context-json")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schema !== "wp-codebox/sandbox-workspace/v1") {
    throw new Error("workspace-context-json must be a wp-codebox/sandbox-workspace/v1 object")
  }
  return parsed as unknown as SandboxWorkspaceContract
}

function parseAgentBundleList(value: string): AgentBundleSpec[] {
  if (!value.trim()) return []
  const parsed = parseCommandJsonArray(value, "agent-bundles-json")
  return parsed.filter((entry): entry is AgentBundleSpec => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
}

export async function parseAgentSandboxBatchOptions(args: string[], parseMount: (value: string) => AgentRuntimeMount): Promise<AgentSandboxBatchOptions> {
  const options = parseAgentRuntimeProbeOptions(args, parseMount, ["--task", "--tasks-json", "--tasks-file", "--agent", "--mode", "--provider", "--model", "--max-turns", "--concurrency", "--secret-env", "--mount"]) as Partial<AgentSandboxBatchOptions>
  options.tasks = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[index + 1]

    switch (name) {
      case "--task":
        if (value) {
          options.tasks.push(value)
        }
        break
      case "--tasks-json":
        if (value) {
          options.tasks.push(...parseTaskList(value))
        }
        break
      case "--tasks-file":
        if (value) {
          options.tasks.push(...parseTaskList(await readFile(resolve(value), "utf8")))
        }
        break
      case "--agent":
        options.agent = value
        break
      case "--mode":
        options.mode = value
        break
      case "--provider":
        options.provider = value
        break
      case "--model":
        options.model = value
        break
      case "--max-turns":
        options.maxTurns = value
        break
      case "--concurrency":
        options.concurrency = value
        break
    }
  }

  options.tasks = options.tasks.map((task) => task.trim()).filter(Boolean)
  if (options.tasks.length === 0) {
    throw new Error("Missing required option: --task, --tasks-json, or --tasks-file")
  }

  return options as AgentSandboxBatchOptions
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveSecretEnv(names: string[]): Record<string, string> {
  const secretEnv: Record<string, string> = {}
  for (const name of names) {
    const normalized = name.trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
      throw new Error(`Invalid --secret-env name: ${name}`)
    }

    const value = process.env[normalized]
    if (value) {
      secretEnv[normalized] = value
    }
  }

  return secretEnv
}

export async function runSecretEnvOptions(options: AgentRuntimeProbeOptions): Promise<Pick<{ policy?: RuntimePolicy; secretEnv?: Record<string, string> }, "policy" | "secretEnv">> {
  const secretEnv = resolveSecretEnv(options.secretEnvNames ?? [])
  if (Object.keys(secretEnv).length === 0) {
    return {}
  }

  return {
    policy: secretEnvPolicy,
    secretEnv,
  }
}

export function sandboxWorkspaceContract(workspaceMounts: PreparedWorkspaceMount[], mounts: NonNullable<WorkspaceRecipe["inputs"]>["mounts"]): SandboxWorkspaceContract {
  const mountRefs = [
    ...workspaceMounts.map((mount) => workspaceMountRef(mount.target, mount.mode, mount.metadata)),
    ...(Array.isArray(mounts) ? mounts.map((mount) => workspaceMountRef(mount.target, mount.mode ?? "readwrite", mount.metadata ?? {})) : []),
  ]

  return {
    schema: "wp-codebox/sandbox-workspace/v1",
    root: SANDBOX_WORKSPACE_ROOT,
    defaultMode: "repo-backed",
    mounts: mountRefs,
  }
}

function parseSandboxToolPolicy(args: string[]): SandboxToolPolicySnapshot | undefined {
  const raw = commandArgValue(args, "sandbox-tool-policy-json")
  if (!raw) {
    return undefined
  }

  return normalizeSandboxToolPolicySnapshot(parseCommandJson(raw, "sandbox-tool-policy-json"))
}

function agentRuntimeComponents(options: AgentRuntimeProbeOptions): AgentRuntimeComponent[] {
  const bySlug = new Map<string, AgentRuntimeComponent>()
  for (const component of options.components) {
    bySlug.set(component.slug, component)
  }
  for (const component of defaultRuntimeComponents()) {
    if (!bySlug.has(component.slug)) {
      bySlug.set(component.slug, component)
    }
  }
  for (const component of options.components) {
    if (bySlug.has("agents-api")) {
      break
    }
    const agentsApiPath = agentsApiPathFromRuntimeComponent(component)
    if (agentsApiPath) {
      const agentsApi = componentFromPath(agentsApiPath, "agents-api", undefined, "mu-plugin", "component")
      bySlug.set(agentsApi.slug, agentsApi)
    }
  }
  if (!bySlug.has("agents-api")) {
    const agentsApiPath = defaultAgentsApiPath()
    if (agentsApiPath) {
      const agentsApi = componentFromPath(agentsApiPath, "agents-api", undefined, "mu-plugin", "component")
      bySlug.set(agentsApi.slug, agentsApi)
    }
  }
  return [...bySlug.values()]
}

function defaultRuntimeComponents(): AgentRuntimeComponent[] {
  return defaultRuntimeComponentPaths()
    .map((source) => componentFromPath(source, undefined, undefined, "mu-plugin", "component"))
}

function defaultRuntimeComponentPaths(): string[] {
  return (process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS ?? "")
    .split(/[,:]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value))
    .filter((source) => existsSync(source))
}

function defaultAgentsApiPath(): string {
  const explicit = [process.env.WP_CODEBOX_AGENTS_API_PATH, process.env.AGENTS_API_PATH]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => resolve(value))
    .find(isAgentsApiPluginRoot)

  if (explicit) {
    return explicit
  }

  const candidates: string[] = []
  let current = resolve(process.cwd())
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(join(current, "agents-api"), join(dirname(current), "agents-api"))
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return candidates.find(isAgentsApiPluginRoot) ?? ""
}

function isAgentsApiPluginRoot(candidate: string): boolean {
  return existsSync(join(candidate, "agents-api.php"))
}

function agentsApiPathFromRuntimeComponent(component: AgentRuntimeComponent): string {
  return [
    join(component.source, "vendor", "wordpress", "agents-api"),
    join(component.source, "vendor", "automattic", "agents-api"),
  ].find((candidate) => existsSync(join(candidate, "agents-api.php"))) ?? ""
}

function providerPluginSlugs(args: string[]): string[] {
  const csv = commandArgValue(args, "provider-plugin-slugs") ?? ""
  return csv.split(",").map((slug) => slug.trim()).filter(Boolean)
}

function providerPluginMounts(options: AgentRuntimeProbeOptions): AgentRuntimeComponent[] {
  return options.providerPluginPaths.map((pluginPath) => {
    return componentFromPath(pluginPath, undefined, undefined, "plugin", "provider-plugin")
  })
}

function componentFromPath(sourcePath: string, slug: string | undefined, pluginFile: string | undefined, loadAs: ComponentLoadMode, kind: AgentRuntimeComponent["kind"]): AgentRuntimeComponent {
  const source = resolve(sourcePath)
  const entrypoint = resolvePluginEntrypointContract({ source, slug, pluginFile, loadAs })
  return { source, slug: entrypoint.slug, pluginFile: entrypoint.pluginFile, loadAs: entrypoint.loadAs, kind }
}

function parseComponentOption(raw: string, kind: AgentRuntimeComponent["kind"]): AgentRuntimeComponent {
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean)
  const fields = new Map<string, string>()
  let source = ""
  for (const part of parts) {
    const equals = part.indexOf("=")
    if (equals === -1) {
      source = source || part
      continue
    }
    fields.set(part.slice(0, equals), part.slice(equals + 1))
  }
  source = fields.get("source") || fields.get("path") || source
  let slug = fields.get("slug")
  if (!source && fields.size === 1) {
    const [entry] = fields.entries()
    if (entry) {
      slug = entry[0]
      source = entry[1]
    }
  }
  if (!source) {
    throw new Error("--component requires a source path")
  }
  return componentFromPath(source, slug, fields.get("pluginFile"), fields.get("loadAs") === "plugin" ? "plugin" : "mu-plugin", kind)
}

function providerPluginContracts(args: string[]): Array<{ slug: string; pluginFile?: string; loadAs?: ComponentLoadMode }> {
  const explicit = commandArgValue(args, "provider-plugin-contracts-json")
  if (explicit) {
    const parsed = parseCommandJsonArray(explicit, "provider-plugin-contracts-json")
    return parsed
      .filter((plugin) => plugin && typeof plugin === "object" && !Array.isArray(plugin))
      .map((plugin) => plugin as { slug: string; pluginFile?: string; loadAs?: ComponentLoadMode })
  }
  return providerPluginSlugs(args).map((slug) => ({ slug }))
}

function pluginTarget(slug: string, loadAs: ComponentLoadMode): string {
  return loadAs === "mu-plugin" ? `/wordpress/wp-content/mu-plugins/wp-codebox-runtime/${slug}` : `/wordpress/wp-content/plugins/${slug}`
}

function parseTaskList(raw: string): string[] {
  const parsed = parseCommandJsonArray(raw, "Task list")

  return parsed.map((task) => {
    if (typeof task === "string") {
      return task
    }

    if (task && typeof task === "object" && "task" in task && typeof task.task === "string") {
      return task.task
    }

    throw new Error("Task list entries must be strings or objects with a task string")
  })
}

function workspaceMountRef(target: string, mode: "readonly" | "readwrite", metadata: Record<string, unknown> = {}): SandboxWorkspaceContract["mounts"][number] {
  const sourceMode: SandboxWorkspaceMode = metadata.sourceMode === "site-backed" ? "site-backed" : "repo-backed"

  return stripUndefined({
    target,
    mode,
    sourceMode,
    workspaceRef: typeof metadata.workspaceRef === "string" ? metadata.workspaceRef : undefined,
    mountRole: typeof metadata.mountRole === "string" ? metadata.mountRole : typeof metadata.kind === "string" ? metadata.kind : undefined,
    component: typeof metadata.component === "string" ? metadata.component : typeof metadata.slug === "string" ? metadata.slug : undefined,
    repo: typeof metadata.repo === "string" ? metadata.repo : undefined,
    gitRef: typeof metadata.gitRef === "string" ? metadata.gitRef : typeof metadata.default_branch === "string" ? metadata.default_branch : undefined,
    defaultBranch: typeof metadata.default_branch === "string" ? metadata.default_branch : undefined,
    wpContentPath: typeof metadata.wpContentPath === "string" ? metadata.wpContentPath : undefined,
  })
}
