import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { runtimeEpisodeDigest } from "./runtime-episode.js"
import type { RuntimePolicy } from "./runtime-policy.js"
import type { MountSpec, RuntimeEpisode, RuntimeEpisodeContentDigest, RuntimeEpisodeStepResult, RuntimeEpisodeTraceRef } from "./runtime-contracts.js"

export const RUNTIME_ACTION_OBSERVATION_SCHEMA = "wp-codebox/runtime-action-observation/v1" as const

export const SANDBOX_WORKSPACE_ROOT = "/workspace"

export type RuntimeAction = RuntimeWpCliAction | RuntimeRestRequestAction | RuntimeFilesystemAction | RuntimeBrowserAction

export interface RuntimeWpCliAction {
  type: "wp_cli"
  command: string
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

  if (action.type === "rest_request") {
    return runRuntimeRestRequestAction(episode, action)
  }

  if (action.type === "browser") {
    return runRuntimeBrowserAction(episode, action)
  }

  return runRuntimeFilesystemAction(episode, action, policy)
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

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      method: action.method ?? "GET",
      path: action.path,
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
  const args = [`actions-json=${JSON.stringify([runtimeBrowserCommandAction(action)])}`]
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

function runtimeBrowserCommandAction(action: RuntimeBrowserAction): Record<string, unknown> {
  const commandAction: Record<string, unknown> = { type: action.operation }
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
  const absolutePath = path.startsWith("/") ? path : join(SANDBOX_WORKSPACE_ROOT, path)
  const normalized = normalize(absolutePath)
  if (!normalized.startsWith("/")) {
    return `/${normalized}`
  }

  return normalized
}

function isRuntimeActionPathWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = normalizeSandboxRuntimeActionPath(root)
  const relativePath = relative(normalizedRoot, normalizeSandboxRuntimeActionPath(path))
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
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
  const relativePath = relative(root, real)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
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
  const observation = {
    schema: RUNTIME_ACTION_OBSERVATION_SCHEMA,
    type: input.type,
    status: "ok" as const,
    action: input.action,
    data: input.data,
    observedAt,
    ...(input.step ? { step: input.step } : {}),
    ...(input.artifactRefs && input.artifactRefs.length > 0 ? { artifactRefs: input.artifactRefs } : {}),
  }

  return {
    ...observation,
    digest: runtimeEpisodeDigest(observation),
  }
}
