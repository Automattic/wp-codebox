import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const root = resolve(".")
const executor = join(root, ".github/scripts/run-agent-task/execute-native-agent-task.mjs")
const uploader = join(root, ".github/scripts/run-agent-task/prepare-agent-task-upload.mjs")
const execFileAsync = promisify(execFile)

async function run(mode = "success") {
  const temp = await mkdtemp(join(tmpdir(), "wp-codebox-native-lifecycle-"))
  const workspace = join(temp, "workspace")
  await mkdir(join(workspace, ".codebox"), { recursive: true })
  await writeFile(join(workspace, "README.md"), "before\n")

  const request = {
    schema: "wp-codebox/agent-task-workflow-request/v1",
    model: { provider: "openai", name: "gpt-5" },
    external_package_source: {
      repository: "owner/agents",
      revision: "a".repeat(40),
      path: "agent.agent.json",
      digest: `sha256-bytes-v1:${"b".repeat(64)}`,
    },
    runtime_sources: [],
    workload: { id: "run-1", label: "Update" },
    target_repo: "owner/repo",
    prompt: "Edit README using workspace_read and workspace_edit.",
    writable_paths: mode === "deny" ? "src/**" : "README.md",
    runner_workspace: {
      enabled: true,
      repo: "owner/repo",
      base: "main",
      branch_prefix: "wp-codebox/agent-task/",
    },
    validation_dependencies: "echo validation >> .codebox/order",
    verification_commands: [
      { command: mode === "verify-fail" ? "false" : "echo verification >> .codebox/order" },
    ],
    drift_checks: [{ command: "echo drift >> .codebox/order" }],
    success: { requires_pr: mode !== "no-op-maintenance" },
    access: {
      caller_repo: "owner/repo",
      allowed_repos: ["owner/repo"],
      access_token_repos: ["owner/repo"],
    },
    limits: { max_turns: 1, time_budget_ms: 1000 },
    artifacts: { expected: [], declarations: [] },
    outputs: {
      projections: {
        pr_url: mode === "no-op-maintenance"
          ? { path: "metadata.runner_workspace_publication.pull_request.url", required: false }
          : "metadata.runner_workspace_publication.pull_request.url",
      },
    },
    callback_data: {},
    run_agent: true,
    dry_run: false,
  }
  await writeFile(join(workspace, ".codebox", "agent-task-request.json"), JSON.stringify(request))

  const fakeCli = join(temp, "fake-cli.mjs")
  const noOp = mode.startsWith("no-op")
  const mismatch = mode === "mismatch"
  const applyReject = mode === "apply-reject"
  await writeFile(fakeCli, `
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
const output = process.argv[process.argv.indexOf("--result-file") + 1]
const input = JSON.parse(await readFile(process.argv[process.argv.indexOf("--input-file") + 1], "utf8"))
const root = join(process.cwd(), ".codebox", "agent-task-artifacts", "files")
await mkdir(root, { recursive: true })
const patch = ${JSON.stringify(noOp ? "" : applyReject ? "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-not-before\n+after\n" : "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n")}
await writeFile(join(root, "patch.diff"), patch)
await writeFile(join(root, "changed-files.json"), JSON.stringify({
  schema: "wp-codebox/changed-files/v1",
  files: ${noOp} ? [] : [{ path: "/workspace/README.md", relativePath: "README.md", status: "modified", beforeMode: "100644", afterMode: "100644" }],
}))
${mismatch ? "await writeFile(join(process.cwd(), \"README.md\"), \"diverged\\n\")" : ""}
await writeFile(join(process.cwd(), ".codebox", "order"), "runtime\\n")
const summary = {
  schema: "wp-codebox/agent-task-run-result/v1",
  success: true,
  status: "succeeded",
  refs: {
    patches: [{ kind: "codebox-patch", path: join(root, "patch.diff") }],
    changed_files: [{ kind: "codebox-changed-files", path: join(root, "changed-files.json") }],
  },
}
const result = {
  schema: "wp-codebox/agent-task-run/v1",
  success: true,
  status: "succeeded",
  agent_task_run_result: summary,
  agent_result: {
    artifacts: { directory: root },
    changedFiles: { artifact: "changed-files.json", bytes: ${noOp} ? 0 : 1 },
    patch: { artifact: "patch.diff", bytes: ${noOp} ? 0 : 1 },
  },
  metadata: { imported_agent: { slug: "fixture-agent" }, tool_contract: { tools: ["workspace_read", "workspace_edit"] } },
  agent_runtime_diagnostics: { prepared_paths: { workspaces: input.task_input.workspaces.map((workspace) => ({ target: workspace.target, mode: workspace.mode, metadata: { baselineSource: "fixture-baseline", workspaceRoot: "/workspace", sourceMode: workspace.sourceMode } })) }, sandbox_workspace: { mounts: input.task_input.workspaces.map((workspace) => ({ target: workspace.target })) }, local_executor_root: "/workspace" },
}
await writeFile(output, JSON.stringify(result))
`)

  const publisher = join(temp, "publisher.mjs")
  const publisherOrderPath = join(workspace, ".codebox", "order")
  await writeFile(publisher, `
import { appendFile } from "node:fs/promises"
export async function publishRunnerWorkspace({ testHook }) {
  await appendFile(testHook.orderPath, "publish\\n")
  return {
    schema: "wp-codebox/runner-workspace-publication-result/v1",
    success: true,
    status: "published",
    backend: "fixture",
    pull_request: { url: "https://github.com/owner/repo/pull/1", reused: false, opened: true },
  }
}
`)

  const gh = join(temp, "gh")
  await writeFile(gh, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  html_url: "https://github.com/owner/repo/pull/1",
  base: { repo: { full_name: "owner/repo" } },
}))
`)
  await chmod(gh, 0o755)

  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [executor], {
      cwd: workspace,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AGENT_TASK_REQUEST_PATH: join(workspace, ".codebox", "agent-task-request.json"),
        AGENT_TASK_WORKSPACE: workspace,
        WP_CODEBOX_WORKFLOW_ROOT: root,
        WP_CODEBOX_CLI_PATH: fakeCli,
         WP_CODEBOX_TEST_SKIP_MATERIALIZATION: "true",
         WP_CODEBOX_TEST_PUBLISHER_MODULE: publisher,
         WP_CODEBOX_TEST_PUBLISHER_HOOK: JSON.stringify({ orderPath: publisherOrderPath }),
        GITHUB_TOKEN: "token",
        EXPLICIT_ACCESS_TOKEN_CONFIGURED: "true",
        EXTERNAL_PACKAGE_SOURCE_POLICY: JSON.stringify({
          version: 1,
          repositories: { "owner/agents": ["agent.agent.json"] },
        }),
        PATH: `${temp}:${process.env.PATH || ""}`,
      },
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code) => done({ code, stderr }))
  })

  return {
    ...result,
    workspace,
    result: JSON.parse(await readFile(join(workspace, ".codebox", "agent-task-workflow-result.json"), "utf8")),
    order: await readFile(join(workspace, ".codebox", "order"), "utf8").catch(() => ""),
  }
}

const success = await run()
assert.equal(success.code, 0, success.stderr)
assert.equal(await readFile(join(success.workspace, "README.md"), "utf8"), "after\n")
assert.match(success.order, /runtime\nvalidation\nverification\ndrift\npublish\n/)
assert.equal(success.result.runtime_result.metadata.runner_workspace_publication.pull_request.url, "https://github.com/owner/repo/pull/1")
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.prepared_paths.workspaces[0].target, "/workspace")
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.prepared_paths.workspaces[0].mode, "readwrite")
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.sandbox_workspace.mounts[0].target, "/workspace")
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.local_executor_root, "/workspace")

const failedVerification = await run("verify-fail")
assert.equal(failedVerification.code, 1)
assert(!failedVerification.order.includes("publish"))
assert.equal(failedVerification.result.failure.stage, "verification")
assert.equal(failedVerification.result.runtime_result.success, true, "verification failures retain the normalized runtime result")

const denied = await run("deny")
assert.equal(denied.code, 1)
assert.equal(denied.order, "runtime\n")

const noOpRequired = await run("no-op")
assert.equal(noOpRequired.code, 1)
assert(!noOpRequired.order.includes("publish"))
assert.equal(noOpRequired.result.failure.stage, "no-op")
assert.equal(noOpRequired.result.runtime_result.success, true, "downstream failures retain the normalized runtime result")

const noOpMaintenance = await run("no-op-maintenance")
assert.equal(noOpMaintenance.code, 0)
assert(!noOpMaintenance.order.includes("publish"))

const mismatch = await run("mismatch")
assert.equal(mismatch.code, 1)
assert.equal(await readFile(join(mismatch.workspace, "README.md"), "utf8"), "diverged\n", "base mismatch fails before the rejected patch can mutate the host workspace")
assert.equal(mismatch.result.failure.stage, "apply")
assert.match(mismatch.result.failure.message, /seed identity does not match/)
assert.notEqual(mismatch.result.failure.evidence.expected_identity.content_digest.value, mismatch.result.failure.evidence.actual_identity.content_digest.value)
assert.equal(mismatch.result.failure.evidence.patch.artifact_path, "files/patch.diff")
assert.equal(mismatch.result.failure.evidence.changed_files.artifact_path, "files/changed-files.json")
await execFileAsync(process.execPath, [uploader], {
  cwd: mismatch.workspace,
  env: {
    ...process.env,
    AGENT_TASK_WORKSPACE: mismatch.workspace,
    AGENT_TASK_REQUEST_PATH: join(mismatch.workspace, ".codebox", "agent-task-request.json"),
    AGENT_TASK_UPLOAD_PATH: join(mismatch.workspace, ".codebox", "agent-task-upload"),
  },
})
assert.equal(await readFile(join(mismatch.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "apply-failure", "rejected.patch"), "utf8"), "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n")
assert.match(await readFile(join(mismatch.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "apply-failure", "changed-files.json"), "utf8"), /README\.md/)

const applyReject = await run("apply-reject")
assert.equal(applyReject.code, 1)
assert.equal(await readFile(join(applyReject.workspace, "README.md"), "utf8"), "before\n", "a rejected patch does not partially mutate the matching host workspace")
assert.equal(applyReject.result.failure.stage, "apply")
assert.match(applyReject.result.failure.message, /Host git apply failed/)
assert.deepEqual(applyReject.result.failure.evidence.expected_identity, applyReject.result.failure.evidence.actual_identity, "the failure records the matching seed and host identities")
assert.equal(applyReject.result.failure.evidence.patch.artifact_path, "files/patch.diff")
assert.equal(applyReject.result.failure.evidence.changed_files.artifact_path, "files/changed-files.json")
await execFileAsync(process.execPath, [uploader], {
  cwd: applyReject.workspace,
  env: {
    ...process.env,
    AGENT_TASK_WORKSPACE: applyReject.workspace,
    AGENT_TASK_REQUEST_PATH: join(applyReject.workspace, ".codebox", "agent-task-request.json"),
    AGENT_TASK_UPLOAD_PATH: join(applyReject.workspace, ".codebox", "agent-task-upload"),
  },
})
assert.match(await readFile(join(applyReject.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "apply-failure", "rejected.patch"), "utf8"), /-not-before/)
assert.match(await readFile(join(applyReject.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "apply-failure", "changed-files.json"), "utf8"), /README\.md/)

console.log("native agent task lifecycle ok")
