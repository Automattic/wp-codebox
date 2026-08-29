import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { normalizeRecipeRunSummary } from "@automattic/wp-codebox-core"
import { writeRecipeJsonOutput, writeRecipeSummaryHumanOutput } from "../packages/cli/src/commands/recipe-run-output.js"

const success = normalizeRecipeRunSummary({
  success: true,
  schema: "wp-codebox/recipe-run/v1",
  recipePath: "/tmp/recipe.json",
  runtime: { id: "runtime-ok", status: "ready" },
  run: { runId: "run-ok", status: "succeeded" },
  artifacts: { directory: "/tmp/artifacts/run-ok" },
  executions: [{ command: "wordpress.wp-cli option get siteurl", exitCode: 0, durationMs: 12, recipePhase: "run_workloads", recipeStepIndex: 0 }],
  adversarialCampaigns: [{
    declaration: { id: "adaptive-browser" },
    evidence: { path: "files/adversarial/adaptive-browser" },
    result: {
      campaignId: "adaptive-browser",
      status: "findings",
      summary: { generated: 2, executed: 2, findings: 1 },
      findings: [{ fingerprint: "oracle-fingerprint", status: "failed", oracleIds: ["runtime-status"], artifactRefs: [{ path: "files/browser/adaptive-exploration.json", kind: "browser-adaptive-exploration", bytes: 2048 }] }],
    },
  }],
})

assert.equal(success.status, "succeeded", "retained adversarial findings remain advisory")
assert.deepEqual(success.metadata.adversarial_campaigns, [{
  campaign_id: "adaptive-browser",
  status: "findings",
  summary: { generated: 2, executed: 2, findings: 1 },
  evidence_ref: "files/adversarial/adaptive-browser",
  findings: [{ fingerprint: "oracle-fingerprint", status: "failed", oracle_ids: ["runtime-status"], artifact_refs: [{ path: "files/browser/adaptive-exploration.json", kind: "browser-adaptive-exploration" }] }],
}])

const successHuman = await captureStdout(() => writeRecipeSummaryHumanOutput(success))
assert.match(successHuman, /WP Codebox recipe summary/)
assert.match(successHuman, /Status: succeeded/)
assert.match(successHuman, /Recipe: \/tmp\/recipe\.json/)
assert.match(successHuman, /Run: run-ok \(succeeded\)/)
assert.match(successHuman, /Runtime: runtime-ok \(ready\)/)
assert.match(successHuman, /Artifacts: \/tmp\/artifacts\/run-ok/)
assert.match(successHuman, /Commands: 1/)
assert.match(successHuman, /#1 succeeded exit=0 phase=run_workloads/)

const failure = normalizeRecipeRunSummary({
  success: false,
  schema: "wp-codebox/recipe-run/v1",
  recipePath: "/tmp/failing.recipe.json",
  error: { message: "Workflow command failed" },
  runtime: { id: "runtime-fail", status: "stopped" },
  run: { runId: "run-fail", status: "failed" },
  artifacts: { directory: "/tmp/artifacts/run-fail" },
  phaseEvidence: [{ name: "run_workloads", status: "failed" }],
  diagnostics: [{ code: "workflow-command-failed", message: "Command exited non-zero" }],
  executions: [{ command: "wordpress.wp-cli eval 'broken'", exitCode: 1, stdout: "line 1\nline 2\n", stderr: "fatal detail\n", recipePhase: "run_workloads", recipeStepIndex: 0 }],
})

const failureHuman = await captureStdout(() => writeRecipeSummaryHumanOutput(failure))
assert.match(failureHuman, /Status: failed/)
assert.match(failureHuman, /Failed phase: run_workloads/)
assert.match(failureHuman, /Failure: run_workloads: Workflow command failed/)
assert.match(failureHuman, /#1 failed exit=1 phase=run_workloads/)
assert.match(failureHuman, /stderr: fatal detail/)
assert.match(failureHuman, /stdout: line 1 \| line 2/)
assert.match(failureHuman, /Diagnostics: 1/)

const failureJson = await captureStdout(() => writeRecipeJsonOutput(failure))
const parsed = JSON.parse(failureJson)
assert.equal(parsed.schema, "wp-codebox/recipe-run-summary/v1")
assert.equal(parsed.status, "failed")
assert.equal(parsed.failed_phase, "run_workloads")
assert.equal(parsed.commands[0].exit_code, 1)

const outputPath = join(tmpdir(), `wp-codebox-recipe-run-output-${process.pid}`, "summary.json")
const fileStdout = await captureStdout(() => writeRecipeJsonOutput(failure, outputPath))
assert.equal(fileStdout, "")
assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), parsed)

async function captureStdout(callback: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let output = ""
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output += typeof chunk === "string" ? chunk : chunk.toString()
    if (typeof encodingOrCallback === "function") encodingOrCallback()
    else callback?.()
    return true
  }) as typeof process.stdout.write

  try {
    await callback()
    return output
  } finally {
    process.stdout.write = originalWrite
  }
}
