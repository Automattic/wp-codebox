import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { assertWorkspaceRecipeJsonSchema, fuzzSuiteContract, type ExecutionResult, type ExecutionSpec, type Runtime, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { executeRecipeWorkflowStep } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

const suite = fuzzSuiteContract({
  id: "nested-workload-suite",
  cases: [{
    id: "case-one",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ command: "wordpress.run-php", args: ["code=echo 'ok';"] }],
    },
  }],
})

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(suite)}`] }],
  },
}

assertWorkspaceRecipeJsonSchema(recipe, { recipeCommandIds: ["wp-codebox/run-fuzz-suite", "wordpress.run-php"] })

const executed: ExecutionSpec[] = []
let checkpointCreates = 0
let checkpointRestores = 0
const runtime = {
  async createCheckpoint({ name }: { name: string }) {
    checkpointCreates += 1
    return { schema: "wp-codebox/runtime-checkpoint-result/v1" as const, status: "created", operation: "create" as const, checkpoint: { name, snapshotId: `snapshot-${name}`, createdAt: "2026-01-01T00:00:00.000Z" } }
  },
  async restoreCheckpoint(name: string) {
    checkpointRestores += 1
    return { schema: "wp-codebox/runtime-checkpoint-result/v1" as const, status: "restored", operation: "restore" as const, checkpoint: { name, snapshotId: `snapshot-${name}`, createdAt: "2026-01-01T00:00:00.000Z", restoredAt: "2026-01-01T00:00:01.000Z" } }
  },
  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    executed.push(spec)
    if (spec.command === "wordpress.run-php" && (spec.args ?? []).some((arg) => arg.includes("emit-rest-db-profile"))) {
      const payload = {
        schema: "wp-codebox/json-workload-result/v1",
        steps: [{ type: "rest-db-query-profiler", artifacts: { "rest-db-query-profile": { schema: "wp-codebox/wordpress-rest-db-query-profile/v1", summary: { case_count: 1, query_count: 4 } } } }],
      }
      return {
        id: `exec-${executed.length}`,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: 0,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        result: { schema: "wp-codebox/runtime-command-result/v1", status: "ok", json: payload },
      }
    }
    if (spec.command === "wordpress.bench" && (spec.args ?? []).some((arg) => arg.includes("rest-db-query-profiler"))) {
      const payload = {
        schema: "wp-codebox/bench-results/v1",
        scenarios: [{ id: "recipe-profile", artifacts: { "rest-db-query-profile": { schema: "wp-codebox/wordpress-rest-db-query-profile/v1", summary: { case_count: 1, query_count: 7 } } } }],
      }
      return {
        id: `exec-${executed.length}`,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: 0,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        result: { schema: "wp-codebox/runtime-command-result/v1", status: "ok", json: payload },
      }
    }
    if (spec.command === "wordpress.bench" && (spec.args ?? []).some((arg) => arg.includes("db-inventory"))) {
      const payload = {
        schema: "wp-codebox/bench-results/v1",
        scenarios: [{ id: "recipe-db-inventory", artifacts: { "db-inventory": { schema: "wp-codebox/wordpress-db-inventory/v1", inventory: { totals: { tableCount: 12 } } } } }],
      }
      return {
        id: `exec-${executed.length}`,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: 0,
        stdout: `${JSON.stringify(payload)}\n`,
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        result: { schema: "wp-codebox/runtime-command-result/v1", status: "ok", json: payload },
      }
    }
    return {
      id: `exec-${executed.length}`,
      command: spec.command,
      args: spec.args ?? [],
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    }
  },
} as Runtime

const execution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: recipe.workflow.steps[0]! }, process.cwd())
const result = JSON.parse(execution.stdout)

assert.equal(execution.command, "wp-codebox/run-fuzz-suite")
assert.equal(execution.exitCode, 0)
assert.equal(result.schema, "wp-codebox/fuzz-suite-result/v1")
assert.equal(result.status, "passed")
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])

executed.length = 0
const checkpointSuite = fuzzSuiteContract({
  id: "nested-checkpoint-suite",
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "nested-baseline" },
  cases: [
    { id: "checkpoint-case-one", target: { kind: "command", id: "wordpress.run-php", entrypoint: "wordpress.run-php" }, input: { args: ["code=echo 'one';"] } },
    { id: "checkpoint-case-two", target: { kind: "command", id: "wordpress.run-php", entrypoint: "wordpress.run-php" }, input: { args: ["code=echo 'two';"] } },
  ],
})
const checkpointExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(checkpointSuite)}`] } }, process.cwd())
const checkpointResult = JSON.parse(checkpointExecution.stdout)
assert.equal(checkpointExecution.exitCode, 0)
assert.equal(checkpointResult.status, "passed")
assert.equal(checkpointCreates, 1)
assert.equal(checkpointRestores, 2)
assert.deepEqual(checkpointResult.cases.map((fuzzCase: { id: string; reset: { mode: string; status: string } }) => [fuzzCase.id, fuzzCase.reset.mode, fuzzCase.reset.status]), [["checkpoint-case-one", "checkpoint-per-case", "passed"], ["checkpoint-case-two", "checkpoint-per-case", "passed"]])
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php", "wordpress.run-php"])

const suiteAliasDir = await mkdtemp(join(tmpdir(), "wp-codebox-nested-fuzz-suite-alias-"))
await writeFile(join(suiteAliasDir, "suite.json"), JSON.stringify(suite), "utf8")
const suiteAliasRecipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wp-codebox/run-fuzz-suite", args: ["suite=suite.json"] }],
  },
}
assertWorkspaceRecipeJsonSchema(suiteAliasRecipe, { recipeCommandIds: ["wp-codebox/run-fuzz-suite", "wordpress.run-php"] })
const aliasExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: suiteAliasRecipe.workflow.steps[0]! }, suiteAliasDir)
const aliasResult = JSON.parse(aliasExecution.stdout)

assert.equal(aliasExecution.command, "wp-codebox/run-fuzz-suite")
assert.equal(aliasExecution.exitCode, 0)
assert.equal(aliasResult.schema, "wp-codebox/fuzz-suite-result/v1")
assert.equal(aliasResult.status, "passed")

executed.length = 0
const phpWorkloadSuite = fuzzSuiteContract({
  id: "nested-php-workload-suite",
  cases: [{
    id: "php-file-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ command: "wordpress.run-workload", args: ["path=/tmp/workload.php", "type=php"] }],
    },
  }],
})
const phpExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(phpWorkloadSuite)}`] } }, process.cwd())
assert.equal(phpExecution.exitCode, 0)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])
assert.match(executed[0]?.args?.[0] ?? "", /require "\/tmp\/workload\.php"/)

executed.length = 0
const typedWorkloadSuite = fuzzSuiteContract({
  id: "nested-typed-workload-suite",
  metadata: { runtime_requirements: { extra_plugins: [{ slug: "woocommerce" }] } },
  cases: [{
    id: "typed-workload-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ type: "php", code: "return array('ok' => true);" }],
    },
  }],
})
const typedExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(typedWorkloadSuite)}`] } }, process.cwd())
assert.equal(typedExecution.exitCode, 0)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.bench"])
assert.ok(executed[0]?.args?.includes("plugin-slug=woocommerce"))

executed.length = 0
const typedJsonPathWorkloadSuite = fuzzSuiteContract({
  id: "nested-typed-json-path-workload-suite",
  metadata: { runtime_requirements: { extra_plugins: [{ slug: "woocommerce" }] } },
  cases: [{
    id: "typed-json-path-workload-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ type: "php", code: "return array('ok' => true);" }],
      metadata: { source_path: "/tmp/rest-db-query-profile.workload.json", source_entry: "rest-db-query-profile" },
    },
  }],
})
const typedJsonPathExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(typedJsonPathWorkloadSuite)}`] } }, process.cwd())
assert.equal(typedJsonPathExecution.exitCode, 0)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.bench"])
assert.ok(executed[0]?.args?.includes("plugin-slug=woocommerce"))

executed.length = 0
const directJsonWorkload: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wordpress.run-workload", args: [`workload-json=${JSON.stringify({ schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.run-php", args: ["code=echo 'json workload';"] }] })}`] }],
  },
}
assertWorkspaceRecipeJsonSchema(directJsonWorkload, { recipeCommandIds: ["wordpress.run-workload", "wordpress.run-php"] })
const directJsonExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: directJsonWorkload.workflow.steps[0]! }, process.cwd())
const directJsonResult = JSON.parse(directJsonExecution.stdout)
assert.equal(directJsonExecution.command, "wordpress.run-workload")
assert.equal(directJsonExecution.exitCode, 0)
assert.equal(directJsonResult.schema, "wp-codebox/wordpress-workload-run-result/v1")
assert.equal(directJsonResult.steps, 1)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])

executed.length = 0
const directJsonCollectWorkload: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wordpress.run-workload", args: [`workload-json=${JSON.stringify({ schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.run-php", args: ["code=emit-rest-db-profile"] }], after: [{ command: "wordpress.collect-workload-result", args: ["artifact=rest_db_query_profile"] }] })}`] }],
  },
}
assertWorkspaceRecipeJsonSchema(directJsonCollectWorkload, { recipeCommandIds: ["wordpress.run-workload", "wordpress.run-php", "wordpress.collect-workload-result"] })
const directJsonCollectExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: directJsonCollectWorkload.workflow.steps[0]! }, process.cwd())
const directJsonCollectResult = JSON.parse(directJsonCollectExecution.stdout)
assert.equal(directJsonCollectExecution.exitCode, 0)
assert.equal(directJsonCollectResult.schema, "wp-codebox/wordpress-workload-run-result/v1")
assert.equal(directJsonCollectResult.steps, 2)
assert.equal(directJsonCollectResult.artifacts["rest-db-query-profile"].schema, "wp-codebox/wordpress-rest-db-query-profile/v1")
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])

executed.length = 0
const directTypedJsonCollectWorkload: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wordpress.run-workload", args: [`workload-json=${JSON.stringify({ schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ type: "rest-db-query-profiler", rest_request_cases: [{ id: "products", method: "GET", path: "/wc/store/v1/products" }] }], after: [{ command: "wordpress.collect-workload-result", args: ["artifact=rest_db_query_profile"] }] })}`] }],
  },
}
assertWorkspaceRecipeJsonSchema(directTypedJsonCollectWorkload, { recipeCommandIds: ["wordpress.run-workload", "wordpress.bench", "wordpress.collect-workload-result"] })
const directTypedJsonCollectExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: directTypedJsonCollectWorkload.workflow.steps[0]! }, process.cwd())
const directTypedJsonCollectResult = JSON.parse(directTypedJsonCollectExecution.stdout)
assert.equal(directTypedJsonCollectExecution.exitCode, 0)
assert.equal(directTypedJsonCollectResult.schema, "wp-codebox/wordpress-workload-run-result/v1")
assert.equal(directTypedJsonCollectResult.steps, 2)
assert.equal(directTypedJsonCollectResult.artifacts["rest-db-query-profile"].schema, "wp-codebox/wordpress-rest-db-query-profile/v1")
assert.equal(directTypedJsonCollectResult.artifacts["rest-db-query-profile"].summary.query_count, 7)
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.bench"])

executed.length = 0
const directDbInventoryCollectWorkload: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wordpress.run-workload", args: [`workload-json=${JSON.stringify({ schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ type: "db-inventory", "include-columns": true, "include-indexes": true }], after: [{ command: "wordpress.collect-workload-result", args: ["artifact=options_transients_coverage"] }], metadata: { source_entry: "options-transients-coverage", workload: "db-inventory" } })}`] }],
  },
}
assertWorkspaceRecipeJsonSchema(directDbInventoryCollectWorkload, { recipeCommandIds: ["wordpress.run-workload", "wordpress.bench", "wordpress.collect-workload-result"] })
const directDbInventoryCollectExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: directDbInventoryCollectWorkload.workflow.steps[0]! }, process.cwd())
const directDbInventoryCollectResult = JSON.parse(directDbInventoryCollectExecution.stdout)
assert.equal(directDbInventoryCollectExecution.exitCode, 0)
assert.equal(directDbInventoryCollectResult.schema, "wp-codebox/wordpress-workload-run-result/v1")
assert.equal(directDbInventoryCollectResult.steps, 2)
assert.equal(directDbInventoryCollectResult.artifacts["db-inventory"].schema, "wp-codebox/wordpress-db-inventory/v1")
assert.equal(directDbInventoryCollectResult.artifacts["db-inventory"].inventory.totals.tableCount, 12)
assert.equal(directDbInventoryCollectResult.artifacts["options-transients-coverage"].schema, "wp-codebox/wordpress-db-inventory/v1")
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.bench"])

executed.length = 0
const nestedJsonWorkloadSuite = fuzzSuiteContract({
  id: "nested-json-workload-suite",
  cases: [{
    id: "json-workload-case",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [{ command: "wordpress.run-workload", args: [`workload-json=${JSON.stringify({ schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.run-php", args: ["code=echo 'nested json workload';"] }] })}`] }],
    },
  }],
})
const nestedJsonExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(nestedJsonWorkloadSuite)}`] } }, process.cwd())
const nestedJsonResult = JSON.parse(nestedJsonExecution.stdout)
assert.equal(nestedJsonExecution.exitCode, 0)
assert.equal(nestedJsonResult.status, "passed")
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php"])

executed.length = 0
const childSuite = fuzzSuiteContract({
  id: "nested-child-suite",
  cases: [{
    id: "child-command-case",
    target: { kind: "command", id: "wordpress.run-php", entrypoint: "wordpress.run-php" },
    input: { args: ["code=echo 'child';"] },
  }],
})
const workloadJsonFallbackSuite = fuzzSuiteContract({
  id: "nested-workload-json-fallback-suite",
  cases: [{
    id: "workload-json-fallback-case",
    target: { kind: "command", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      args: [`workload-json=${JSON.stringify({
        schema: "wp-codebox/wordpress-workload-run/v1",
        before: [{ command: "wordpress.run-php", args: ["code=echo 'before';"] }],
        steps: [{ command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(childSuite)}`] }],
        after: [],
      })}`],
    },
  }],
})
const fallbackExecution = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(workloadJsonFallbackSuite)}`] } }, process.cwd())
const fallbackResult = JSON.parse(fallbackExecution.stdout)
assert.equal(fallbackExecution.exitCode, 0)
assert.equal(fallbackResult.status, "passed")
assert.deepEqual(executed.map((spec) => spec.command), ["wordpress.run-php", "wordpress.run-php"])

console.log("nested fuzz suite recipe command ok")
