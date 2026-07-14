import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"

export const MAX_NATIVE_RESULT_BYTES = 1024 * 1024
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "no_op", "timeout", "provider_error", "unable_to_remediate"])

export function nativeResultFailure(code, message) {
  return { success: false, diagnostics: [{ code, message }] }
}

export async function readNativeResult(path, controlledDirectory, secretValues, redact) {
  const resolvedPath = resolve(path)
  const resolvedDirectory = resolve(controlledDirectory)
  if (!resolvedPath.startsWith(`${resolvedDirectory}/`)) {
    return nativeResultFailure("wp-codebox.agent-task.result-path", "Native agent-task result path is outside the controlled .codebox directory.")
  }
  try {
    const info = await lstat(resolvedPath)
    if (!info.isFile() || info.isSymbolicLink()) {
      return nativeResultFailure("wp-codebox.agent-task.result-file", "Native agent-task result file must be a regular non-symlink file.")
    }
    if (info.size > MAX_NATIVE_RESULT_BYTES) {
      return nativeResultFailure("wp-codebox.agent-task.result-too-large", `Native agent-task result exceeds the ${MAX_NATIVE_RESULT_BYTES}-byte limit.`)
    }
    const contents = await readFile(resolvedPath, "utf8")
    if (Buffer.byteLength(contents) !== info.size) {
      return nativeResultFailure("wp-codebox.agent-task.result-file", "Native agent-task result changed while it was being read.")
    }
    if (secretValues.some((secret) => contents.includes(secret))) {
      return nativeResultFailure("wp-codebox.agent-task.result-secret", "Native agent-task result contains a configured secret.")
    }
    const result = JSON.parse(contents)
    const taskResult = record(result)
    const summary = record(taskResult.agent_task_run_result)
    if (taskResult.schema !== "wp-codebox/agent-task-run/v1" || typeof taskResult.success !== "boolean" || !TERMINAL_STATUSES.has(taskResult.status) || summary.schema !== "wp-codebox/agent-task-run-result/v1" || typeof summary.success !== "boolean" || !TERMINAL_STATUSES.has(summary.status) || taskResult.success !== summary.success || taskResult.status !== summary.status) {
      return nativeResultFailure("wp-codebox.agent-task.result-schema", "Native agent-task result did not match the required result schema.")
    }
    return redact(taskResult)
  } catch (error) {
    const code = error && typeof error === "object" && error.code === "ENOENT" ? "wp-codebox.agent-task.result-missing" : "wp-codebox.agent-task.result-malformed"
    return nativeResultFailure(code, code.endsWith("missing") ? "Native agent-task did not produce a result file." : "Native agent-task result file was malformed.")
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}
