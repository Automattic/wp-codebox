import { readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { normalizeSandboxToolPolicySnapshot, SANDBOX_WORKSPACE_ROOT, stripUndefined, type MountSpec, type RuntimePolicy, type SandboxToolPolicySnapshot, type SandboxWorkspaceContract, type SandboxWorkspaceMode, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { agentRuntimeProbeCode, agentSandboxRunCode, resolveSandboxTaskCode } from "./agent-code.js"
import type { AgentBundleSpec } from "./agent-code.js"
import type { PreparedWorkspaceMount } from "./recipe-sources.js"
import { defaultPolicy } from "./recipe-validation.js"

export interface AgentRuntimeProbeOptions {
  agentsApiPath: string
  dataMachinePath: string
  dataMachineCodePath: string
  providerPluginPaths: string[]
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
  datamachineBundle?: Record<string, unknown>
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

const secretEnvPolicy: RuntimePolicy = {
  ...defaultPolicy,
  secrets: "connector-scoped",
}

export function agentRuntimeMounts(options: AgentRuntimeProbeOptions): AgentRuntimeMount[] {
  return [
    componentMount(options.agentsApiPath, "/wordpress/wp-content/plugins/agents-api", "agents-api"),
    componentMount(options.dataMachinePath, "/wordpress/wp-content/plugins/data-machine", "data-machine"),
    componentMount(options.dataMachineCodePath, "/wordpress/wp-content/plugins/data-machine-code", "data-machine-code"),
    ...providerPluginMounts(options).map((plugin) => ({
      source: plugin.source,
      target: `/wordpress/wp-content/plugins/${plugin.slug}`,
      mode: "readonly" as const,
      metadata: {
        kind: "provider-plugin",
        slug: plugin.slug,
      },
    })),
    ...options.mounts,
  ]
}

export async function recipeExecutionSpec(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, sandboxWorkspace?: SandboxWorkspaceContract): Promise<{ command: string; args: string[] }> {
  if (step.command === "wp-codebox.agent-runtime-probe") {
    return {
      command: "wordpress.run-php",
      args: [`code=${agentRuntimeProbeCode(providerPluginSlugs(step.args ?? []).map((slug) => ({ source: "", slug })))}`],
    }
  }

  if (step.command === "wp-codebox.agent-sandbox-run") {
    const args = step.args ?? []
    const task = argValue(args, "task")
    if (!task) {
      throw new Error("wp-codebox.agent-sandbox-run requires task=<task>")
    }

    const codeFile = argValue(args, "code-file")
    const code = argValue(args, "code")
    if (code && codeFile) {
      throw new Error("Use either code=<php> or code-file=<path>, not both")
    }
    const body = codeFile ? await readFile(resolve(recipeDirectory, codeFile), "utf8") : (code ?? await resolveSandboxTaskCode({
      task,
      agent: argValue(args, "agent"),
      mode: argValue(args, "mode"),
      provider: argValue(args, "provider"),
      model: argValue(args, "model"),
      sessionId: argValue(args, "session-id"),
      maxTurns: argValue(args, "max-turns"),
      timeoutSeconds: argValue(args, "timeout-seconds"),
      agentBundles: parseAgentBundles(args),
      datamachineBundle: parseDatamachineBundle(args),
      sandboxWorkspace: parseSandboxWorkspace(args) ?? sandboxWorkspace,
      sandboxToolPolicy: parseSandboxToolPolicy(args),
    }))

    return {
      command: "wordpress.run-php",
      args: [
        `code=${agentSandboxRunCode(task, body, providerPluginSlugs(args).map((slug) => ({ source: "", slug })))}`,
        "wp-cli-bridge=1",
      ],
    }
  }

  return { command: step.command, args: step.args ?? [] }
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
  const options: Partial<AgentRuntimeProbeOptions> = { json: false, mounts: [] }

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
        options.agentsApiPath = value
        break
      case "--data-machine":
        options.dataMachinePath = value
        break
      case "--data-machine-code":
        options.dataMachineCodePath = value
        break
      case "--provider-plugin":
        options.providerPluginPaths = [...(options.providerPluginPaths ?? []), value]
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

  for (const [key, option] of [
    ["--agents-api", options.agentsApiPath],
    ["--data-machine", options.dataMachinePath],
    ["--data-machine-code", options.dataMachineCodePath],
  ] as const) {
    if (!option) {
      throw new Error(`Missing required option: ${key}`)
    }
  }

  options.providerPluginPaths = options.providerPluginPaths ?? []
  options.mounts = options.mounts ?? []

  return options as AgentRuntimeProbeOptions
}

export function parseAgentSandboxRunOptions(args: string[], parseMount: (value: string) => AgentRuntimeMount): AgentSandboxRunOptions {
  const options = parseAgentRuntimeProbeOptions(args, parseMount, ["--task", "--agent", "--mode", "--provider", "--model", "--session-id", "--max-turns", "--timeout-seconds", "--agent-bundles-json", "--datamachine-bundle-json", "--sandbox-tool-policy-json", "--code", "--code-file", "--workspace-context-json", "--secret-env", "--mount"]) as Partial<AgentSandboxRunOptions>

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
      case "--datamachine-bundle-json":
        options.datamachineBundle = parseDatamachineBundleValue(value)
        break
      case "--sandbox-tool-policy-json":
        options.sandboxToolPolicy = normalizeSandboxToolPolicySnapshot(JSON.parse(value))
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
  return parseAgentBundleList(argValue(args, "agent-bundles-json") ?? "[]")
}

function parseDatamachineBundle(args: string[]): Record<string, unknown> | undefined {
  const value = argValue(args, "datamachine-bundle-json")
  return value ? parseDatamachineBundleValue(value) : undefined
}

function parseDatamachineBundleValue(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("datamachine-bundle-json must be an object")
  }
  return parsed as Record<string, unknown>
}

function parseSandboxWorkspace(args: string[]): SandboxWorkspaceContract | undefined {
  const value = argValue(args, "workspace-context-json")
  return value ? parseSandboxWorkspaceValue(value) : undefined
}

function parseSandboxWorkspaceValue(value: string): SandboxWorkspaceContract | undefined {
  if (!value.trim()) return undefined
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schema !== "wp-codebox/sandbox-workspace/v1") {
    throw new Error("workspace-context-json must be a wp-codebox/sandbox-workspace/v1 object")
  }
  return parsed as SandboxWorkspaceContract
}

function parseAgentBundleList(value: string): AgentBundleSpec[] {
  if (!value.trim()) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) {
    throw new Error("agent-bundles-json must be an array")
  }
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
  const raw = argValue(args, "sandbox-tool-policy-json")
  if (!raw) {
    return undefined
  }

  return normalizeSandboxToolPolicySnapshot(JSON.parse(raw))
}

function componentMount(source: string, target: string, slug: string): AgentRuntimeMount {
  return {
    source: resolve(source),
    target,
    mode: "readonly",
    metadata: {
      kind: "component",
      slug,
    },
  }
}

function argValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function providerPluginSlugs(args: string[]): string[] {
  const csv = argValue(args, "provider-plugin-slugs") ?? ""
  return csv.split(",").map((slug) => slug.trim()).filter(Boolean)
}

function providerPluginMounts(options: AgentRuntimeProbeOptions): Array<{ source: string; slug: string }> {
  return options.providerPluginPaths.map((pluginPath) => {
    const source = resolve(pluginPath)
    return { source, slug: basename(source) }
  })
}

function parseTaskList(raw: string): string[] {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error("Task list must be a JSON array")
  }

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
