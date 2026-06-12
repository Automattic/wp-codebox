import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { spawnSync } from "node:child_process"
import { DEFAULT_WORDPRESS_VERSION, normalizeAgentRuntimeWorkload, normalizeTaskInput, stripUndefined, type SandboxToolPolicySnapshot, type StructuredArtifactPayload, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { runRecipeRunCommand } from "./recipe-run.js"

export interface AgentTaskRunOptions {
  inputPath: string
  json: boolean
  previewHoldSeconds: string
  previewPublicUrl: string
}

export interface AgentTaskRunInput {
  goal?: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  provider_plugin_paths?: string[]
  runtime_overlay_profiles?: string[]
  secret_env?: string[]
  mounts?: NonNullable<WorkspaceRecipe["inputs"]>["mounts"]
  workspaces?: NonNullable<WorkspaceRecipe["inputs"]>["workspaces"]
  dependency_overlays?: NonNullable<WorkspaceRecipe["inputs"]>["dependency_overlays"]
  runtime_stack_mounts?: Array<Record<string, unknown>>
  runtime_overlays?: Array<Record<string, unknown>>
  agent_bundles?: Array<Record<string, unknown>>
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
  structured_artifacts: Array<Record<string, unknown>>
  run: Record<string, unknown>
  diagnostics: Array<Record<string, unknown>>
  evidence_refs: Array<Record<string, unknown>>
  failure_evidence?: Record<string, unknown>
  run_metadata: Record<string, unknown>
  metadata: Record<string, unknown>
}

interface CapturedOutput<T> {
  result: T
  stdout: string
  stderr: string
  exitCode: number
}

interface FailureEvidenceInput {
  input: AgentTaskRunInput
  task: string
  wpVersion: string
  artifacts: string
  recipePath: string
  run: Record<string, unknown>
  capture?: CapturedOutput<unknown>
  error?: unknown
}

const FAILURE_SNIPPET_CHARS = 4000

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
  let capture: CapturedOutput<number> | undefined

  try {
    const recipe = buildAgentTaskRecipe(input, taskInput, wpVersion)
    await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`)
    const recipeRunArgs = ["--recipe", recipePath, "--artifacts", artifacts, "--json"]
    if (options.previewHoldSeconds) {
      recipeRunArgs.push("--preview-hold-seconds", options.previewHoldSeconds)
    }
    if (options.previewPublicUrl) {
      recipeRunArgs.push("--preview-public-url", options.previewPublicUrl)
    }
    capture = await captureOutput(() => runRecipeRunCommand(recipeRunArgs))
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
    const agentTaskResult = objectValue(run.agentTaskResult) || objectValue(runRecord.agentTaskResult) || objectValue(artifactsRecord.agentTaskResult) || {}
    const failureEvidence = success ? undefined : buildFailureEvidence({ input, task, wpVersion, artifacts, recipePath, run, capture })
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
      agent_task_result: agentTaskResult,
      completion_outcome: objectValue(run.completionOutcome) || objectValue(artifactsRecord.completionOutcome) || {},
      structured_artifacts: structuredArtifactRefs(agentTaskResult),
      run,
      diagnostics: [...diagnostics(run, success ? 0 : capture.exitCode, success, failureEvidence), ...(hasAgentBundle ? workload.diagnostics.map((diagnostic) => ({ ...diagnostic })) : [])],
      evidence_refs: evidenceRefs(run, artifacts, failureEvidence),
      failure_evidence: failureEvidence,
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
  } catch (error) {
    const run = { success: false, error: serializeUnknownError(error) }
    const failureEvidence = buildFailureEvidence({ input, task, wpVersion, artifacts, recipePath, run, capture, error })
    const failureDiagnostics = diagnostics(run, capture?.exitCode ?? 1, false, failureEvidence)
    return {
      success: false,
      schema: "wp-codebox/agent-task-run/v1",
      status: "failed",
      session: sandboxSession(input, run, artifacts, "failed"),
      task,
      task_input: taskInput,
      wp: wpVersion,
      artifacts,
      agent_result: {},
      agent_task_result: {},
      completion_outcome: {},
      structured_artifacts: [],
      run,
      diagnostics: failureDiagnostics,
      evidence_refs: evidenceRefs(run, artifacts, failureEvidence),
      failure_evidence: failureEvidence,
      run_metadata: stripUndefined({
        sandbox_session_id: stringValue(input.sandbox_session_id),
        orchestrator: input.orchestrator,
        parent_request_schema: stringValue(input.parent_request?.schema),
      }),
      metadata: {
        agent_runtime: {
          workload: {
            success: false,
            diagnostics: failureDiagnostics,
          },
        },
      },
    }
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
  if (taskInput.structured_artifacts.length > 0) {
    workflowArgs.push(`structured-artifacts-json=${JSON.stringify(taskInput.structured_artifacts)}`)
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
      dependency_overlays: Array.isArray(input.dependency_overlays) ? input.dependency_overlays : undefined,
      extra_plugins: [
        ...componentPlugins(input.component_contracts, artifacts),
        ...providerPlugins,
      ].filter(Boolean),
      secretEnv: stringList(input.secret_env),
      agent_bundles: Array.isArray(input.agent_bundles) && input.agent_bundles.length > 0 ? input.agent_bundles : undefined,
    }),
    workflow: stripUndefined({
      steps: [{ command: "wp-codebox.agent-sandbox-run", args: workflowArgs }],
      // Post-agent verification gate: these run after the agent finishes editing
      // (e.g. `wordpress.phpunit` / `wordpress.run-php` smoke gates). A non-zero
      // exit in any after-phase step fails the whole run, so the orchestrator
      // cannot report success until the supplied gates are green.
      after: Array.isArray(input.verify_steps) && input.verify_steps.length > 0 ? input.verify_steps : undefined,
    }),
  }) as WorkspaceRecipe
}

interface RuntimeOverlayProfileDefaults {
  providerPluginPaths: string[]
  runtimeOverlays: Array<Record<string, unknown>>
}

const CODEX_SUBSCRIPTION_PROFILE = "codex-subscription"
const CODEX_PROVIDER_PLUGIN_ENV = "WP_CODEBOX_CODEX_PROVIDER_PLUGIN_PATH"
const CODEX_PHP_AI_CLIENT_ENV = "WP_CODEBOX_PHP_AI_CLIENT_PATH"

function runtimeOverlayProfileDefaults(input: AgentTaskRunInput): RuntimeOverlayProfileDefaults {
  const profiles = stringList(input.runtime_overlay_profiles)
  if (profiles.length === 0) return { providerPluginPaths: [], runtimeOverlays: [] }

  const defaults: RuntimeOverlayProfileDefaults = { providerPluginPaths: [], runtimeOverlays: [] }
  for (const profile of profiles) {
    if (profile === CODEX_SUBSCRIPTION_PROFILE) {
      defaults.providerPluginPaths.push(requiredProfilePath(CODEX_SUBSCRIPTION_PROFILE, CODEX_PROVIDER_PLUGIN_ENV, [
        "~/Developer/ai-provider-for-openai@codex-oauth-provider",
        "~/Developer/ai-provider-for-openai",
      ], hasComposerPackage))
      defaults.runtimeOverlays.push({
        kind: "bundled-library",
        library: "php-ai-client",
        source: requiredProfilePath(CODEX_SUBSCRIPTION_PROFILE, CODEX_PHP_AI_CLIENT_ENV, [
          "~/Developer/php-ai-client@custom-provider-auth",
          "~/Developer/php-ai-client",
        ], hasInstalledComposerPackage),
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

function requiredProfilePath(profile: string, envName: string, candidates: string[], isUsablePath: (path: string) => boolean = existsSync): string {
  const explicit = stringValue(process.env[envName])
  const resolved = explicit || candidates.map(resolveProfilePathCandidate).find((candidate) => isUsablePath(candidate)) || ""
  if (!resolved) {
    throw new Error(`${profile} runtime overlay profile requires ${envName} or one of: ${candidates.join(", ")}`)
  }
  if (!isUsablePath(resolved)) {
    throw new Error(`${profile} runtime overlay profile path from ${envName} is not prepared: ${resolved}`)
  }
  return resolved
}

function resolveProfilePathCandidate(candidate: string): string {
  return candidate.startsWith("~/") ? join(process.env.HOME || "", candidate.slice(2)) : candidate
}

function hasComposerPackage(candidate: string): boolean {
  return existsSync(join(candidate, "composer.json"))
}

function hasInstalledComposerPackage(candidate: string): boolean {
  return hasComposerPackage(candidate) && existsSync(join(candidate, "vendor"))
}

function runtimeOverlays(input: AgentTaskRunInput, profile: RuntimeOverlayProfileDefaults): Array<Record<string, unknown>> | undefined {
  const overlays = [...profile.runtimeOverlays, ...(Array.isArray(input.runtime_overlays) ? input.runtime_overlays : [])]
  return overlays.length > 0 ? overlays : undefined
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
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

async function captureOutput<T>(callback: () => Promise<T>): Promise<CapturedOutput<T>> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  const originalErrorWrite = process.stderr.write.bind(process.stderr)
  let stdout = ""
  let stderr = ""
  ;(process.stdout.write as typeof process.stdout.write) = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString()
    callWriteCallback(encodingOrCallback, callback)
    return true
  }) as typeof process.stdout.write
  ;(process.stderr.write as typeof process.stderr.write) = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString()
    callWriteCallback(encodingOrCallback, callback)
    return true
  }) as typeof process.stderr.write
  try {
    const result = await callback()
    return { result, stdout, stderr, exitCode: Number(result) || 0 }
  } finally {
    process.stdout.write = originalWrite
    process.stderr.write = originalErrorWrite
  }
}

function callWriteCallback(encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): void {
  if (typeof encodingOrCallback === "function") {
    encodingOrCallback()
  } else if (callback) {
    callback()
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

function diagnostics(run: Record<string, unknown>, exitCode: number, normalizedSuccess = false, failureEvidence?: Record<string, unknown>): Array<Record<string, unknown>> {
  const existing = Array.isArray(run.diagnostics) ? run.diagnostics.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  if (normalizedSuccess) {
    return existing.filter((entry) => stringValue(entry.class) !== "wp-codebox.agent_task_run_failed")
  }
  if (existing.length > 0) {
    return existing
  }
  if (run.success === true) {
    return []
  }
  const errorRecord = objectValue(run.error) || {}
  return [{
    class: "wp-codebox.agent_task_run_failed",
    message: stringValue(errorRecord.message) || "WP Codebox agent task run failed.",
    data: stripUndefined({
      exit_code: exitCode,
      phase: stringValue(failureEvidence?.phase),
      command: stringValue(failureEvidence?.command),
      failure_evidence: failureEvidence,
    }),
  }]
}

function evidenceRefs(run: Record<string, unknown>, artifacts: string, failureEvidence?: Record<string, unknown>): Array<Record<string, unknown>> {
  const artifactsRecord = objectValue(run.artifacts) || {}
  const refs: Array<Record<string, unknown> | null> = [
    { kind: "codebox-artifacts", uri: artifacts, label: "WP Codebox artifacts" },
    stringValue(artifactsRecord.manifestPath) ? { kind: "codebox-manifest", uri: stringValue(artifactsRecord.manifestPath), label: "WP Codebox artifact manifest" } : null,
    stringValue(artifactsRecord.reviewPath) ? { kind: "codebox-review", uri: stringValue(artifactsRecord.reviewPath), label: "WP Codebox review payload" } : null,
    stringValue(artifactsRecord.patchPath) ? { kind: "codebox-patch", uri: stringValue(artifactsRecord.patchPath), label: "WP Codebox patch" } : null,
    failureEvidence ? { kind: "codebox-agent-task-failure-evidence", uri: artifacts, label: "WP Codebox agent task failure evidence", metadata: failureEvidenceSummary(failureEvidence) } : null,
  ]
  return refs.filter((entry): entry is Record<string, unknown> => Boolean(entry))
}

function buildFailureEvidence(values: FailureEvidenceInput): Record<string, unknown> {
  const runRecord = objectValue(values.run.run) || {}
  const runtimeRecord = objectValue(values.run.runtime) || objectValue(runRecord.runtime) || {}
  const artifactsRecord = objectValue(values.run.artifacts) || {}
  const execution = failedExecution(values.run)
  const phase = failedPhase(values.run)
  const errorRecord = objectValue(values.run.error) || serializeUnknownError(values.error)
  const stdout = stringValue(execution?.stdout) || values.capture?.stdout || ""
  const stderr = stringValue(execution?.stderr) || values.capture?.stderr || ""
  const recipeRunEvidence = stripUndefined({
    schema: stringValue(values.run.schema) || undefined,
    recipe_path: values.recipePath,
    status: stringValue(runRecord.status) || stringValue(values.run.status) || undefined,
    run_id: stringValue(runRecord.runId) || undefined,
  })
  const runtimeEvidence = nonEmptyObject(stripUndefined({
    id: stringValue(runtimeRecord.id) || undefined,
    status: stringValue(runtimeRecord.status) || undefined,
  }))

  return stripUndefined({
    schema: "wp-codebox/agent-task-run-failure-evidence/v1",
    phase: stringValue(execution?.recipePhase) || stringValue(phase?.name) || "agent-task-run",
    command: stringValue(execution?.recipeCommand) || stringValue(execution?.command) || "wp-codebox recipe-run --json",
    exit_code: numberValue(execution?.exitCode) ?? values.capture?.exitCode ?? 1,
    message: stringValue(errorRecord.message) || "WP Codebox agent task run failed.",
    task: values.task,
    recipe_run: recipeRunEvidence,
    runtime: runtimeEvidence,
    sandbox: stripUndefined({
      sandbox_session_id: stringValue(values.input.sandbox_session_id) || undefined,
      orchestrator: values.input.orchestrator,
      artifacts_directory: values.artifacts,
      artifact_bundle_id: stringValue(artifactsRecord.id) || stringValue(artifactsRecord.bundle_id) || stringValue(artifactsRecord.bundleId) || undefined,
    }),
    stdout: outputSnippet(stdout),
    stderr: outputSnippet(stderr),
    diagnostics: Array.isArray(values.run.diagnostics) ? values.run.diagnostics.filter((entry) => Boolean(objectValue(entry))) : undefined,
    phase_evidence: Array.isArray(values.run.phaseEvidence) ? values.run.phaseEvidence.filter((entry) => Boolean(objectValue(entry))) : undefined,
    error: Object.keys(errorRecord).length > 0 ? errorRecord : undefined,
    wp: values.wpVersion,
  })
}

function failedExecution(run: Record<string, unknown>): Record<string, unknown> | undefined {
  const executions = Array.isArray(run.executions) ? run.executions.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  return [...executions].reverse().find((execution) => numberValue(execution.exitCode) !== undefined && numberValue(execution.exitCode) !== 0)
}

function failedPhase(run: Record<string, unknown>): Record<string, unknown> | undefined {
  const phases = Array.isArray(run.phaseEvidence) ? run.phaseEvidence.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  return [...phases].reverse().find((phase) => stringValue(phase.status) === "failed")
}

function outputSnippet(value: string): Record<string, unknown> | undefined {
  if (!value) return undefined
  const truncated = value.length > FAILURE_SNIPPET_CHARS
  const snippet = truncated ? value.slice(-FAILURE_SNIPPET_CHARS) : value
  return { bytes: Buffer.byteLength(value), truncated, value: snippet }
}

function failureEvidenceSummary(failureEvidence: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    schema: stringValue(failureEvidence.schema) || undefined,
    phase: stringValue(failureEvidence.phase) || undefined,
    command: stringValue(failureEvidence.command) || undefined,
    exit_code: numberValue(failureEvidence.exit_code),
    runtime: nonEmptyObject(objectValue(failureEvidence.runtime)),
    sandbox: nonEmptyObject(objectValue(failureEvidence.sandbox)),
  })
}

function structuredArtifactRefs(agentTaskResult: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = Array.isArray(agentTaskResult.structured_artifacts) ? agentTaskResult.structured_artifacts : []
  if (direct.length > 0) {
    return direct.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry)))
  }
  const outputs = objectValue(agentTaskResult.outputs) || {}
  const fromOutputs = Array.isArray(outputs.structured_artifacts) ? outputs.structured_artifacts : []
  return fromOutputs.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry)))
}

function componentPlugins(contracts: Array<Record<string, unknown>> | undefined, artifactsRoot: string): Array<{ source: string; slug: string; activate: boolean; loadAs: string }> {
  if (!Array.isArray(contracts)) return []
  return contracts.flatMap((contract) => {
    const slug = slugFromPath(stringValue(contract.slug || contract.component || contract.name))
    const source = stringValue(contract.path || contract.source)
    if (!slug || !source) return []
    return [{
      source: prepareComposerPluginSource(source, slug, artifactsRoot),
      slug,
      activate: Boolean(contract.activate),
      loadAs: stringValue(contract.loadAs) || "mu-plugin",
    }]
  })
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
    tools: [{ id: "deny-all", runtime_tool_id: "deny-all", execution_location: "parent", transport_visibility: "hidden", allowed: false, runtime: { environment: "control_plane", capability_scope: "control_plane" } }],
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

function nonEmptyObject(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function serializeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return stripUndefined({ name: error.name, message: error.message, stack: error.stack })
  }
  return { message: stringValue(error) || "Unknown WP Codebox agent task run failure." }
}
