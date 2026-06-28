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
    const runPhpCode = action.command === "wordpress.run-php" ? action.args?.[0]?.replace(/^code=/, "") ?? "" : ""
    const commandPayloads: Record<string, Record<string, unknown>> = {
      "wordpress.rest-request": { path: "/wp/v2/types", route: "/wp/v2/types", status: 200, timing: { durationMs: 45 } },
      "wordpress.browser-actions": { url: "/", browser: { metrics: { layoutShift: 3 } }, timing: { durationMs: 90 } },
      "wordpress.db-operation": { metrics: { query_count: 11, query_time_ms: 22 } },
      "wordpress.run-php": runPhpCode.includes("rest-db-query-profiler") ? {
        schema: "wp-codebox/bench-results/v1",
        scenarios: [{
          id: "typed-rest-profile",
          artifacts: {
            "rest-db-query-profile": {
              schema: "wp-codebox/wordpress-rest-db-query-profile/v1",
              cases: [{ case_id: "products", method: "GET", path: "/wc/store/v1/products", summary: { query_count: 9, total_time_ms: 12.5 } }],
            },
          },
        }],
      } : { status: "passed", artifactRefs: [{ name: "php-report", path: "workloads/php-report.json" }] },
      "wordpress.rest-performance-observation": {
        observations: [{ schema: "wp-codebox/performance-observation/v1", command: "wordpress.rest-performance-observation", target: "/wp/v2/types", kind: "rest-request", timing: { durationMs: 120 }, database: { queryCount: 7, totalTimeMs: 34 } }],
      },
    }
    const payload = commandPayloads[action.command] ?? { ok: true }
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
        stdout: JSON.stringify(payload),
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        artifactRefs: [{ kind: "execution", id: `artifact-${index}`, path: `files/execution-${index}.json` }],
        result: { schema: "wp-codebox/runtime-command-result/v1", status: "ok", json: payload },
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
    { id: "php-workload", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", runtime_env: { WC_REST_BATCH_IMPORT_ITEMS: "2" }, settings: { fixtureMode: "small" }, steps: [{ command: "wordpress.run-workload", args: ["type=php", "path=/tmp/wp-codebox-workloads/rest-product-batch-import.php"] }] } },
    { id: "typed-workload", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ type: "rest-db-query-profiler", rest_request_cases: [{ id: "products", method: "GET", path: "/wc/store/v1/products" }] }] }, metadata: { caseMetadata: { intent: { plugin: { activation: "woocommerce/woocommerce.php" } } } } },
  ],
}), { requireCoverage: true })

assert.equal(result.status, "passed")
assert.equal(result.success, true)
assert.equal(result.metadata?.runnerMode, "runtime-backed")
assert.equal(result.metadata?.runtimeBackend, "wordpress-playground")
assert.equal((result.metadata?.runnerCapabilities as { mode?: string } | undefined)?.mode, "runtime-backed")
assert.deepEqual(steps.map((step) => step.command), ["wordpress.rest-request", "wp-codebox.checkpoint-create", "wp-codebox.checkpoint-restore", "wordpress.rest-request", "wp-codebox.checkpoint-restore", "wordpress.browser-actions", "wp-codebox.checkpoint-restore", "wordpress.db-operation", "wp-codebox.checkpoint-restore", "wordpress.rest-performance-observation", "wp-codebox.checkpoint-restore", "wordpress.run-php", "wp-codebox.checkpoint-restore", "wordpress.run-php"])
assert.equal(result.cases[0]?.reset?.status, "passed")
assert.equal(result.cases[0]?.reset?.checkpointName, "fuzz-baseline")
assert.deepEqual(result.cases[0]?.reset?.fixtureRefs, ["fixtures/store.json"])
assert.equal(result.cases[1]?.reset?.status, "passed")
assert.equal(result.cases[2]?.status, "passed")
assert.equal(result.cases[3]?.status, "passed")
assert.equal(result.cases[4]?.status, "passed")
assert.equal(result.cases[5]?.status, "passed")
assert.equal(steps[7]?.args?.[0]?.startsWith("operation-json="), true)
assert.equal(JSON.parse(steps[7]?.args?.[0]?.replace("operation-json=", "") ?? "{}").resource.table, "posts")
assert.deepEqual(steps[9]?.args, ["path=/wp/v2/types", "capture-queries=1"])
assert.equal(steps[11]?.command, "wordpress.run-php")
assert.match(steps[11]?.args?.[0] ?? "", /^code=/)
const nestedPhpInput = decodeFirstWrapperJson(steps[11]?.args?.[0] ?? "")
assert.deepEqual(nestedPhpInput.runtimeEnv, { WC_REST_BATCH_IMPORT_ITEMS: "2" })
assert.deepEqual(nestedPhpInput.runtime_env, { WC_REST_BATCH_IMPORT_ITEMS: "2" })
assert.deepEqual(nestedPhpInput.settings, { fixtureMode: "small" })
assert.equal(result.cases[4]?.artifactRefs?.some((ref) => ref.path === "workloads/php-report.json"), true)
assert.match(steps[13]?.args?.[0] ?? "", /rest-db-query-profiler/)
assert.match(steps[13]?.args?.[0] ?? "", /woocommerce/)
const hotspotsRef = result.artifactRefs.find((ref) => ref.kind === "wordpress-hotspots")
assert.equal(hotspotsRef?.path, "files/wordpress-hotspots.json")
assert.equal(hotspotsRef?.contentType, "application/json")
assert.equal(hotspotsRef?.metadata?.schema, "wp-codebox/wordpress-hotspots/v1")
const homeboyObservationRef = result.artifactRefs.find((ref) => ref.kind === "fuzz-observation-set")
assert.equal(homeboyObservationRef?.path, "files/fuzz-observations.json")
assert.equal(homeboyObservationRef?.metadata?.schema, "homeboy/fuzz-observation-set/v1")
const homeboyHotspotRef = result.artifactRefs.find((ref) => ref.kind === "fuzz-hotspot-set")
assert.equal(homeboyHotspotRef?.path, "files/fuzz-hotspots.json")
assert.equal(homeboyHotspotRef?.metadata?.schema, "homeboy/fuzz-hotspot-set/v1")
const fuzzResultRef = result.artifactRefs.find((ref) => ref.kind === "fuzz-suite-result")
assert.equal(fuzzResultRef?.path, "files/fuzz-result.json")
assert.equal(fuzzResultRef?.metadata?.schema, "wp-codebox/fuzz-suite-result/v1")
const metadataArtifacts = result.metadata?.artifacts as { fuzzResult?: { path?: string }; wordpressHotspots?: { path?: string; hotspots?: unknown[] }; fuzzObservationSet?: { path?: string; observations?: unknown[] }; fuzzHotspotSet?: { path?: string; hotspots?: unknown[] } } | undefined
assert.equal(metadataArtifacts?.fuzzResult?.path, "files/fuzz-result.json")
assert.equal(metadataArtifacts?.wordpressHotspots?.path, "files/wordpress-hotspots.json")
assert.equal(metadataArtifacts?.fuzzObservationSet?.path, "files/fuzz-observations.json")
assert.equal(metadataArtifacts?.fuzzHotspotSet?.path, "files/fuzz-hotspots.json")
assert.equal(Array.isArray(metadataArtifacts?.wordpressHotspots?.hotspots), false)
assert.equal(Array.isArray(metadataArtifacts?.fuzzObservationSet?.observations), false)
assert.equal(Array.isArray(metadataArtifacts?.fuzzHotspotSet?.hotspots), false)

console.log("playground fuzz suite public ok")

function decodeFirstWrapperJson(codeArg: string): Record<string, unknown> {
  const match = codeArg.match(/base64_decode\('([^']+)'\)/)
  assert.ok(match)
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))
}
