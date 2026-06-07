import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { spawnSync } from "node:child_process"
import { DEFAULT_WORDPRESS_VERSION, normalizeAgentRuntimeWorkload, normalizeTaskInput, stripUndefined, type SandboxToolPolicySnapshot, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { runRecipeRunCommand } from "./recipe-run.js"

export interface AgentTaskRunOptions {
  inputPath: string
  json: boolean
  previewHoldSeconds: string
  previewPublicUrl: string
}

export interface AgentTaskRunInput {
  goal?: string
  task?: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  provider_plugin_paths?: string[]
  runtime_overlay_profiles?: string[]
  secret_env?: string[]
  mounts?: NonNullable<WorkspaceRecipe["inputs"]>["mounts"]
  workspaces?: NonNullable<WorkspaceRecipe["inputs"]>["workspaces"]
  runtime_stack_mounts?: Array<Record<string, unknown>>
  runtime_overlays?: Array<Record<string, unknown>>
  agent_bundles?: Array<Record<string, unknown>>
  runtime_task?: Record<string, unknown>
  agent_bundle?: Record<string, unknown>
  sandbox_tool_policy?: SandboxToolPolicySnapshot
  max_turns?: number | string
  task_timeout_seconds?: number | string
  session_id?: string
  sandbox_session_id?: string
  artifacts_path?: string
  wp?: string
  agents_api_path?: string
  data_machine_path?: string
  data_machine_code_path?: string
  runtime_component_paths?: Record<string, unknown>
  parent_request?: Record<string, unknown>
  orchestrator?: Record<string, unknown>
}

interface AgentTaskRunOutput {
  success: boolean
  schema: "wp-codebox/agent-task-run/v1"
  status: "completed" | "failed"
  session: Record<string, unknown>
  task: string
  task_input: ReturnType<typeof normalizeTaskInput>
  wp: string
  artifacts: string
  agent_result: Record<string, unknown>
  agent_task_result: Record<string, unknown>
  completion_outcome: Record<string, unknown>
  run: Record<string, unknown>
  diagnostics: Array<Record<string, unknown>>
  evidence_refs: Array<Record<string, unknown>>
  run_metadata: Record<string, unknown>
  metadata: Record<string, unknown>
}

export async function runAgentTaskRunCommand(args: string[]): Promise<number> {
  const options = parseAgentTaskRunOptions(args)
  const input = JSON.parse(await readFile(options.inputPath, "utf8")) as AgentTaskRunInput
  const output = await runAgentTask(input, options)

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return output.success ? 0 : 1
  }

  process.stdout.write(`${output.status}: ${output.task}\n`)
  return output.success ? 0 : 1
}

export async function runAgentTask(input: AgentTaskRunInput, options: AgentTaskRunOptions): Promise<AgentTaskRunOutput> {
  const taskInput = normalizeTaskInput(input)
  const task = taskInput.goal
  const wpVersion = stringValue(input.wp) || DEFAULT_WORDPRESS_VERSION
  const artifacts = stringValue(input.artifacts_path) || await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-artifacts-"))
  const recipeDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-recipe-"))
  const recipePath = join(recipeDirectory, "recipe.json")
  const recipe = buildAgentTaskRecipe(input, taskInput, wpVersion)

  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`)
  try {
    const recipeRunArgs = ["--recipe", recipePath, "--artifacts", artifacts, "--json"]
    if (options.previewHoldSeconds) {
      recipeRunArgs.push("--preview-hold-seconds", options.previewHoldSeconds)
    }
    if (options.previewPublicUrl) {
      recipeRunArgs.push("--preview-public-url", options.previewPublicUrl)
    }
    const capture = await captureStdout(() => runRecipeRunCommand(recipeRunArgs))
    const run = parseRecipeRunOutput(capture.stdout)
    const runRecord = objectValue(run.run) || {}
    const artifactsRecord = objectValue(run.artifacts) || {}
    const runtimeRecord = objectValue(run.runtime) || {}
    const agentBundle = objectValue(input.agent_bundle) || {}
    const workload = normalizeAgentRuntimeWorkload(run, {
      requiredOutputs: stringRecord(agentBundle.engine_data_outputs),
      toolRecorders: agentBundle.tool_recorders,
      workloadId: stringValue(agentBundle.workload_id) || stringValue(agentBundle.agent_slug) || stringValue(agentBundle.flow_slug) || undefined,
    })
    const hasAgentBundle = Object.keys(agentBundle).length > 0
    const success = Boolean(run.success) && (!hasAgentBundle || workload.success)
    const output: AgentTaskRunOutput = {
      success,
      schema: "wp-codebox/agent-task-run/v1",
      status: success ? "completed" : "failed",
      session: sandboxSession(input, run, artifacts, success ? "completed" : "failed"),
      task,
      task_input: taskInput,
      wp: wpVersion,
      artifacts,
      agent_result: objectValue(run.agentResult) || objectValue(runRecord.agentResult) || objectValue(artifactsRecord.agentResult) || {},
      agent_task_result: objectValue(run.agentTaskResult) || objectValue(runRecord.agentTaskResult) || objectValue(artifactsRecord.agentTaskResult) || {},
      completion_outcome: objectValue(run.completionOutcome) || objectValue(artifactsRecord.completionOutcome) || {},
      run,
      diagnostics: [...diagnostics(run, capture.exitCode), ...(hasAgentBundle ? workload.diagnostics.map((diagnostic) => ({ ...diagnostic })) : [])],
      evidence_refs: evidenceRefs(run, artifacts),
      run_metadata: stripUndefined({
        run_id: stringValue(runRecord.runId),
        run_status: stringValue(runRecord.status),
        runtime_id: stringValue(runtimeRecord.id),
        runtime_status: stringValue(runtimeRecord.status),
        sandbox_session_id: stringValue(input.sandbox_session_id),
        orchestrator: input.orchestrator,
        parent_request_schema: stringValue(input.parent_request?.schema),
      }),
      metadata: {
        agent_runtime: {
          workload,
        },
      },
    }
    return output
  } finally {
    await rm(recipeDirectory, { recursive: true, force: true })
  }
}

export function buildAgentTaskRecipe(input: AgentTaskRunInput, taskInput: ReturnType<typeof normalizeTaskInput>, wpVersion: string): WorkspaceRecipe {
  const artifacts = stringValue(input.artifacts_path)
  const profile = runtimeOverlayProfileDefaults(input)
  const providerPlugins = uniqueStrings([...profile.providerPluginPaths, ...stringList(input.provider_plugin_paths)])
    .map((source) => ({ source: prepareComposerPluginSource(source, slugFromPath(source), artifacts), slug: slugFromPath(source), activate: false }))
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

  return stripUndefined({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: stripUndefined({
      backend: "wordpress-playground",
      wp: wpVersion,
      blueprint: { steps: [] },
      stack: Array.isArray(input.runtime_stack_mounts) && input.runtime_stack_mounts.length > 0 ? { mounts: input.runtime_stack_mounts } : undefined,
      overlays: runtimeOverlays(input, profile),
    }),
    inputs: stripUndefined({
      mounts: Array.isArray(input.mounts) ? input.mounts : [],
      workspaces: Array.isArray(input.workspaces) ? input.workspaces : [],
      extraPlugins: [
        componentPlugin(runtimeComponentPath(input, "agents_api", input.agents_api_path), "agents-api", artifacts),
        componentPlugin(runtimeComponentPath(input, "agent_runtime", input.data_machine_path), "data-machine", artifacts),
        componentPlugin(runtimeComponentPath(input, "agent_runtime_tools", input.data_machine_code_path), "data-machine-code", artifacts),
        ...providerPlugins,
      ].filter(Boolean),
      secretEnv: stringList(input.secret_env),
      agent_bundles: Array.isArray(input.agent_bundles) && input.agent_bundles.length > 0 ? input.agent_bundles : undefined,
    }),
    workflow: { steps: [{ command: "wp-codebox.agent-sandbox-run", args: workflowArgs }] },
  }) as WorkspaceRecipe
}

interface RuntimeOverlayProfileDefaults {
  providerPluginPaths: string[]
  runtimeOverlays: Array<Record<string, unknown>>
}

function runtimeOverlayProfileDefaults(input: AgentTaskRunInput): RuntimeOverlayProfileDefaults {
  const profiles = stringList(input.runtime_overlay_profiles)
  if (profiles.length === 0) return { providerPluginPaths: [], runtimeOverlays: [] }

  const defaults: RuntimeOverlayProfileDefaults = { providerPluginPaths: [], runtimeOverlays: [] }
  for (const profile of profiles) {
    if (profile === "codex-subscription") {
      defaults.providerPluginPaths.push(requiredProfilePath("codex-subscription", "WP_CODEBOX_CODEX_PROVIDER_PLUGIN_PATH", [
        "~/Developer/ai-provider-for-openai@codex-oauth-provider",
        "~/Developer/ai-provider-for-openai",
      ]))
      defaults.runtimeOverlays.push({
        kind: "bundled-library",
        library: "php-ai-client",
        source: requiredProfilePath("codex-subscription", "WP_CODEBOX_PHP_AI_CLIENT_PATH", [
          "~/Developer/php-ai-client@custom-provider-auth",
          "~/Developer/php-ai-client",
        ]),
        target: "/wordpress/wp-includes/php-ai-client",
        strategy: "wordpress-scoped-bundle",
        metadata: { profile, component: "php-ai-client", ref: "custom-provider-auth" },
      })
      continue
    }
    throw new Error(`Unknown runtime overlay profile: ${profile}`)
  }
  return defaults
}

function requiredProfilePath(profile: string, envName: string, candidates: string[]): string {
  const resolved = stringValue(process.env[envName]) || candidates.map(resolveProfilePathCandidate).find((candidate) => existsSync(candidate)) || ""
  if (!resolved) {
    throw new Error(`${profile} runtime overlay profile requires ${envName} or one of: ${candidates.join(", ")}`)
  }
  return resolved
}

function resolveProfilePathCandidate(candidate: string): string {
  return candidate.startsWith("~/") ? join(process.env.HOME || "", candidate.slice(2)) : candidate
}

function runtimeOverlays(input: AgentTaskRunInput, profile: RuntimeOverlayProfileDefaults): Array<Record<string, unknown>> | undefined {
  const overlays = [...profile.runtimeOverlays, ...(Array.isArray(input.runtime_overlays) ? input.runtime_overlays : [])]
  return overlays.length > 0 ? overlays : undefined
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function runtimeComponentPath(input: AgentTaskRunInput, key: string, fallback: unknown): unknown {
  const paths = input.runtime_component_paths
  return paths && typeof paths === "object" && !Array.isArray(paths) ? paths[key] || fallback : fallback
}

function parseAgentTaskRunOptions(args: string[]): AgentTaskRunOptions {
  let inputPath = ""
  let json = false
  let previewHoldSeconds = ""
  let previewPublicUrl = ""
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[index + 1]
    switch (name) {
      case "--input-file":
        inputPath = value ?? ""
        if (inlineValue === undefined) index += 1
        break
      case "--json":
        json = true
        break
      case "--format":
        json = value === "json"
        if (inlineValue === undefined) index += 1
        break
      case "--preview-hold-seconds":
        previewHoldSeconds = value ?? ""
        if (inlineValue === undefined) index += 1
        break
      case "--preview-public-url":
        previewPublicUrl = value ?? ""
        if (inlineValue === undefined) index += 1
        break
      default:
        throw new Error(`Unknown agent-task-run option: ${arg}`)
    }
  }
  if (!inputPath) {
    throw new Error("agent-task-run requires --input-file <path>")
  }
  return { inputPath, json, previewHoldSeconds, previewPublicUrl }
}

async function captureStdout<T>(callback: () => Promise<T>): Promise<{ result: T; stdout: string; exitCode: number }> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  ;(process.stdout.write as typeof process.stdout.write) = ((chunk: unknown, ...args: unknown[]) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    const result = await callback()
    return { result, stdout, exitCode: Number(result) || 0 }
  } finally {
    process.stdout.write = originalWrite
  }
}

function parseRecipeRunOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { success: false, error: { message: "WP Codebox recipe run returned no JSON output." } }
  }
  const parsed = JSON.parse(trimmed)
  return objectValue(parsed) || { success: false, error: { message: "WP Codebox recipe run returned a non-object JSON value." } }
}

function sandboxSession(input: AgentTaskRunInput, run: Record<string, unknown>, artifacts: string, status: "completed" | "failed"): Record<string, unknown> {
  const artifactsRecord = objectValue(run.artifacts) || {}
  const runtimeRecord = objectValue(run.runtime) || {}
  const runtimePreview = objectValue(runtimeRecord.preview) || {}
  return stripUndefined({
    schema: "wp-codebox/sandbox-session/v1",
    id: stringValue(input.sandbox_session_id) || stringValue(input.orchestrator?.agent_task_id),
    status,
    artifacts: stripUndefined({
      directory: artifacts,
      bundle_id: stringValue(artifactsRecord.id) || stringValue(artifactsRecord.bundle_id) || stringValue(artifactsRecord.bundleId),
      preview_url: stringValue(runtimePreview.url) || stringValue(artifactsRecord.preview_url) || stringValue(artifactsRecord.previewUrl),
    }),
    orchestrator: input.orchestrator,
  })
}

function diagnostics(run: Record<string, unknown>, exitCode: number): Array<Record<string, unknown>> {
  const existing = Array.isArray(run.diagnostics) ? run.diagnostics.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  if (existing.length > 0) {
    return existing
  }
  if (run.success === true) {
    return []
  }
  const errorRecord = objectValue(run.error) || {}
  return [{ class: "wp-codebox.agent_task_run_failed", message: stringValue(errorRecord.message) || "WP Codebox agent task run failed.", data: { exit_code: exitCode } }]
}

function evidenceRefs(run: Record<string, unknown>, artifacts: string): Array<Record<string, unknown>> {
  const artifactsRecord = objectValue(run.artifacts) || {}
  const refs: Array<Record<string, unknown> | null> = [
    { kind: "codebox-artifacts", uri: artifacts, label: "WP Codebox artifacts" },
    stringValue(artifactsRecord.manifestPath) ? { kind: "codebox-manifest", uri: stringValue(artifactsRecord.manifestPath), label: "WP Codebox artifact manifest" } : null,
    stringValue(artifactsRecord.reviewPath) ? { kind: "codebox-review", uri: stringValue(artifactsRecord.reviewPath), label: "WP Codebox review payload" } : null,
    stringValue(artifactsRecord.patchPath) ? { kind: "codebox-patch", uri: stringValue(artifactsRecord.patchPath), label: "WP Codebox patch" } : null,
  ]
  return refs.filter((entry): entry is Record<string, unknown> => Boolean(entry))
}

function componentPlugin(source: unknown, slug: string, artifactsRoot: string): { source: string; slug: string; activate: boolean; loadAs: "mu-plugin" } | undefined {
  const path = stringValue(source)
  return path ? { source: prepareComposerPluginSource(path, slug, artifactsRoot), slug, activate: false, loadAs: "mu-plugin" } : undefined
}

function prepareComposerPluginSource(source: string, slug: string, artifactsRoot: string): string {
  if (!source || !pathExists(join(source, "composer.json")) || pathExists(join(source, "vendor", "autoload.php"))) {
    return source
  }
  if (!artifactsRoot) {
    throw new Error(`Plugin ${slug} requires Composer dependencies but no artifacts directory is available for staging.`)
  }

  const preparedRoot = join(artifactsRoot, "prepared-plugins")
  const preparedSource = join(preparedRoot, slug)
  rmSyncSafe(preparedSource)
  mkdirSyncSafe(preparedRoot)
  cpSyncFiltered(source, preparedSource)
  const result = spawnSync("composer", ["install", "--no-interaction", "--prefer-dist", "--no-progress"], {
    cwd: preparedSource,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    throw new Error(`Composer install failed for plugin ${slug}: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
  if (!pathExists(join(preparedSource, "vendor", "autoload.php"))) {
    throw new Error(`Composer install for plugin ${slug} did not create vendor/autoload.php.`)
  }
  return preparedSource
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

function sandboxToolPolicy(input: AgentTaskRunInput, taskInput: ReturnType<typeof normalizeTaskInput>): SandboxToolPolicySnapshot {
  const policy = objectValue(input.sandbox_tool_policy) || objectValue(taskInput.sandbox_tool_policy)
  if (policy) {
    return policy as unknown as SandboxToolPolicySnapshot
  }
  return {
    schema: "wp-codebox/sandbox-tool-policy/v1",
    version: 1,
    tools: [{ id: "deny-all", runtime_tool_id: "deny-all", execution_location: "parent", transport_visibility: "hidden", allowed: false }],
    metadata: { source: "wp-codebox.agent-task-run.default-deny" },
  }
}

function slugFromPath(source: string): string {
  const base = source.replace(/\/$/, "").split("/").pop() || "provider"
  return base.replace(/[^A-Za-z0-9_-]/g, "-")
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.map((entry) => stringValue(entry)).filter(Boolean))) : []
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = objectValue(value)
  if (!record) return undefined
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => typeof entry === "string")) as Record<string, string>
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
