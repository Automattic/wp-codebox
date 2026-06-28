import assert from "node:assert/strict"

import { fuzzSuiteContract, type RuntimeEpisodeStepResult } from "../packages/runtime-core/src/public.js"
import { createWordPressFuzzSuiteCommandExecutor, executeWordPressFuzzSuite } from "../packages/runtime-playground/src/public.js"

const steps: Array<{ command: string; args?: string[]; observation?: unknown }> = []
let checkpointState: Record<string, unknown> | undefined
let runtimeState = wordpressState("baseline")
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
    if (action.command === "wp-codebox.checkpoint-create") {
      checkpointState = structuredClone(runtimeState)
    }
    if (action.command === "wp-codebox.checkpoint-restore" && checkpointState) {
      runtimeState = structuredClone(checkpointState) as typeof runtimeState
    }
    if (action.command === "wordpress.rest-request" && action.args?.some((arg) => arg === "method=DELETE")) {
      runtimeState.objects["post:123"] = { exists: false }
      runtimeState.tables.wp_posts = { rows: [], row_count: 0 }
    }
    if (action.command === "wordpress.db-operation") {
      const operation = operationJson(action.args)
      if (operation.operation === "write") {
        runtimeState.tables[operation.query?.table ?? operation.resource?.table ?? "wp_fuzz"] = { rows: [{ id: 1, value: "mutated" }], row_count: 1 }
      }
    }
    if (action.command === "wordpress.crud-operation") {
      const operation = operationJson(action.args)
      if (operation.operation === "update") {
        runtimeState.objects[`post:${operation.resource?.id}`] = { exists: true, value: { ID: operation.resource?.id, post_title: operation.data?.post_title ?? "mutated" }, meta: [] }
      }
    }
    const commandPayloads: Record<string, Record<string, unknown>> = {
      "wordpress.rest-request": { path: "/wp/v2/types", route: "/wp/v2/types", status: 200, timing: { durationMs: 45 } },
      "wordpress.browser-actions": { url: "/", browser: { metrics: { layoutShift: 3 } }, timing: { durationMs: 90 } },
      "wordpress.db-operation": { metrics: { query_count: 11, query_time_ms: 22 } },
      "wordpress.crud-operation": { item: { id: 123 }, status: "ok" },
      "wordpress.run-php": runPhpCode.includes("wordpress-rollback-capture-request") ? rollbackCapturePayload(runPhpCode) : runPhpCode.includes("rest-db-query-profiler") ? {
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
    { id: "destructive-rest", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/123", bodyJson: { force: true } }, mutation: { intent: "delete", destructive: true, intensity: "high", resetRequired: true } },
    { id: "browser", target: { kind: "runtime-action" }, input: { type: "browser", operation: "navigate", url: "/" } },
    { id: "db", target: { kind: "runtime-action" }, input: { type: "db_operation", operation: "inspect", resource: { table: "posts" } } },
    { id: "db-write", target: { kind: "runtime-action" }, input: { type: "db_operation", operation: "write", resource: { table: "wp_fuzz" }, query: { table: "wp_fuzz", sql: "UPDATE wp_fuzz SET value='mutated' WHERE id=1", where: { id: 1 } } }, mutation: { intent: "write", destructive: true, resetRequired: true } },
    { id: "crud-update", target: { kind: "runtime-action" }, input: { type: "crud_operation", operation: "update", resource: { kind: "post", id: 123 }, data: { post_title: "mutated" } }, mutation: { intent: "write", destructive: true, resetRequired: true } },
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
assert.equal(steps.some((step) => step.command === "wordpress.crud-operation"), true)
assert.equal(steps.filter((step) => step.command === "wordpress.run-php" && step.args?.[0]?.includes("wordpress-rollback-capture-request")).length >= 9, true)
assert.equal(result.cases[0]?.reset?.status, "passed")
assert.equal(result.cases[0]?.reset?.checkpointName, "fuzz-baseline")
assert.deepEqual(result.cases[0]?.reset?.fixtureRefs, ["fixtures/store.json"])
assert.equal(result.cases[1]?.reset?.status, "passed")
assert.equal(result.cases[2]?.status, "passed")
assert.equal(result.cases[3]?.status, "passed")
assert.equal(result.cases[4]?.status, "passed")
assert.equal(result.cases[5]?.status, "passed")
assert.equal(result.cases[6]?.status, "passed")
assert.equal(result.cases[7]?.status, "passed")
assert.equal(result.cases[8]?.status, "passed")
const rollbackArtifact = result.cases[4]?.metadata?.mutationIsolation as { rollback?: { result?: { status?: string }; diff?: { tables?: unknown[] } } } | undefined
assert.equal(rollbackArtifact?.rollback?.result?.status, "passed")
assert.equal(Array.isArray(rollbackArtifact?.rollback?.diff?.tables), true)
const nestedPhpStep = steps.find((step) => step.command === "wordpress.run-php" && step.args?.[0]?.includes("__wp_codebox_workload_input"))
assert.ok(nestedPhpStep)
const nestedPhpInput = decodeFirstWrapperJson(nestedPhpStep.args?.[0] ?? "")
assert.deepEqual(nestedPhpInput.runtimeEnv, { WC_REST_BATCH_IMPORT_ITEMS: "2" })
assert.deepEqual(nestedPhpInput.runtime_env, { WC_REST_BATCH_IMPORT_ITEMS: "2" })
assert.deepEqual(nestedPhpInput.settings, { fixtureMode: "small" })
assert.equal(result.cases[7]?.artifactRefs?.some((ref) => ref.path === "workloads/php-report.json"), true)
assert.equal(steps.some((step) => step.args?.[0]?.includes("rest-db-query-profiler")), true)
assert.equal(steps.some((step) => step.args?.[0]?.includes("woocommerce")), true)
assert.equal(result.artifactRefs.some((ref) => ["wordpress-hotspots", "fuzz-observation-set", "fuzz-hotspot-set", "fuzz-suite-result"].includes(ref.kind)), false)
const metadataArtifacts = result.metadata?.artifacts as { fuzzResult?: { persisted?: boolean; metadata?: { schema?: string } }; wordpressHotspots?: { persisted?: boolean; metadata?: { schema?: string } }; fuzzObservationSet?: { persisted?: boolean; metadata?: { schema?: string } }; fuzzHotspotSet?: { persisted?: boolean; metadata?: { schema?: string } } } | undefined
assert.equal(metadataArtifacts?.fuzzResult?.persisted, false)
assert.equal(metadataArtifacts?.wordpressHotspots?.metadata?.schema, "wp-codebox/wordpress-hotspots/v1")
assert.equal(metadataArtifacts?.fuzzObservationSet?.metadata?.schema, "wp-codebox/fuzz-observation-set/v1")
assert.equal(metadataArtifacts?.fuzzHotspotSet?.metadata?.schema, "wp-codebox/fuzz-hotspot-set/v1")
assert.equal(Array.isArray(metadataArtifacts?.wordpressHotspots?.hotspots), false)
assert.equal(Array.isArray(metadataArtifacts?.fuzzObservationSet?.observations), false)
assert.equal(Array.isArray(metadataArtifacts?.fuzzHotspotSet?.hotspots), false)

const phaseSteps: Array<{ command: string; args?: string[]; metadata?: Record<string, unknown> }> = []
const phaseEpisode = {
  async reset() {
    return episode.reset()
  },
  async step(action: { command: string; args?: string[]; metadata?: Record<string, unknown> }, observation?: unknown): Promise<RuntimeEpisodeStepResult> {
    phaseSteps.push({ command: action.command, args: action.args, metadata: action.metadata })
    const index = phaseSteps.length
    return {
      id: `phase-step-${index}`,
      index,
      action: {
        schema: "wp-codebox/runtime-episode-action/v1",
        id: `phase-action-${index}`,
        kind: "command",
        command: action.command,
        args: action.args ?? [],
        metadata: action.metadata,
        digest: { algorithm: "sha256", value: `phase-action-${index}` },
      },
      actionRef: { kind: "action", id: `phase-action-${index}` },
      execution: {
        id: `phase-execution-${index}`,
        command: action.command,
        args: action.args ?? [],
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, phase: action.metadata?.phase }),
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        result: { schema: "wp-codebox/runtime-command-result/v1", status: "ok", json: { ok: true, phase: action.metadata?.phase } },
      },
      executionRef: { kind: "execution", id: `phase-execution-${index}` },
    }
  },
}
const phaseResult = await executeWordPressFuzzSuite(phaseEpisode, fuzzSuiteContract({
  id: "runtime-backed-phase-suite",
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "phase-baseline" },
  cases: [{
    id: "phase-workload",
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: { stagedFiles: [{ source: "bench/example.php", target: "/tmp/wp-codebox-workloads/example.php" }] },
    phases: {
      setup: [{ command: "wordpress.wp-cli", args: ["command=plugin list"] }],
      action: [{ command: "wordpress.run-workload", args: ["type=php", "path=${package.root}/bench/example.php"] }],
      assert: [{ command: "wordpress.rest-request", args: ["path=/wp/v2/types", "method=GET"] }],
      teardown: [{ command: "wordpress.wp-cli", args: ["command=cache flush"] }],
    },
  }],
}), { requireCoverage: true })
assert.equal(phaseResult.status, "passed")
const executedPhaseSteps = phaseSteps.filter((step) => step.metadata?.phase)
assert.deepEqual(executedPhaseSteps.map((step) => [step.metadata?.phase, step.command]), [["setup", "wordpress.wp-cli"], ["action", "wordpress.run-php"], ["assert", "wordpress.rest-request"], ["teardown", "wordpress.wp-cli"]])
assert.match(executedPhaseSteps[1]?.args?.[0] ?? "", /^code=/)
assert.equal(decodeFirstWrapperJson(executedPhaseSteps[1]?.args?.[0] ?? "").stagedFiles instanceof Array, true)
assert.deepEqual((phaseResult.cases[0]?.metadata?.execution as { result?: { json?: { phases?: Array<{ phase?: string; command?: string }> } } } | undefined)?.result?.json?.phases?.map((phase) => [phase.phase, phase.command]), [["setup", "wordpress.wp-cli"], ["action", "wordpress.run-php"], ["assert", "wordpress.rest-request"], ["teardown", "wordpress.wp-cli"]])

let restoreCount = 0
const restoreFailureEpisode = {
  async reset() {
    return episode.reset()
  },
  async step(action: { command: string; args?: string[] }, observation?: unknown): Promise<RuntimeEpisodeStepResult> {
    const result = await episode.step(action, observation)
    if (action.command === "wp-codebox.checkpoint-restore") {
      restoreCount += 1
      if (restoreCount === 2) {
        result.execution.exitCode = 1
        result.execution.stderr = "restore failed"
      }
    }
    return result
  },
}
const restoreFailureResult = await executeWordPressFuzzSuite(restoreFailureEpisode, fuzzSuiteContract({
  id: "runtime-backed-restore-failure-suite",
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "restore-failure-baseline" },
  cases: [{ id: "destructive-rest-restore-failure", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/123", bodyJson: { force: true } }, mutation: { intent: "delete", destructive: true, intensity: "high", resetRequired: true } }],
}), { requireCoverage: true })
assert.equal(restoreFailureResult.status, "failed")
assert.equal(restoreFailureResult.cases[0]?.diagnostics[0]?.code, "fuzz_suite_runtime_action_restore_failed")

console.log("playground fuzz suite public ok")

function decodeFirstWrapperJson(codeArg: string): Record<string, unknown> {
  const match = codeArg.match(/base64_decode\('([^']+)'\)/)
  assert.ok(match)
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))
}

function operationJson(args: string[] | undefined): Record<string, any> {
  return JSON.parse(args?.find((arg) => arg.startsWith("operation-json="))?.replace(/^operation-json=/, "") ?? "{}")
}

function wordpressState(label: string) {
  return {
    options: { blogname: { exists: true, value: label } },
    tables: {
      wp_posts: { rows: [{ ID: 123, post_title: label }], row_count: 1 },
      wp_fuzz: { rows: [{ id: 1, value: label }], row_count: 1 },
    },
    objects: { "post:123": { exists: true, value: { ID: 123, post_title: label }, meta: [] } },
  }
}

function rollbackCapturePayload(code: string): Record<string, unknown> {
  const spec = decodeFirstWrapperJson(code)
  const requestedOptions = new Set((spec.options as string[] | undefined) ?? [])
  const requestedTables = new Set(((spec.tables as Array<{ table?: string }> | undefined) ?? []).map((table) => table.table).filter(Boolean))
  const requestedObjects = new Set(((spec.objects as Array<{ kind?: string; id?: string | number }> | undefined) ?? []).map((object) => `${object.kind}:${object.id ?? "unknown"}`))
  return {
    schema: "wp-codebox/wordpress-rollback-capture/v1",
    phase: spec.phase,
    target: spec.target,
    options: Object.fromEntries(Object.entries(runtimeState.options).filter(([key]) => requestedOptions.has(key))),
    tables: Object.fromEntries(Object.entries(runtimeState.tables).filter(([key]) => requestedTables.has(key))),
    objects: Object.fromEntries(Object.entries(runtimeState.objects).filter(([key]) => requestedObjects.has(key))),
    diagnostics: [],
  }
}
