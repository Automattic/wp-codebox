/**
 * Explicit agent-runtime failure for the agent-task workflow result.
 *
 * When the native agent runtime exits non-zero or reports `success !== true`,
 * the workflow result must carry a stage/code/message explaining why. Without
 * this projection a failed runtime surfaced as `success: false` with no
 * `failure` object at all (the raw runtime result is not part of the uploaded
 * reviewer projection), so a failed run carried no reason.
 *
 * Kept free of side effects so it is unit-testable without running the
 * executor entrypoint.
 */

const MAX_DIAGNOSTICS = 5
const MAX_TEXT = 2048

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function text(value, limit = MAX_TEXT) {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)} [TRUNCATED]` : trimmed
}

function diagnosticList(...sources) {
  const seen = new Set()
  const diagnostics = []
  for (const source of sources) {
    for (const entry of Array.isArray(source) ? source : []) {
      const diagnostic = record(entry)
      const code = text(diagnostic.code, 256)
      const message = text(diagnostic.message)
      if (!code && !message) continue
      const key = `${code}\u0000${message}`
      if (seen.has(key)) continue
      seen.add(key)
      diagnostics.push(Object.fromEntries(Object.entries({ code: code || undefined, message: message || undefined, severity: text(diagnostic.severity, 32) || undefined }).filter(([, item]) => item !== undefined)))
    }
  }
  // Errors first so the headline names the actual cause, not a warning.
  return diagnostics.sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"))
}

/**
 * Projects why the agent runtime did not succeed. Returns undefined when the
 * runtime exited zero and reported success.
 */
export function agentRuntimeFailure({ execution, runtimeResult, bound = (value) => text(value, 8192) }) {
  const exitCode = Number.isSafeInteger(execution?.code) ? execution.code : undefined
  const runtime = record(runtimeResult)
  if (exitCode === 0 && runtime.success === true) return undefined

  const summary = record(runtime.agent_task_run_result)
  const terminal = record(runtime.terminal_result ?? summary.terminal_result)
  const providerError = record(record(summary.metadata).provider_error)
  const diagnostics = diagnosticList(runtime.diagnostics, summary.diagnostics, terminal.diagnostics)
  const status = text(summary.status, 64) || text(runtime.status, 64)
  const terminalStatus = text(terminal.status, 64)
  const classification = text(summary.failure_classification, 64)
    || text(terminal.failure_classification, 64)
    || (Object.keys(providerError).length ? "provider_error" : "")
    || "agent_runtime"
  const headline = diagnostics[0]
  const stderrTail = bound(typeof execution?.stderr === "string" ? execution.stderr : "")
  const stdoutTail = bound(typeof execution?.stdout === "string" ? execution.stdout : "")
  const code = headline?.code
    || (terminalStatus && terminalStatus !== "succeeded" ? `agent_${terminalStatus}` : "")
    || (status && status !== "succeeded" ? `agent_${status}` : "")
    || (exitCode !== undefined && exitCode !== 0 ? "agent_runtime_exit" : "agent_runtime_failed")
  const providerMessage = text(providerError.message)
  const message = headline?.message
    || providerMessage
    || (exitCode !== undefined && exitCode !== 0
      ? `The agent runtime exited with code ${exitCode}${status ? ` (status: ${status})` : ""}.${stderrTail ? ` stderr: ${text(stderrTail, 512)}` : ""}`
      : `The agent runtime did not report success${status ? ` (status: ${status})` : ""}.`)

  return Object.fromEntries(Object.entries({
    stage: "agent",
    code,
    classification,
    message,
    exit_code: exitCode,
    runtime_status: status || undefined,
    terminal_status: terminalStatus || undefined,
    diagnostics: diagnostics.length ? diagnostics.slice(0, MAX_DIAGNOSTICS) : undefined,
    provider_error: providerMessage ? { message: providerMessage, ...(text(providerError.code, 128) ? { code: text(providerError.code, 128) } : {}) } : undefined,
    stdout_tail: exitCode !== 0 && stdoutTail ? stdoutTail : undefined,
    stderr_tail: exitCode !== 0 && stderrTail ? stderrTail : undefined,
  }).filter(([, item]) => item !== undefined))
}
