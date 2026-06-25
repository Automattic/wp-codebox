import assert from "node:assert/strict"

import { fuzzSuiteContract, type RuntimeEpisodeStepResult } from "../packages/runtime-core/src/public.js"
import { createWordPressFuzzSuiteCommandExecutor, executeWordPressFuzzSuite } from "../packages/runtime-playground/src/public.js"

const steps: Array<{ command: string; args?: string[]; observation?: unknown }> = []
const episode = {
  async reset() {
    return {
      id: "reset-1",
      runtime: { id: "runtime-1", backend: "wordpress-playground", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", environment: { kind: "wordpress", name: "WordPress", version: "6.6" } },
      observations: [],
      observationRefs: [],
    }
  },
  async step(action: { command: string; args?: string[] }, observation?: unknown): Promise<RuntimeEpisodeStepResult> {
    steps.push({ command: action.command, args: action.args, observation })
    const index = steps.length
    return {
      id: `step-${index}`,
      index,
      action: {
        schema: "wp-codebox/runtime-episode-action/v1",
        id: `action-${index}`,
        kind: "command",
        command: action.command,
        args: action.args ?? [],
        digest: { algorithm: "sha256", value: `action-${index}` },
      },
      actionRef: { kind: "action", id: `action-${index}` },
      execution: {
        id: `execution-${index}`,
        command: action.command,
        args: action.args ?? [],
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        artifactRefs: [{ kind: "execution", id: `artifact-${index}`, path: `files/execution-${index}.json` }],
      },
      executionRef: { kind: "execution", id: `execution-${index}` },
    }
  },
}

const commandExecutor = createWordPressFuzzSuiteCommandExecutor(episode)
const execution = await commandExecutor.execute({ command: "wordpress.rest-request", args: ["path=/wp/v2/types"] })
assert.equal(execution.id, "execution-1")
assert.equal(steps[0]?.command, "wordpress.rest-request")
assert.deepEqual(steps[0]?.observation, { type: "command-result" })

const result = await executeWordPressFuzzSuite(episode, fuzzSuiteContract({
  id: "runtime-backed-suite",
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "fuzz-baseline", fixtureRefs: ["fixtures/store.json"] },
  cases: [
    { id: "rest", target: { kind: "rest", id: "/wp/v2/types" }, input: { method: "GET" } },
    { id: "browser", target: { kind: "runtime-action" }, input: { type: "browser", operation: "navigate", url: "/" } },
    { id: "db", target: { kind: "runtime-action" }, input: { type: "db_operation", operation: "inspect", resource: { table: "posts" } } },
    { id: "workload", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.rest-performance-observation", args: ["path=/wp/v2/types", "capture-queries=1"] }] } },
  ],
}), { requireCoverage: true })

assert.equal(result.status, "passed")
assert.equal(result.success, true)
assert.equal(result.metadata?.runnerMode, "runtime-backed")
assert.equal(result.metadata?.runtimeBackend, "wordpress-playground")
assert.equal((result.metadata?.runnerCapabilities as { mode?: string } | undefined)?.mode, "runtime-backed")
assert.deepEqual(steps.map((step) => step.command), ["wordpress.rest-request", "wp-codebox.checkpoint-create", "wp-codebox.checkpoint-restore", "wordpress.rest-request", "wp-codebox.checkpoint-restore", "wordpress.browser-actions", "wp-codebox.checkpoint-restore", "wordpress.db-operation", "wp-codebox.checkpoint-restore", "wordpress.rest-performance-observation"])
assert.equal(result.cases[0]?.reset?.status, "passed")
assert.equal(result.cases[0]?.reset?.checkpointName, "fuzz-baseline")
assert.deepEqual(result.cases[0]?.reset?.fixtureRefs, ["fixtures/store.json"])
assert.equal(result.cases[1]?.reset?.status, "passed")
assert.equal(result.cases[2]?.status, "passed")
assert.equal(result.cases[3]?.status, "passed")
assert.equal(steps[7]?.args?.[0]?.startsWith("operation-json="), true)
assert.equal(JSON.parse(steps[7]?.args?.[0]?.replace("operation-json=", "") ?? "{}").resource.table, "posts")
assert.deepEqual(steps[9]?.args, ["path=/wp/v2/types", "capture-queries=1"])

console.log("playground fuzz suite public ok")
