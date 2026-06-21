import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { executeHostCommand, resolveAllowedHostCommandCwd, type HostCommandExecutorResult } from "./host-command-executor.js"
import type { JsonObject, JsonValue } from "./host-tool-registry.js"
import { normalizeRuntimeEnvRecord } from "./runtime-env.js"
import { normalizeCommandEnvelopeStatus, type CommandEnvelopeStatus } from "./status-taxonomy.js"

export const PHP_WORKER_RUN_SCHEMA = "wp-codebox/php-worker-run/v1" as const

export interface PhpWorkerRunnerConfig {
  phpBinary?: string
  cwd: string
  allowedCwdRoots?: string[]
  artifactsDirectory: string
  timeoutMs?: number
  maxOutputBytes?: number
  inheritedEnv?: string[]
  env?: Record<string, string>
}

export interface PhpWorkerRunRequest {
  workerFile: string
  input?: JsonValue
  inputArtifact?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface PhpWorkerRunResult {
  schema: typeof PHP_WORKER_RUN_SCHEMA
  command: "wordpress.php-worker"
  status: CommandEnvelopeStatus
  worker: {
    file: string
    basename: string
  }
  exitCode: number
  stdout: string
  stderr: string
  json?: JsonValue
  artifacts: {
    input: string
    result: string
  }
  diagnostics: {
    durationMs: number
    output: {
      stdoutBytes: number
      stderrBytes: number
      parsedJson: boolean
    }
    environment: {
      envNames: string[]
    }
    error?: {
      code: string
      message: string
      failureClassification: "timeout" | "non_zero_exit" | "invalid_json"
    }
  }
}

export async function runPhpWorker(config: PhpWorkerRunnerConfig, request: PhpWorkerRunRequest): Promise<PhpWorkerRunResult> {
  if (!request.workerFile.trim()) {
    throw new Error("wordpress.php-worker requires workerFile")
  }

  await mkdir(config.artifactsDirectory, { recursive: true })
  const workerFile = await resolveAllowedHostCommandCwd({ cwd: resolve(request.workerFile), allowedCwdRoots: config.allowedCwdRoots ?? [config.cwd] })
  const inputArtifact = resolveArtifactPath(config.artifactsDirectory, request.inputArtifact ?? "php-worker-input.json")
  const resultArtifact = resolveArtifactPath(config.artifactsDirectory, "php-worker-result.json")
  const input = request.input ?? null
  await writeFile(inputArtifact, `${JSON.stringify(input, null, 2)}\n`, "utf8")

  const env = phpWorkerEnv(config, request, inputArtifact, resultArtifact)
  const execution = await executeHostCommand({
    command: config.phpBinary ?? process.env.PHP_BINARY ?? "php",
    args: [workerFile],
    cwd: config.cwd,
    allowedCwdRoots: config.allowedCwdRoots,
    timeoutMs: request.timeoutMs ?? config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    inheritedEnv: config.inheritedEnv,
    env,
  })

  return createPhpWorkerRunResult({ request, execution, inputArtifact, resultArtifact })
}

function resolveArtifactPath(artifactsDirectory: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) {
    throw new Error("wordpress.php-worker artifact paths must be relative")
  }
  const root = resolve(artifactsDirectory)
  const path = resolve(root, artifactPath)
  const rel = relative(root, path)
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error("wordpress.php-worker artifact path escapes artifact directory")
  }
  return path
}

export interface CreatePhpWorkerRunResultInput {
  request: PhpWorkerRunRequest
  execution: HostCommandExecutorResult
  inputArtifact: string
  resultArtifact: string
}

export async function createPhpWorkerRunResult(input: CreatePhpWorkerRunResultInput): Promise<PhpWorkerRunResult> {
  const jsonResult = await readPhpWorkerJson(input.resultArtifact, input.execution.stdout)
  const failure = phpWorkerFailure(input.execution, jsonResult.error)

  return {
    schema: PHP_WORKER_RUN_SCHEMA,
    command: "wordpress.php-worker",
    status: normalizeCommandEnvelopeStatus({ success: !failure, exitStatus: input.execution.exitCode, timeout: input.execution.timedOut }),
    worker: {
      file: resolve(input.request.workerFile),
      basename: basename(input.request.workerFile),
    },
    exitCode: input.execution.exitCode,
    stdout: input.execution.stdout,
    stderr: input.execution.stderr,
    ...(jsonResult.json !== undefined ? { json: jsonResult.json } : {}),
    artifacts: {
      input: input.inputArtifact,
      result: input.resultArtifact,
    },
    diagnostics: {
      durationMs: input.execution.durationMs,
      output: {
        stdoutBytes: Buffer.byteLength(input.execution.stdout),
        stderrBytes: Buffer.byteLength(input.execution.stderr),
        parsedJson: jsonResult.json !== undefined,
      },
      environment: {
        envNames: Object.keys(input.request.env ?? {}).sort(),
      },
      ...(failure ? { error: failure } : {}),
    },
  }
}

export function phpWorkerResultJson(result: PhpWorkerRunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}

function phpWorkerEnv(config: PhpWorkerRunnerConfig, request: PhpWorkerRunRequest, inputArtifact: string, resultArtifact: string): Record<string, string> {
  return normalizeRuntimeEnvRecord({
    ...(config.env ?? {}),
    ...(request.env ?? {}),
    WP_CODEBOX_PHP_WORKER_INPUT_PATH: inputArtifact,
    WP_CODEBOX_PHP_WORKER_RESULT_PATH: resultArtifact,
    WP_CODEBOX_PHP_WORKER_INPUT_JSON: JSON.stringify(request.input ?? null),
  }, { field: "wordpress.php-worker env" })
}

async function readPhpWorkerJson(resultArtifact: string, stdout: string): Promise<{ json?: JsonValue; error?: string }> {
  const raw = await readFile(resultArtifact, "utf8").catch(() => stdout)
  const trimmed = raw.trim()
  if (!trimmed) {
    return { error: "wordpress.php-worker requires JSON in result artifact or stdout" }
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isJsonValue(parsed)) {
      return { error: "wordpress.php-worker result must be JSON-compatible" }
    }
    return { json: parsed }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `wordpress.php-worker result must be valid JSON: ${message}` }
  }
}

function phpWorkerFailure(execution: HostCommandExecutorResult, invalidJsonMessage?: string): PhpWorkerRunResult["diagnostics"]["error"] | undefined {
  if (execution.timedOut) {
    return { code: "php-worker-timeout", message: "PHP worker timed out.", failureClassification: "timeout" }
  }
  if (execution.exitCode !== 0) {
    return { code: "php-worker-non-zero-exit", message: `PHP worker exited with status ${execution.exitCode}.`, failureClassification: "non_zero_exit" }
  }
  if (invalidJsonMessage) {
    return { code: "php-worker-invalid-json", message: invalidJsonMessage, failureClassification: "invalid_json" }
  }
  return undefined
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }
  if (typeof value === "object") {
    return Object.values(value as JsonObject).every(isJsonValue)
  }
  return false
}
