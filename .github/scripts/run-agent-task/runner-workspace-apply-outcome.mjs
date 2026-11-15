/**
 * Explicit runner-workspace apply outcome for the agent-task workflow result.
 *
 * Kept free of side effects so the projection is unit-testable without running
 * the executor entrypoint.
 */

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

const WORKSPACE_MUTATION_TOOLS = new Set(["workspace_write", "workspace_edit", "workspace_apply_patch"])
const MAX_APPLY_OUTCOME_PATHS = 100

/** Finds the content-free sandbox workspace mutation ledger in the runtime result. */
export function sandboxWorkspaceMutations(value) {
  let found
  const visit = (entry, depth) => {
    if (found || depth > 10) return
    if (Array.isArray(entry)) return entry.forEach((item) => visit(item, depth + 1))
    const item = record(entry)
    if (item.schema === "wp-codebox/sandbox-workspace-mutations/v1" && Array.isArray(item.calls)) {
      found = item
      return
    }
    Object.values(item).forEach((child) => visit(child, depth + 1))
  }
  visit(value, 0)
  return found
}

function workspaceToolBase(name) {
  const value = typeof name === "string" ? name : ""
  return value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value
}

/**
 * Projects the explicit runner-workspace apply outcome recorded in the workflow
 * result: which paths reached the host workspace, which were rejected and why,
 * and whether successful sandbox writes produced no host change at all.
 */
export function runnerWorkspaceApplyOutcome({ workspaceApply, applyError, attempted, mutations, toolObservability, bound = (value) => value.slice(0, 8192) }) {
  const ledgerCalls = Array.isArray(record(mutations).calls) ? record(mutations).calls.map(record).filter((call) => WORKSPACE_MUTATION_TOOLS.has(call.tool)) : []
  const observedCalls = Array.isArray(record(toolObservability).calls) ? record(toolObservability).calls.map(record).filter((call) => WORKSPACE_MUTATION_TOOLS.has(workspaceToolBase(call.tool_name))) : []
  const source = ledgerCalls.length || mutations ? "sandbox-ledger" : observedCalls.length ? "tool-observability" : "none"
  const calls = source === "sandbox-ledger"
    ? ledgerCalls.map((call) => ({ tool: call.tool, status: call.status, paths: Array.isArray(call.paths) ? call.paths.filter((path) => typeof path === "string") : [], ...(typeof call.error_type === "string" ? { error_type: call.error_type } : {}) }))
    : observedCalls.map((call) => ({ tool: workspaceToolBase(call.tool_name), status: call.status, paths: [] }))
  const succeeded = calls.filter((call) => call.status === "succeeded")
  const writePaths = [...new Set(succeeded.flatMap((call) => call.paths))].slice(0, MAX_APPLY_OUTCOME_PATHS)
  const writeToolCalls = {
    source,
    attempted: calls.length,
    succeeded: succeeded.length,
    failed: calls.length - succeeded.length,
    paths: writePaths,
    ...(calls.some((call) => call.status !== "succeeded") ? { failures: calls.filter((call) => call.status !== "succeeded").slice(0, MAX_APPLY_OUTCOME_PATHS).map((call) => ({ tool: call.tool, paths: call.paths, error_type: call.error_type || "tool_call_failed" })) } : {}),
    ...(Number.isSafeInteger(record(mutations).dropped) && record(mutations).dropped > 0 ? { dropped: record(mutations).dropped } : {}),
  }
  const appliedPaths = workspaceApply?.status === "applied" && Array.isArray(workspaceApply.changedFiles) ? workspaceApply.changedFiles.slice(0, MAX_APPLY_OUTCOME_PATHS) : []
  const rejectedPaths = Array.isArray(applyError?.rejectedPaths) ? applyError.rejectedPaths.slice(0, MAX_APPLY_OUTCOME_PATHS) : []
  const unappliedPaths = writePaths.filter((path) => !appliedPaths.includes(path) && !rejectedPaths.some((rejected) => rejected.path === path))
  let status
  let message
  if (applyError) {
    status = rejectedPaths.length ? "rejected" : "failed"
    message = bound(applyError instanceof Error ? applyError.message : String(applyError))
  } else if (!attempted) {
    status = "skipped"
    message = "Runner workspace apply did not run because the agent runtime did not succeed."
  } else if (workspaceApply?.status === "applied") {
    status = "applied"
    message = `Applied ${appliedPaths.length} changed path(s) to the runner workspace.`
  } else if (succeeded.length > 0) {
    status = "writes-not-applied"
    message = `The agent made ${succeeded.length} successful workspace write call(s)${writePaths.length ? ` (${writePaths.slice(0, 5).join(", ")}${writePaths.length > 5 ? ", ..." : ""})` : ""} but the canonical sandbox patch declared no changes, so nothing reached the runner workspace.`
  } else {
    status = "no-op"
    message = calls.length ? "Every workspace write call failed; no changes were applied." : "The agent made no workspace write calls; no changes were applied."
  }
  return {
    schema: "wp-codebox/runner-workspace-apply-outcome/v1",
    status,
    message,
    applied_paths: appliedPaths,
    rejected_paths: rejectedPaths,
    ...(status !== "applied" && unappliedPaths.length ? { unapplied_paths: unappliedPaths } : {}),
    ...(Number.isSafeInteger(workspaceApply?.declaredChanges) ? { declared_changes: workspaceApply.declaredChanges } : {}),
    write_tool_calls: writeToolCalls,
  }
}
