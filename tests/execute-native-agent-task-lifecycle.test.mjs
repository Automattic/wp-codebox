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
  const targetRepo = mode === "canonical-casing" ? "automattic/build-with-wordpress" : "owner/repo"
  const publicationRepo = mode === "canonical-casing"
    ? "Automattic/build-with-wordpress"
    : targetRepo
  const resolvedRepo = mode === "different-repo" ? "other/repo" : publicationRepo
  await mkdir(join(workspace, ".codebox"), { recursive: true })
  await writeFile(join(workspace, "README.md"), "OPENAI_API_KEY\nbefore\n")

  const artifactModes = new Set(["artifact-verification", "artifact-drift", "artifact-readonly", "artifact-missing", "artifact-traversal", "artifact-symlink", "artifact-oversized", "artifact-undeclared", "artifact-mismatch", "artifact-command-fail", "artifact-replaced"])
  const commandArtifact = artifactModes.has(mode) ? {
    name: "completion_report",
    type: "CompletionReport",
    path: mode === "artifact-traversal" ? "../completion-report.json" : "completion-report.json",
  } : undefined
  const artifactCommand = mode === "artifact-missing"
    ? "echo verification >> .codebox/order"
    : mode === "artifact-traversal"
      ? `echo verification >> .codebox/order && printf '%s\\n' '{"ok":true}' > .codebox/completion-report.json`
      : mode === "artifact-symlink"
        ? `echo verification >> .codebox/order && printf '%s\\n' '{"ok":true}' > .codebox/completion-report-source.json && ln -s ../completion-report-source.json .codebox/agent-task-artifacts/completion-report.json`
        : mode === "artifact-oversized"
          ? `echo verification >> .codebox/order && node -e 'require("node:fs").writeFileSync(".codebox/agent-task-artifacts/completion-report.json", Buffer.alloc(4 * 1024 * 1024 + 1, 120))'`
          : `echo verification >> .codebox/order && printf '%s\\n' '{"ok":true}' > .codebox/agent-task-artifacts/completion-report.json${mode === "artifact-command-fail" ? " && false" : mode === "artifact-readonly" ? " && chmod 444 .codebox/agent-task-artifacts/completion-report.json" : ""}`
  const verificationCommand = artifactModes.has(mode) && mode !== "artifact-drift" ? artifactCommand : (mode === "verify-fail" ? "false" : "echo verification >> .codebox/order")
  const driftCommand = mode === "artifact-drift"
    ? artifactCommand
    : mode === "artifact-replaced"
      ? `echo drift >> .codebox/order && printf '%s\\n' '{"ok":false}' > .codebox/agent-task-artifacts/completion-report.json`
      : "echo drift >> .codebox/order"

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
    target_repo: targetRepo,
    prompt: "Edit README using workspace_read and workspace_edit.",
    writable_paths: mode === "deny" ? "src/**" : "README.md",
    runner_workspace: {
      enabled: true,
      repo: targetRepo,
      base: "main",
      branch_prefix: "wp-codebox/agent-task/",
    },
    validation_dependencies: "echo validation >> .codebox/order",
    verification_commands: [
      { command: verificationCommand, ...(mode !== "artifact-drift" && commandArtifact ? { artifact: commandArtifact } : {}) },
    ],
    drift_checks: [{ command: driftCommand, ...(mode === "artifact-drift" && commandArtifact ? { artifact: commandArtifact } : {}) }],
    success: { requires_pr: mode !== "no-op-maintenance" },
    access: {
      caller_repo: targetRepo,
      allowed_repos: [targetRepo],
      access_token_repos: [targetRepo],
    },
    limits: { max_turns: 1, time_budget_ms: 1000 },
    artifacts: {
      expected: [],
      declarations: artifactModes.has(mode) && mode !== "artifact-undeclared"
        ? [{ name: "completion_report", type: mode === "artifact-mismatch" ? "DifferentReport" : "CompletionReport", direction: "output", contentType: "application/json" }]
        : [],
    },
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
const trustedRoot = process.env.WP_CODEBOX_TRUSTED_APPLY_ARTIFACT_ROOT
if (trustedRoot) await mkdir(join(trustedRoot, "files"), { recursive: true })
const patch = ${JSON.stringify(noOp ? "" : applyReject ? "--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n OPENAI_API_KEY\n-not-before\n+after\n" : "--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n OPENAI_API_KEY\n-before\n+after\n")}
await writeFile(join(root, "patch.diff"), patch)
await writeFile(join(root, "changed-files.json"), JSON.stringify({
  schema: "wp-codebox/changed-files/v1",
  files: ${noOp} ? [] : [{ path: "/workspace/README.md", relativePath: "README.md", status: "modified", beforeMode: "100644", afterMode: "100644" }],
}))
if (trustedRoot) {
   await writeFile(join(trustedRoot, "files", "patch.diff"), patch)
   await writeFile(join(trustedRoot, "files", "changed-files.json"), JSON.stringify({
     schema: "wp-codebox/changed-files/v1",
     files: ${noOp} ? [] : [{ path: "/workspace/README.md", relativePath: "README.md", status: "modified", beforeMode: "100644", afterMode: "100644" }],
   }))
 }
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
    pull_request: { url: ${JSON.stringify(`https://github.com/${publicationRepo}/pull/1`)}, reused: false, opened: true },
  }
}
`)

  const gh = join(temp, "gh")
  await writeFile(gh, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  html_url: ${JSON.stringify(`https://github.com/${resolvedRepo}/pull/1`)},
  base: { repo: { full_name: ${JSON.stringify(resolvedRepo)} } },
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
        MODEL_PROVIDER_SECRET_1: "OPENAI_API_KEY",
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
assert.equal(success.code, 0, `${success.stderr}\n${JSON.stringify(success.result)}`)
assert.equal(await readFile(join(success.workspace, "README.md"), "utf8"), "OPENAI_API_KEY\nafter\n")
const durablePatch = await readFile(join(success.workspace, ".codebox", "agent-task-artifacts", "files", "patch.diff"), "utf8")
assert(!durablePatch.includes("OPENAI_API_KEY"), "durable patch artifacts redact configured secret values")
assert.match(durablePatch, /\[REDACTED\]/)
assert.match(success.order, /runtime\nvalidation\nverification\ndrift\npublish\n/)
assert.equal(success.result.runtime_result.metadata.runner_workspace_publication.pull_request.url, "https://github.com/owner/repo/pull/1")
assert.deepEqual(success.result.publication_verification, { valid: true })
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.prepared_paths.workspaces[0].target, "/workspace")
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.prepared_paths.workspaces[0].mode, "readwrite")
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.sandbox_workspace.mounts[0].target, "/workspace")
assert.equal(success.result.runtime_result.agent_runtime_diagnostics.local_executor_root, "/workspace")
assert.equal(success.result.verification.some((check) => check.artifact || check.artifact_error), false, "legacy command entries retain their result shape")

for (const mode of ["artifact-verification", "artifact-drift", "artifact-readonly"]) {
  const artifactSuccess = await run(mode)
  assert.equal(artifactSuccess.code, 0, `${artifactSuccess.stderr}\n${JSON.stringify(artifactSuccess.result)}`)
  const artifactCheck = artifactSuccess.result.verification.find((check) => check.artifact)
  assert.equal(artifactCheck.kind, mode === "artifact-drift" ? "drift" : "verification")
  assert.deepEqual({ schema: artifactCheck.artifact.schema, name: artifactCheck.artifact.name, type: artifactCheck.artifact.type }, {
    schema: "wp-codebox/typed-artifact/v1",
    name: "completion_report",
    type: "CompletionReport",
  })
  assert.equal(artifactCheck.artifact.artifact.path, "completion-report.json")
  assert.match(artifactCheck.artifact.artifact.sha256, /^[a-f0-9]{64}$/)
  await execFileAsync(process.execPath, [uploader], {
    cwd: artifactSuccess.workspace,
    env: {
      ...process.env,
      AGENT_TASK_WORKSPACE: artifactSuccess.workspace,
      AGENT_TASK_REQUEST_PATH: join(artifactSuccess.workspace, ".codebox", "agent-task-request.json"),
      AGENT_TASK_UPLOAD_PATH: join(artifactSuccess.workspace, ".codebox", "agent-task-upload"),
    },
  })
  assert.deepEqual(JSON.parse(await readFile(join(artifactSuccess.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "completion-report.json"), "utf8")), { ok: true })
  const uploadedResult = JSON.parse(await readFile(join(artifactSuccess.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-workflow-result.json"), "utf8"))
  assert.equal(uploadedResult.verification.find((check) => check.artifact).artifact.artifact.path, "completion-report.json")
  if (mode === "artifact-verification") {
    await writeFile(join(artifactSuccess.workspace, ".codebox", "agent-task-artifacts", "completion-report.json"), '{"tampered":true}\n')
    await assert.rejects(execFileAsync(process.execPath, [uploader], {
      cwd: artifactSuccess.workspace,
      env: {
        ...process.env,
        AGENT_TASK_WORKSPACE: artifactSuccess.workspace,
        AGENT_TASK_REQUEST_PATH: join(artifactSuccess.workspace, ".codebox", "agent-task-request.json"),
        AGENT_TASK_UPLOAD_PATH: join(artifactSuccess.workspace, ".codebox", "agent-task-upload"),
      },
    }), /could not be staged without modification/)
  }
}

for (const [mode, code] of [
  ["artifact-missing", "wp-codebox.agent-task.command-artifact-missing"],
  ["artifact-traversal", "wp-codebox.agent-task.command-artifact-path"],
  ["artifact-symlink", "wp-codebox.agent-task.command-artifact-symlink"],
  ["artifact-oversized", "wp-codebox.agent-task.command-artifact-too-large"],
  ["artifact-undeclared", "wp-codebox.agent-task.command-artifact-undeclared"],
  ["artifact-mismatch", "wp-codebox.agent-task.command-artifact-mismatch"],
  ["artifact-replaced", "wp-codebox.agent-task.command-artifact-changed"],
]) {
  const artifactFailure = await run(mode)
  assert.equal(artifactFailure.code, 1)
  assert(!artifactFailure.order.includes("publish"), `${mode} must fail before publication`)
  assert.equal(artifactFailure.result.failure.stage, "verification")
  assert.equal(artifactFailure.result.failure.artifact_error.code, code)
  assert.equal(artifactFailure.result.verification.find((check) => check.artifact_error).artifact_error.code, code)
}

const failedArtifactCommand = await run("artifact-command-fail")
assert.equal(failedArtifactCommand.code, 1)
const failedArtifactCheck = failedArtifactCommand.result.verification.find((check) => check.kind === "verification")
assert.equal(failedArtifactCheck.exit_code, 1)
assert.equal(failedArtifactCheck.artifact, undefined)
assert.equal(failedArtifactCheck.artifact_error, undefined, "failed commands do not accept or validate artifacts")

const canonicalCasing = await run("canonical-casing")
assert.equal(canonicalCasing.code, 0, `${canonicalCasing.stderr}\n${JSON.stringify(canonicalCasing.result)}`)
assert.deepEqual(canonicalCasing.result.publication_verification, { valid: true })

const differentRepository = await run("different-repo")
assert.equal(differentRepository.code, 1)
assert.deepEqual(differentRepository.result.publication_verification, {
  valid: false,
  error: "Published pull request did not resolve to the target repository.",
})
assert.equal(differentRepository.result.failure.message, "Published pull request did not resolve to the target repository.")

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
assert.equal(await readFile(join(mismatch.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "apply-failure", "rejected.patch"), "utf8"), "--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n [REDACTED]\n-before\n+after\n")
assert.match(await readFile(join(mismatch.workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "apply-failure", "changed-files.json"), "utf8"), /README\.md/)

const applyReject = await run("apply-reject")
assert.equal(applyReject.code, 1)
assert.equal(await readFile(join(applyReject.workspace, "README.md"), "utf8"), "OPENAI_API_KEY\nbefore\n", "a rejected patch does not partially mutate the matching host workspace")
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
