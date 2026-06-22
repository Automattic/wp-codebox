import { normalizeRecipeRunSummary } from "@automattic/wp-codebox-core"

const success = normalizeRecipeRunSummary({
  success: true,
  schema: "wp-codebox/recipe-run/v1",
  artifacts: {
    id: "bundle-ok",
    directory: "/tmp/codebox/bundle-ok",
    runtimeLogPath: "/tmp/codebox/bundle-ok/logs/runtime.log",
    commandsPath: "/tmp/codebox/bundle-ok/commands.jsonl",
    commandsLogPath: "/tmp/codebox/bundle-ok/logs/commands.log",
    changedFilesPath: "/tmp/codebox/bundle-ok/files/changed-files.json",
    patchPath: "/tmp/codebox/bundle-ok/files/patch.diff",
    preview: {
      status: "available",
      lifecycle: "held-after-run",
      source: "public-url-override",
      createdAt: "2026-06-17T00:00:00.000Z",
      expiresAt: "2026-06-17T00:05:00.000Z",
      holdSeconds: 300,
      reviewerAccess: {
        schema: "wp-codebox/preview-reviewer-access/v1",
        status: "ready",
        outcome: "public",
        mode: "direct-url",
        reviewerSafe: true,
        openUrl: "https://example.com/preview",
        targetUrl: "https://example.com/preview",
      },
    },
  },
  executions: [{ command: "wordpress.wp-cli", exitCode: 0, stdout: "first\nsecond\n", stderr: "", durationMs: 12, recipePhase: "run_workloads", recipeStepIndex: 0 }],
  run: { runId: "run-ok", status: "succeeded" },
  phaseEvidence: [{ name: "runtime_startup", status: "completed" }],
})
assertEqual(success.status, "succeeded", "success normalizes to succeeded")
assertEqual(success.refs.startup_logs.length, 3, "startup logs are grouped")
assertEqual(success.refs.changed_files[0]?.path, "/tmp/codebox/bundle-ok/files/changed-files.json", "changed files path is grouped")
assertEqual(success.refs.logs.some((ref) => ref.path === "/tmp/codebox/bundle-ok/commands.jsonl"), true, "commands jsonl is grouped")
assertEqual(success.commands[0]?.stdout_tail, "first\nsecond\n", "command stdout tail is exposed")
assertEqual(success.runtime_access?.schema, "wp-codebox/runtime-access/v1", "runtime access schema is exposed")
assertEqual(success.runtime_access?.preview_url, "https://example.com/preview", "runtime access preview URL is exposed")
assertEqual(success.preview?.reviewer_access?.openUrl, "https://example.com/preview", "preview reviewer access is exposed")
assertEqual(success.preview?.runtime_access?.preview_url, "https://example.com/preview", "preview runtime access is exposed")
assertEqual(success.metadata.run_id, "run-ok", "run metadata is exposed")

const startupFailure = normalizeRecipeRunSummary({
  success: false,
  schema: "wp-codebox/recipe-run/v1",
  error: { message: "Unable to prepare backend package." },
  diagnostics: [{ schema: "wp-codebox/plugin-runtime-diagnostic/v1", phase: "backend-preparation", message: "Backend package failed" }],
})
assertEqual(startupFailure.status, "failed", "startup failure normalizes to failed")
assertEqual(startupFailure.failed_phase, "backend-preparation", "diagnostic phase is used when phase evidence is absent")
assertEqual(startupFailure.failure_summary, "backend-preparation: Unable to prepare backend package.", "failure summary includes phase")

const probeFailure = normalizeRecipeRunSummary({
  success: false,
  schema: "wp-codebox/recipe-run/v1",
  error: { message: "Recipe probe failed" },
  phaseEvidence: [{ name: "run_probes", status: "failed" }],
  probes: [{
    index: 0,
    name: "homepage",
    status: "failed",
    summary: {
      summaryFile: "/tmp/codebox/probe-summary.json",
      screenshot: "/tmp/codebox/homepage.png",
    },
  }],
})
assertEqual(probeFailure.failed_phase, "run_probes", "failed phase evidence wins")
assertEqual(probeFailure.refs.probe_json[0]?.path, "/tmp/codebox/probe-summary.json", "probe summary JSON is grouped")
assertEqual(probeFailure.refs.screenshots[0]?.path, "/tmp/codebox/homepage.png", "probe screenshots are grouped")

const artifactFailure = normalizeRecipeRunSummary({
  success: false,
  schema: "wp-codebox/recipe-run/v1",
  error: { message: "Required declared artifacts were not collected" },
  phaseEvidence: [{ name: "collect_artifacts", status: "failed" }],
  declaredArtifacts: [{ name: "report", required: true, status: "missing", path: "/tmp/codebox/report.json" }],
  artifacts: { diffsPath: "/tmp/codebox/side-effects.json" },
})
assertEqual(artifactFailure.failed_phase, "collect_artifacts", "artifact collection failure exposes failed phase")
assertEqual(artifactFailure.refs.declared_artifacts[0]?.path, "/tmp/codebox/report.json", "declared artifacts are grouped")
assertEqual(artifactFailure.refs.side_effects[0]?.path, "/tmp/codebox/side-effects.json", "side-effect artifacts are grouped")

console.log("recipe run summary smoke ok")

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}
