import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { normalizeRootedPath, pathIsWithinRoot, relativePathIsWithinRoot } from "./file-tree-policy.js"
import { performanceObservation, type PerformanceObservation } from "./performance-observation.js"
import { runtimeEpisodeDigest } from "./runtime-episode.js"
import type { RuntimePolicy } from "./runtime-policy.js"
import type { MountSpec, RuntimeCommandDiagnosticsCaptureSpec, RuntimeEpisode, RuntimeEpisodeContentDigest, RuntimeEpisodeStepResult, RuntimeEpisodeTraceRef } from "./runtime-contracts.js"

export const RUNTIME_ACTION_OBSERVATION_SCHEMA = "wp-codebox/runtime-action-observation/v1" as const

export const SANDBOX_WORKSPACE_ROOT = "/workspace"

export type RuntimeAction = RuntimeWpCliAction | RuntimePhpAction | RuntimeRestRequestAction | RuntimeFilesystemAction | RuntimeBrowserAction | RuntimeBrowserProbeAction | RuntimeEditorOpenAction | RuntimeAdminPageAction | RuntimePageAction | RuntimeWordPressPluginSetupAction | RuntimeWordPressPluginStateAction | RuntimeWordPressThemeSetupAction

export interface RuntimeWpCliAction {
  type: "wp_cli"
  command: string
  timeout_ms?: number
}

export interface RuntimePhpAction {
  type: "php"
  code: string
  bootstrap?: "wordpress" | "none"
  diagnostics?: RuntimeCommandDiagnosticsCaptureSpec
  timeout_ms?: number
}

export interface RuntimeRestRequestAction {
  type: "rest_request"
  method?: string
  path: string
  headers?: Record<string, unknown>
  params?: Record<string, unknown>
  body?: string
  body_json?: unknown
  timeout_ms?: number
}

export interface RuntimeFilesystemAction {
  type: "filesystem"
  operation: "list" | "read" | "write" | "delete"
  path: string
  content?: string
}

export interface RuntimeBrowserAction {
  type: "browser"
  operation: "navigate" | "click" | "fill" | "press" | "wait" | "capture"
  url?: string
  selector?: string
  text?: string
  value?: string
  key?: string
  wait_for?: string
  duration?: string
  capture?: string[]
  timeout_ms?: number
}

export interface RuntimeBrowserProbeAction {
  type: "browser_probe"
  url: string
  wait_for?: string
  duration?: string
  capture?: string[]
  viewport?: string
  timeout_ms?: number
}

export interface RuntimeEditorOpenAction {
  type: "editor_open"
  target?: "post-new" | "site"
  post_id?: number
  post_type?: string
  url?: string
  wait_selector?: string
  capture?: string[]
  timeout_ms?: number
}

export interface RuntimeAdminPageAction {
  type: "admin_page"
  path: string
  wait_for?: string
  capture?: string[]
  timeout_ms?: number
}

export interface RuntimePageAction {
  type: "page"
  path: string
  wait_for?: string
  capture?: string[]
  timeout_ms?: number
}

export interface RuntimeWordPressPluginSetupAction {
  type: "wordpress_plugin_setup"
  action?: "install" | "list"
  plugin?: string
  slug?: string
  activate?: boolean
  network?: boolean
  timeout_ms?: number
}

export interface RuntimeWordPressPluginStateAction {
  type: "wordpress_plugin_state"
  action?: "report" | "status" | "activate" | "deactivate"
  plugin?: string
  slug?: string
  file?: string
  path?: string
  network?: boolean
  timeout_ms?: number
}

export interface RuntimeWordPressThemeSetupAction {
  type: "wordpress_theme_setup"
  action?: "install" | "switch" | "list"
  theme?: string
  slug?: string
  activate?: boolean
  timeout_ms?: number
}

export interface RuntimeActionAdapterPolicy {
  mounts?: MountSpec[]
  writableRoots?: string[]
  filesystem?: RuntimePolicy["filesystem"]
  filesystemTraceCommand?: string | false
}

export interface RuntimeActionObservation {
  schema: typeof RUNTIME_ACTION_OBSERVATION_SCHEMA
  type: RuntimeAction["type"]
  status: "ok"
  action: RuntimeAction
  data: Record<string, unknown>
  observedAt: string
  step?: RuntimeEpisodeStepResult
  performance?: PerformanceObservation
  artifactRefs?: RuntimeEpisodeTraceRef[]
  digest: RuntimeEpisodeContentDigest
}

export class RuntimeActionPolicyError extends Error {
  readonly code = "runtime-action-policy-violation" as const

  constructor(message: string, readonly action: RuntimeAction) {
    super(message)
    this.name = "RuntimeActionPolicyError"
  }
}

export async function runRuntimeAction(
  episode: RuntimeEpisode,
  action: RuntimeAction,
  policy: RuntimeActionAdapterPolicy = {},
): Promise<RuntimeActionObservation> {
  if (action.type === "wp_cli") {
    return runRuntimeWpCliAction(episode, action)
  }

  if (action.type === "php") {
    return runRuntimePhpAction(episode, action)
  }

  if (action.type === "rest_request") {
    return runRuntimeRestRequestAction(episode, action)
  }

  if (action.type === "browser") {
    return runRuntimeBrowserAction(episode, action)
  }

  if (action.type === "browser_probe") {
    return runRuntimeBrowserProbeAction(episode, action)
  }

  if (action.type === "editor_open") {
    return runRuntimeEditorOpenAction(episode, action)
  }

  if (action.type === "admin_page") {
    return runRuntimeAdminPageAction(episode, action)
  }

  if (action.type === "page") {
    return runRuntimePageAction(episode, action)
  }

  if (action.type === "wordpress_plugin_setup") {
    return runRuntimeMappedCommandAction(episode, action, "wordpress.plugin-setup")
  }

  if (action.type === "wordpress_plugin_state") {
    return runRuntimeMappedCommandAction(episode, action, "wordpress.plugin-state")
  }

  if (action.type === "wordpress_theme_setup") {
    return runRuntimeMappedCommandAction(episode, action, "wordpress.theme-setup")
  }

  return runRuntimeFilesystemAction(episode, action, policy)
}

async function runRuntimePhpAction(episode: RuntimeEpisode, action: RuntimePhpAction): Promise<RuntimeActionObservation> {
  const args = [`code=${action.code}`]
  if (action.bootstrap) {
    args.push(`bootstrap=${action.bootstrap}`)
  }

  const diagnostics = action.diagnostics ?? { capture: ["wpdb-queries"] as const }
  const step = await episode.step(
    {
      kind: "command",
      command: "wordpress.run-php",
      args,
      diagnostics,
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    },
    { type: "command-result" },
  )

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout: step.execution.stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

async function runRuntimeWpCliAction(episode: RuntimeEpisode, action: RuntimeWpCliAction): Promise<RuntimeActionObservation> {
  const step = await episode.step(
    {
      kind: "command",
      command: "wordpress.wp-cli",
      args: [`command=${normalizeWpCliRuntimeActionCommand(action.command)}`],
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    },
    { type: "command-result" },
  )

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      command: action.command,
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout: step.execution.stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

async function runRuntimeMappedCommandAction(episode: RuntimeEpisode, action: RuntimeWordPressPluginSetupAction | RuntimeWordPressPluginStateAction | RuntimeWordPressThemeSetupAction, command: string): Promise<RuntimeActionObservation> {
  const step = await episode.step(
    {
      kind: "command",
      command,
      args: actionArgs(action),
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    },
    { type: "command-result" },
  )

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout: step.execution.stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

function actionArgs(action: object): string[] {
  return Object.entries(action).flatMap(([key, value]) => {
    if (value === undefined || key === "type" || key === "timeout_ms") {
      return []
    }
    return [`${key.replace(/_/g, "-")}=${String(value)}`]
  })
}

async function runRuntimeRestRequestAction(episode: RuntimeEpisode, action: RuntimeRestRequestAction): Promise<RuntimeActionObservation> {
  const args = [`path=${action.path}`]
  if (action.method) {
    args.push(`method=${action.method}`)
  }
  if (action.headers) {
    args.push(`headers-json=${JSON.stringify(action.headers)}`)
  }
  if (action.params) {
    args.push(`params-json=${JSON.stringify(action.params)}`)
  }
  if (action.body_json !== undefined) {
    args.push(`body-json=${JSON.stringify(action.body_json)}`)
  } else if (action.body !== undefined) {
    args.push(`body=${action.body}`)
  }

  const step = await episode.step(
    {
      kind: "http",
      command: "wordpress.rest-request",
      args,
      method: action.method ?? "GET",
      path: action.path,
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    },
    { type: "command-result" },
  )

  let stdout: unknown = step.execution.stdout
  try {
    stdout = JSON.parse(step.execution.stdout)
  } catch {
    // Keep raw stdout when a backend returns non-JSON diagnostics.
  }
  const normalized = normalizeRuntimeRestRequestResult(action, step, stdout)

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: normalized,
    artifactRefs: step.observation?.artifactRefs,
  })
}

function normalizeRuntimeRestRequestResult(
  action: RuntimeRestRequestAction,
  step: RuntimeEpisodeStepResult,
  stdout: unknown,
): Record<string, unknown> {
  const response = stdout && typeof stdout === "object" && !Array.isArray(stdout) ? stdout as Record<string, unknown> : {}
  const startedAt = Date.parse(step.execution.startedAt)
  const finishedAt = Date.parse(step.execution.finishedAt)
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? Math.max(0, finishedAt - startedAt) : undefined
  const method = stringValue(response.method) ?? action.method ?? "GET"
  const path = stringValue(response.path) ?? action.path
  const route = stringValue(response.route) ?? path
  const headers = recordValue(response.headers) ?? {}
  const body = response.body ?? response.data ?? null
  const diagnostics = {
    exitCode: step.execution.exitCode,
    stderr: step.execution.stderr,
    ...(recordValue(response.diagnostics) ?? {}),
  }

  return {
    method,
    path,
    route,
    status: typeof response.status === "number" ? response.status : undefined,
    headers,
    body,
    timing: {
      startedAt: step.execution.startedAt,
      finishedAt: step.execution.finishedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(recordValue(response.timing) ?? {}),
    },
    diagnostics,
    mappedCommand: step.execution.command,
    args: step.execution.args,
    stdout,
    stderr: step.execution.stderr,
    executionId: step.execution.id,
    stepId: step.id,
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function runRuntimeFilesystemAction(
  episode: RuntimeEpisode,
  action: RuntimeFilesystemAction,
  policy: RuntimeActionAdapterPolicy,
): Promise<RuntimeActionObservation> {
  const mountedPath = await resolveRuntimeActionMountedPath(action, policy)
  const data = await executeRuntimeFilesystemAction(action, mountedPath)
  const traceCommand = policy.filesystemTraceCommand ?? "inspect-mounted-inputs"
  const step = traceCommand
    ? await episode.step(
        {
          kind: "filesystem",
          command: traceCommand,
          path: mountedPath.sandboxPath,
          operation: action.operation,
          description: `filesystem.${action.operation}`,
          metadata: {
            mountTarget: mountedPath.mount.target,
            mountMode: mountedPath.mount.mode,
          },
        },
        { type: "mounts" },
      )
    : undefined

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      operation: action.operation,
      path: mountedPath.sandboxPath,
      mountTarget: mountedPath.mount.target,
      mountMode: mountedPath.mount.mode,
      ...data,
    },
    artifactRefs: step?.observation?.artifactRefs,
  })
}

async function runRuntimeBrowserAction(episode: RuntimeEpisode, action: RuntimeBrowserAction): Promise<RuntimeActionObservation> {
  const args = [`steps-json=${JSON.stringify([runtimeBrowserCommandStep(action)])}`]
  if (action.url && action.operation !== "navigate") {
    args.unshift(`url=${action.url}`)
  }
  if (action.capture && action.capture.length > 0) {
    args.push(`capture=${action.capture.join(",")}`)
  }

  const step = await episode.step(
    {
      kind: "browser",
      command: "wordpress.browser-actions",
      args,
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.url ? { url: action.url } : {}),
      operation: action.operation,
    },
    { type: "browser-result" },
  )

  let stdout: unknown = step.execution.stdout
  try {
    stdout = JSON.parse(step.execution.stdout)
  } catch {
    // Keep raw stdout when a backend returns non-JSON diagnostics.
  }

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      operation: action.operation,
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

function runtimeBrowserCommandStep(action: RuntimeBrowserAction): Record<string, unknown> {
  const commandAction: Record<string, unknown> = { kind: action.operation === "wait" ? "waitFor" : action.operation }
  for (const key of ["url", "selector", "text", "value", "key", "duration"] as const) {
    if (typeof action[key] === "string") {
      commandAction[key] = action[key]
    }
  }
  if (typeof action.wait_for === "string") {
    commandAction.waitFor = action.wait_for
  }
  if (action.operation === "capture" && Array.isArray(action.capture)) {
    commandAction.capture = action.capture
  }
  return commandAction
}

async function runRuntimeBrowserProbeAction(episode: RuntimeEpisode, action: RuntimeBrowserProbeAction): Promise<RuntimeActionObservation> {
  const args = [`url=${action.url}`]
  if (action.wait_for) {
    args.push(`wait-for=${action.wait_for}`)
  }
  if (action.duration) {
    args.push(`duration=${action.duration}`)
  }
  if (action.capture && action.capture.length > 0) {
    args.push(`capture=${action.capture.join(",")}`)
  }
  if (action.viewport) {
    args.push(`viewport=${action.viewport}`)
  }

  const step = await episode.step(
    {
      kind: "browser",
      command: "wordpress.browser-probe",
      args,
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
      url: action.url,
      operation: "probe",
    },
    { type: "browser-result" },
  )

  let stdout: unknown = step.execution.stdout
  try {
    stdout = JSON.parse(step.execution.stdout)
  } catch {
    // Keep raw stdout when a backend returns non-JSON diagnostics.
  }

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

async function runRuntimeEditorOpenAction(episode: RuntimeEpisode, action: RuntimeEditorOpenAction): Promise<RuntimeActionObservation> {
  const args = runtimeEditorOpenArgs(action)
  const step = await episode.step(
    {
      kind: "browser",
      command: "wordpress.editor-open",
      args,
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
      ...(action.url ? { url: action.url } : {}),
      ...(action.target ? { target: action.target } : {}),
      operation: "editor_open",
    },
    { type: "browser-result" },
  )

  let stdout: unknown = step.execution.stdout
  try {
    stdout = JSON.parse(step.execution.stdout)
  } catch {
    // Keep raw stdout when a backend returns non-JSON diagnostics.
  }
  const summary = recordValue(stdout)

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
      diagnostics: {
        exitCode: step.execution.exitCode,
        stderr: step.execution.stderr,
      },
      ...(summary?.target ? { target: summary.target } : {}),
      ...(summary?.finalUrl ? { finalUrl: summary.finalUrl } : {}),
      ...(summary?.files ? { files: summary.files } : {}),
      ...(summary?.summary ? { summary: summary.summary } : {}),
      ...(summary?.steps ? { steps: summary.steps } : {}),
      artifactRefs: step.observation?.artifactRefs ?? [],
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

async function runRuntimeAdminPageAction(episode: RuntimeEpisode, action: RuntimeAdminPageAction): Promise<RuntimeActionObservation> {
  const path = action.path.startsWith("/wp-admin/") ? action.path : `/wp-admin/${action.path.replace(/^\/+/, "")}`
  const observation = await runRuntimeBrowserProbeAction(episode, {
    type: "browser_probe",
    url: path,
    wait_for: action.wait_for,
    capture: action.capture,
    timeout_ms: action.timeout_ms,
  })
  return runtimeActionObservation({
    type: action.type,
    action,
    step: observation.step,
    data: { ...observation.data, path },
    artifactRefs: observation.artifactRefs,
  })
}

async function runRuntimePageAction(episode: RuntimeEpisode, action: RuntimePageAction): Promise<RuntimeActionObservation> {
  const observation = await runRuntimeBrowserProbeAction(episode, {
    type: "browser_probe",
    url: action.path,
    wait_for: action.wait_for,
    capture: action.capture,
    timeout_ms: action.timeout_ms,
  })
  return runtimeActionObservation({
    type: action.type,
    action,
    step: observation.step,
    data: { ...observation.data, path: action.path },
    artifactRefs: observation.artifactRefs,
  })
}

function runtimeEditorOpenArgs(action: RuntimeEditorOpenAction): string[] {
  const args: string[] = []
  if (action.target) {
    args.push(`target=${action.target}`)
  }
  if (action.post_id !== undefined) {
    args.push(`post-id=${action.post_id}`)
  }
  if (action.post_type) {
    args.push(`post-type=${action.post_type}`)
  }
  if (action.url) {
    args.push(`url=${action.url}`)
  }
  if (action.wait_selector) {
    args.push(`wait-selector=${action.wait_selector}`)
  }
  if (action.timeout_ms !== undefined) {
    args.push(`wait-timeout=${action.timeout_ms}ms`)
  }
  if (action.capture && action.capture.length > 0) {
    args.push(`capture=${action.capture.join(",")}`)
  }
  return args
}

function normalizeWpCliRuntimeActionCommand(command: string): string {
  const trimmed = command.trim()
  return trimmed.startsWith("wp ") ? trimmed.slice(3).trimStart() : trimmed
}

interface RuntimeActionMountedPath {
  mount: MountSpec
  sandboxPath: string
  hostPath: string
}

async function resolveRuntimeActionMountedPath(
  action: RuntimeFilesystemAction,
  policy: RuntimeActionAdapterPolicy,
): Promise<RuntimeActionMountedPath> {
  if (!action.path || action.path.includes("\0")) {
    throw new RuntimeActionPolicyError("Filesystem action path must be a non-empty path without null bytes", action)
  }

  const mounts = policy.mounts ?? []
  const sandboxPath = normalizeSandboxRuntimeActionPath(action.path)
  const mount = mounts.find((candidate) => isRuntimeActionPathWithinRoot(sandboxPath, candidate.target))
  if (!mount) {
    throw new RuntimeActionPolicyError(`Filesystem action path is outside mounted workspace roots: ${action.path}`, action)
  }

  const hostPath = resolve(mount.source, relative(normalizeSandboxRuntimeActionPath(mount.target), sandboxPath))
  await assertRuntimeActionHostPathWithinMount(action, hostPath, mount.source)

  if (action.operation === "write" || action.operation === "delete") {
    assertRuntimeFilesystemWritable(action, sandboxPath, mount, policy)
  }

  return { mount, sandboxPath, hostPath }
}

function normalizeSandboxRuntimeActionPath(path: string): string {
  return normalizeRootedPath(path, SANDBOX_WORKSPACE_ROOT)
}

function isRuntimeActionPathWithinRoot(path: string, root: string): boolean {
  return relativePathIsWithinRoot(normalizeSandboxRuntimeActionPath(path), normalizeSandboxRuntimeActionPath(root))
}

async function assertRuntimeActionHostPathWithinMount(action: RuntimeFilesystemAction, hostPath: string, source: string): Promise<void> {
  const root = await realpath(source)
  const existingPath = action.operation === "write" ? dirname(hostPath) : hostPath
  let real
  try {
    real = await realpath(existingPath)
  } catch (error) {
    if (action.operation !== "write") {
      throw error
    }
    real = await nearestExistingRuntimeActionParent(existingPath, root)
  }
  if (!pathIsWithinRoot(real, root)) {
    throw new RuntimeActionPolicyError(`Filesystem action path resolves outside mounted workspace root: ${action.path}`, action)
  }
}

async function nearestExistingRuntimeActionParent(path: string, root: string): Promise<string> {
  let current = path
  while (current !== dirname(current)) {
    try {
      return await realpath(current)
    } catch {
      current = dirname(current)
      if (!current.startsWith(root)) {
        return root
      }
    }
  }

  return root
}

function assertRuntimeFilesystemWritable(
  action: RuntimeFilesystemAction,
  sandboxPath: string,
  mount: MountSpec,
  policy: RuntimeActionAdapterPolicy,
): void {
  if (policy.filesystem && policy.filesystem !== "readwrite-mounts") {
    throw new RuntimeActionPolicyError(`Filesystem action requires readwrite-mounts policy: ${action.operation}`, action)
  }
  if (mount.mode !== "readwrite") {
    throw new RuntimeActionPolicyError(`Filesystem action requires a readwrite mount: ${mount.target}`, action)
  }

  const writableRoots = policy.writableRoots ?? [mount.target]
  if (!writableRoots.some((root) => isRuntimeActionPathWithinRoot(sandboxPath, root))) {
    throw new RuntimeActionPolicyError(`Filesystem action path is outside writable roots: ${action.path}`, action)
  }
}

async function executeRuntimeFilesystemAction(
  action: RuntimeFilesystemAction,
  mountedPath: RuntimeActionMountedPath,
): Promise<Record<string, unknown>> {
  if (action.operation === "list") {
    const entries = await readdir(mountedPath.hostPath, { withFileTypes: true })
    return {
      entries: entries
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  if (action.operation === "read") {
    const content = await readFile(mountedPath.hostPath, "utf8")
    return { content, bytes: Buffer.byteLength(content, "utf8") }
  }

  if (action.operation === "write") {
    await mkdir(dirname(mountedPath.hostPath), { recursive: true })
    await writeFile(mountedPath.hostPath, action.content ?? "")
    return { bytes: Buffer.byteLength(action.content ?? "", "utf8") }
  }

  await rm(mountedPath.hostPath, { recursive: true, force: true })
  return { deleted: true }
}

function runtimeActionObservation(input: {
  type: RuntimeAction["type"]
  action: RuntimeAction
  data: Record<string, unknown>
  step?: RuntimeEpisodeStepResult
  artifactRefs?: RuntimeEpisodeTraceRef[]
}): RuntimeActionObservation {
  const observedAt = new Date().toISOString()
  const performance = normalizeRuntimeActionPerformanceObservation(input)
  const observation = {
    schema: RUNTIME_ACTION_OBSERVATION_SCHEMA,
    type: input.type,
    status: "ok" as const,
    action: input.action,
    data: input.data,
    observedAt,
    performance,
    ...(input.step ? { step: input.step } : {}),
    ...(input.artifactRefs && input.artifactRefs.length > 0 ? { artifactRefs: input.artifactRefs } : {}),
  }

  return {
    ...observation,
    digest: runtimeEpisodeDigest(observation),
  }
}

function normalizeRuntimeActionPerformanceObservation(input: {
  action: RuntimeAction
  data: Record<string, unknown>
  step?: RuntimeEpisodeStepResult
  artifactRefs?: RuntimeEpisodeTraceRef[]
}): PerformanceObservation {
  const diagnostics = recordValue(input.step?.execution.diagnostics)
  const explicit = recordValue(input.data.performance) ?? recordValue(diagnostics?.performance)
  const startedAt = input.step?.execution.startedAt
  const finishedAt = input.step?.execution.finishedAt
  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : undefined
  const timing = recordValue(explicit?.timing) ?? recordValue(input.data.timing)
  const browser = normalizeRuntimeActionBrowserPerformance(input.data)
  return performanceObservation({
    command: input.step?.execution.command,
    target: runtimeActionTarget(input.action),
    timing: {
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...timing,
    },
    memory: recordValue(explicit?.memory) as PerformanceObservation["memory"],
    database: recordValue(explicit?.database) as PerformanceObservation["database"],
    hooks: recordValue(explicit?.hooks) as PerformanceObservation["hooks"],
    network: recordValue(explicit?.network) as PerformanceObservation["network"],
    browser: recordValue(explicit?.browser) ?? browser,
    ...(input.artifactRefs && input.artifactRefs.length > 0 ? { artifactRefs: input.artifactRefs } : {}),
    metadata: {
      actionType: input.action.type,
      ...(input.step ? { stepId: input.step.id, executionId: input.step.execution.id } : {}),
    },
  })
}

function normalizeRuntimeActionBrowserPerformance(data: Record<string, unknown>): PerformanceObservation["browser"] | undefined {
  const stdout = recordValue(data.stdout)
  const summary = recordValue(stdout?.summary) ?? recordValue(data.summary)
  const files = recordValue(stdout?.files) ?? recordValue(data.files)
  if (!summary && !files) {
    return undefined
  }
  return {
    metrics: recordValue(summary?.metrics) as Record<string, number> | undefined,
    admin: {
      ...(summary ?? {}),
      ...(files ? { files } : {}),
    },
  }
}

function runtimeActionTarget(action: RuntimeAction): string | undefined {
  if ("path" in action) return action.path
  if ("url" in action) return action.url
  if ("command" in action) return action.command
  if (action.type === "php") return action.bootstrap ?? "php"
  return action.type
}
