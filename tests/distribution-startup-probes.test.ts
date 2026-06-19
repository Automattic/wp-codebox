import assert from "node:assert/strict"

import type { Runtime, WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { normalizeRecipeRunSummary } from "../packages/runtime-core/src/recipe-run-summary.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"
import { distributionStartupProbeFailure, runDistributionStartupProbes } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  distribution: {
    name: "custom-distribution",
    wordpress: { root: "/wordpress" },
    startupProbes: [
      { name: "database", type: "wp-cli", command: "option get siteurl", metadata: { role: "readiness" } },
      { name: "bootstrap", type: "php", code: "echo 'ready';" },
      { name: "homepage", type: "browser", url: "/" },
      { name: "api", type: "http", url: "/wp-json/", expectStatus: 200 },
    ],
  },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 'workload';"] }] },
}

const policy = recipePolicy(recipe)
assert.ok(policy.commands.includes("wordpress.wp-cli"), "wp-cli startup probes are policy-visible")
assert.ok(policy.commands.includes("wordpress.run-php"), "php startup probes are policy-visible")
assert.ok(policy.commands.includes("wordpress.browser-probe"), "browser startup probes are policy-visible")

const executed: Array<{ command: string; args: string[] }> = []
const runtime = {
  async execute(spec: { command: string; args?: string[] }) {
    executed.push({ command: spec.command, args: spec.args ?? [] })
    return {
      id: `execution-${executed.length}`,
      command: spec.command,
      args: spec.args ?? [],
      exitCode: 0,
      stdout: spec.command === "wordpress.wp-cli" ? "http://example.test\n" : "ready",
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.001Z",
    }
  },
} as Runtime

const executions = []
const results = await runDistributionStartupProbes(recipe, runtime, executions)

assert.deepEqual(executed, [
  { command: "wordpress.wp-cli", args: ["command=option get siteurl"] },
  { command: "wordpress.run-php", args: ["code=echo 'ready';"] },
  { command: "wordpress.browser-probe", args: ["url=/"] },
])
assert.equal(executions.length, 3)
assert.deepEqual(results.map((result) => [result.name, result.type, result.status]), [
  ["database", "wp-cli", "passed"],
  ["bootstrap", "php", "passed"],
  ["homepage", "browser", "passed"],
  ["api", "http", "skipped"],
])
assert.equal(results[0]?.metadata?.role, "readiness")
assert.equal(results[3]?.missingCommand, "wordpress.http-request")
assert.equal(results[3]?.url, "/wp-json/")
assert.equal(results[3]?.expectStatus, 200)
assert.deepEqual(results[3]?.availableCommands, ["wordpress.rest-request", "wordpress.browser-probe"])
assert.equal(distributionStartupProbeFailure(results), undefined)

const summary = normalizeRecipeRunSummary({
  success: true,
  executions,
  distributionStartupProbes: results,
  artifacts: { directory: "/tmp/artifacts" },
})
assert.ok(summary.artifacts.some((artifact) => artifact.kind === "distribution-startup-probe-result" && artifact.id === "database"))

console.log("distribution startup probes passed")
