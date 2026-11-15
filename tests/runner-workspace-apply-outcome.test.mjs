import assert from "node:assert/strict"

import { runnerWorkspaceApplyOutcome, sandboxWorkspaceMutations } from "../.github/scripts/run-agent-task/runner-workspace-apply-outcome.mjs"

const ledger = (calls, dropped = 0) => ({ schema: "wp-codebox/sandbox-workspace-mutations/v1", calls, dropped })

// The ledger is discovered wherever the runtime nests the agent result metadata.
{
  const mutations = ledger([{ tool: "workspace_write", status: "succeeded", paths: ["docs/a.md"] }])
  const runtime = { agent_task_result: { raw: { agent_runtime: { result: { metadata: { sandbox_workspace_mutations: mutations } } } } } }
  assert.deepEqual(sandboxWorkspaceMutations(runtime), mutations)
  assert.equal(sandboxWorkspaceMutations({ metadata: {} }), undefined)
}

// Applied: every applied path is listed.
{
  const outcome = runnerWorkspaceApplyOutcome({
    workspaceApply: { status: "applied", changedFiles: ["plugins/x/docs/user/a.md"], declaredChanges: 1 },
    attempted: true,
    mutations: ledger([{ tool: "workspace_write", status: "succeeded", paths: ["plugins/x/docs/user/a.md"] }]),
  })
  assert.equal(outcome.schema, "wp-codebox/runner-workspace-apply-outcome/v1")
  assert.equal(outcome.status, "applied")
  assert.deepEqual(outcome.applied_paths, ["plugins/x/docs/user/a.md"])
  assert.deepEqual(outcome.rejected_paths, [])
  assert.equal(outcome.declared_changes, 1)
  assert.equal(outcome.unapplied_paths, undefined)
  assert.deepEqual(outcome.write_tool_calls, { source: "sandbox-ledger", attempted: 1, succeeded: 1, failed: 0, paths: ["plugins/x/docs/user/a.md"] })
}

// Issue #2567: successful sandbox writes with a no-op apply are surfaced, never a silent no_changes.
{
  const outcome = runnerWorkspaceApplyOutcome({
    workspaceApply: { status: "no-op", changedFiles: [], declaredChanges: 0 },
    attempted: true,
    mutations: ledger([
      { tool: "workspace_write", status: "succeeded", paths: ["plugins/x/docs/user/a.md"] },
      { tool: "workspace_edit", status: "succeeded", paths: ["plugins/x/docs/user/b.md"] },
      { tool: "workspace_read", status: "succeeded", paths: ["README.md"] },
    ]),
  })
  assert.equal(outcome.status, "writes-not-applied")
  assert.match(outcome.message, /2 successful workspace write call\(s\) \(plugins\/x\/docs\/user\/a\.md, plugins\/x\/docs\/user\/b\.md\)/)
  assert.deepEqual(outcome.unapplied_paths, ["plugins/x/docs/user/a.md", "plugins/x/docs/user/b.md"])
  assert.deepEqual(outcome.applied_paths, [])
  assert.equal(outcome.write_tool_calls.attempted, 2, "read tools are not write calls")
}

// Without the ledger, Agents API tool observability still detects write calls.
{
  const outcome = runnerWorkspaceApplyOutcome({
    workspaceApply: { status: "no-op", changedFiles: [] },
    attempted: true,
    toolObservability: { version: 1, calls: [{ tool_name: "client/workspace_apply_patch", status: "succeeded" }, { tool_name: "client/workspace_read", status: "succeeded" }] },
  })
  assert.equal(outcome.status, "writes-not-applied")
  assert.equal(outcome.write_tool_calls.source, "tool-observability")
  assert.equal(outcome.write_tool_calls.succeeded, 1)
}

// Rejected writes report each path and its reason.
{
  const error = Object.assign(new Error("Changed file is outside writable_paths: README.md (2 paths rejected)"), {
    rejectedPaths: [{ path: "README.md", reason: "outside-writable-paths" }, { path: ".git/config", reason: "denied-path" }],
  })
  const outcome = runnerWorkspaceApplyOutcome({
    workspaceApply: { status: "no-op", changedFiles: [] },
    applyError: error,
    attempted: true,
    mutations: ledger([{ tool: "workspace_write", status: "succeeded", paths: ["README.md", "docs/a.md"] }]),
  })
  assert.equal(outcome.status, "rejected")
  assert.match(outcome.message, /outside writable_paths/)
  assert.deepEqual(outcome.rejected_paths, error.rejectedPaths)
  assert.deepEqual(outcome.unapplied_paths, ["docs/a.md"])
}

// Failed write calls and a genuine no-op stay distinguishable.
{
  const failed = runnerWorkspaceApplyOutcome({
    workspaceApply: { status: "no-op", changedFiles: [] },
    attempted: true,
    mutations: ledger([{ tool: "workspace_write", status: "failed", paths: ["/etc/passwd"], error_type: "path_not_writable" }], 3),
  })
  assert.equal(failed.status, "no-op")
  assert.match(failed.message, /Every workspace write call failed/)
  assert.deepEqual(failed.write_tool_calls.failures, [{ tool: "workspace_write", paths: ["/etc/passwd"], error_type: "path_not_writable" }])
  assert.equal(failed.write_tool_calls.dropped, 3)

  const none = runnerWorkspaceApplyOutcome({ workspaceApply: { status: "no-op", changedFiles: [] }, attempted: true, mutations: ledger([]) })
  assert.equal(none.status, "no-op")
  assert.match(none.message, /no workspace write calls/)
  assert.equal(none.write_tool_calls.source, "sandbox-ledger")

  const skipped = runnerWorkspaceApplyOutcome({ workspaceApply: { status: "no-op", changedFiles: [] }, attempted: false })
  assert.equal(skipped.status, "skipped")
}

console.log("runner workspace apply outcome ok")
