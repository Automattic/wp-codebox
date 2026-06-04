import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-workflow-phases-smoke")
const recipePath = resolve(workspace, "recipe.json")
const failureRecipePath = resolve(workspace, "failure-recipe.json")
const artifactDirectory = resolve(workspace, "artifacts")

const appendPhaseCode = (phase: string) => `$order = get_option('wp_codebox_workflow_phase_order', array()); $order[] = '${phase}'; update_option('wp_codebox_workflow_phase_order', $order); echo wp_json_encode($order);`

mkdirSync(workspace, { recursive: true })
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-workflow-phases-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  workflow: {
    before: [
      {
        command: "wordpress.run-php",
        args: [`code=${appendPhaseCode("before")}`],
      },
    ],
    steps: [
      {
        command: "wordpress.run-php",
        args: [`code=${appendPhaseCode("steps")}`],
      },
    ],
    after: [
      {
        command: "wordpress.run-php",
        args: [`code=${appendPhaseCode("after")}`],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(failureRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-workflow-phases-failure-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  workflow: {
    before: [
      {
        command: "wordpress.run-php",
        args: [`code=${appendPhaseCode("before")}`],
      },
    ],
    steps: [
      {
        command: "wordpress.run-php",
        args: [`code=${appendPhaseCode("steps")}`],
      },
    ],
    after: [
      {
        command: "wordpress.run-php",
        args: ["code=throw new RuntimeException('after phase failed');"],
      },
    ],
  },
}, null, 2)}\n`)

const dryRun = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout)
const dryRunOutput = JSON.parse(dryRun.stdout)
assert.deepEqual(dryRunOutput.plan.workflow.steps.map((step: { phase: string }) => step.phase), ["before", "steps", "after"])
assert.equal(dryRunOutput.plan.workflow.before[0].phase, "before")
assert.equal(dryRunOutput.plan.workflow.after[0].phase, "after")

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  artifactDirectory,
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)
const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.deepEqual(output.executions.map((execution: { recipePhase: string }) => execution.recipePhase), ["before", "steps", "after"])
assert.equal(output.phaseEvidence.find((phase: { name: string }) => phase.name === "run_workloads")?.status, "completed")
assert.deepEqual(JSON.parse(output.executions[2].stdout), ["before", "steps", "after"])

const metadata = JSON.parse(readFileSync(output.artifacts.metadataPath, "utf8"))
assert.equal(metadata.provenance.task.workflow.before[0].command, "wordpress.run-php")
assert.equal(metadata.provenance.task.workflow.steps[0].command, "wordpress.run-php")
assert.equal(metadata.provenance.task.workflow.after[0].command, "wordpress.run-php")

const failureResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  failureRecipePath,
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(failureResult.status, 1, failureResult.stderr || failureResult.stdout)
const failureOutput = JSON.parse(failureResult.stdout)
assert.equal(failureOutput.success, false)
assert.match(failureOutput.error.message, /Recipe workflow after\[0\] failed/)
assert.deepEqual(failureOutput.executions.map((execution: { recipePhase: string }) => execution.recipePhase), ["before", "steps"])
assert.equal(failureOutput.phaseEvidence.find((phase: { name: string }) => phase.name === "run_workloads")?.status, "failed")
assert.equal(failureOutput.run.metadata.runResourceEvidence.reliability.failureClassification.value, "workload")
assert.equal(failureOutput.run.metadata.runResourceEvidence.reliability.failureClassification.phase, "run_workloads")

console.log("recipe workflow phases smoke passed")
