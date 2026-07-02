import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { fuzzSuiteContract, type RuntimeEpisodeStepResult } from "../packages/runtime-core/src/public.js"
import { createWordPressFuzzSuiteCommandExecutor, executeWordPressFuzzSuite } from "../packages/runtime-playground/src/public.js"

const steps: Array<{ command: string; args?: string[]; observation?: unknown }> = []
const disposableSandboxBoundary = { disposable: true, destructivePermission: true, teardown: "discard", hostAccess: "declared-mounts-only" }
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
    const restMethod = action.args?.find((arg) => arg.startsWith("method="))?.replace(/^method=/, "") ?? "GET"
    const commandPayloads: Record<string, Record<string, unknown>> = {
      "wordpress.rest-request": restMethod === "DELETE" ? { path: "/wp/v2/posts/123", route: "/wp/v2/posts/123", status: 200, timing: { durationMs: 45 }, performance: { database: { queryCount: 3, writeSet: [{ table: "wp_posts", operation: "delete", rowsAffected: 1, rowCountBefore: 1, rowCountAfter: 0, object: { kind: "post", id: 123 }, key: "wp_posts:delete:123" }], repeatedWrites: [], writeSetTruncated: false } } } : { path: "/wp/v2/types", route: "/wp/v2/types", status: 200, timing: { durationMs: 45 }, database: { status: "captured", queryCount: 3, totalTimeMs: 7.5, fingerprints: [{ fingerprint: "select * from wp_posts where id = ?", count: 2, totalTimeMs: 5, caller: "WP_Query->get_posts" }, { fingerprint: "select option_value from wp_options where option_name = ?", count: 1, totalTimeMs: 2.5 }] } },
      "wordpress.browser-actions": { url: "/", browser: { metrics: { layoutShift: 3 } }, timing: { durationMs: 90 } },
      "wordpress.db-operation": { metrics: { query_count: 11, query_time_ms: 22 }, metadata: { dbWriteSet: { schema: "wp-codebox/wordpress-db-write-set/v1", artifactKind: "wordpress-db-write-set", action: "db_operation", target: "wp_fuzz", entries: [{ table: "wp_fuzz", operation: "update", rowsAffected: 1, rowCountBefore: 1, rowCountAfter: 1, resource: { table: "wp_fuzz", identifiers: { id: 1 } }, key: "wp_fuzz:update:1" }], repeatedWrites: [], totals: { writes: 1, rowsAffected: 1, tables: 1, repeatedWriteKeys: 0 } } } },
      "wordpress.crud-operation": { item: { id: 123 }, status: "ok", metadata: { dbWriteSet: { schema: "wp-codebox/wordpress-db-write-set/v1", artifactKind: "wordpress-db-write-set", action: "crud_operation", target: "post:123", entries: [{ table: "wp_posts", operation: "update", rowsAffected: 1, object: { kind: "post", id: 123 }, key: "wp_posts:update:123", repeatedWritesToSameKey: 2 }, { table: "wp_postmeta", operation: "update", rowsAffected: 1, object: { kind: "post", id: 123 }, key: "wp_postmeta:update:123" }], repeatedWrites: [{ table: "wp_posts", operation: "update", rowsAffected: 1, object: { kind: "post", id: 123 }, key: "wp_posts:update:123", repeatedWritesToSameKey: 2 }], totals: { writes: 2, rowsAffected: 2, tables: 2, repeatedWriteKeys: 1 } } } },
      "wordpress.run-php": runPhpCode.includes("wordpress-rollback-capture-request") ? rollbackCapturePayload(runPhpCode) : runPhpCode.includes("marker-only-rest-db-query-profile") ? { status: "passed", artifactRefs: [{ name: "rest-db-query-profile", path: "workloads/rest-db-query-profile.marker.json" }] } : runPhpCode.includes("recipe-run-rest-db-query-profiler") ? {
        schema: "wp-codebox/recipe-run/v1",
        success: true,
        executions: [{ result: { json: { schema: "wp-codebox/bench-results/v1", scenarios: [{ id: "recipe-profile", artifacts: { "rest-db-query-profile": { schema: "wp-codebox/wordpress-rest-db-query-profile/v1", cases: [{ case_id: "recipe-products", method: "GET", path: "/wc/store/v1/products", summary: { query_count: 11, total_time_ms: 14.5 } }] } } }] } } }],
      } : runPhpCode.includes("rest-db-query-profiler") ? {
        schema: "wp-codebox/json-workload-result/v1",
        steps: [{
          type: "rest-db-query-profiler",
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
  metadata: { disposableSandboxBoundary },
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "fuzz-baseline", fixtureRefs: ["fixtures/store.json"] },
  cases: [
    { id: "rest", target: { kind: "rest", id: "/wp/v2/types" }, input: { method: "GET" } },
    { id: "destructive-rest", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/123", bodyJson: { force: true } }, mutation: { intent: "delete", destructive: true, intensity: "high" } },
    { id: "browser", target: { kind: "runtime-action" }, input: { type: "browser", operation: "navigate", url: "/" } },
    { id: "db", target: { kind: "runtime-action" }, input: { type: "db_operation", operation: "inspect", resource: { table: "posts" } } },
    { id: "db-write", target: { kind: "runtime-action" }, input: { type: "db_operation", operation: "write", resource: { table: "wp_fuzz" }, query: { table: "wp_fuzz", sql: "UPDATE wp_fuzz SET value='mutated' WHERE id=1", where: { id: 1 } } }, mutation: { intent: "write", destructive: true } },
    { id: "crud-update", target: { kind: "runtime-action" }, input: { type: "crud_operation", operation: "update", resource: { kind: "post", id: 123 }, data: { post_title: "mutated" } }, mutation: { intent: "write", destructive: true } },
    { id: "workload", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.rest-performance-observation", args: ["path=/wp/v2/types", "capture-queries=1"] }] } },
    { id: "php-workload", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", runtime_env: { WC_REST_BATCH_IMPORT_ITEMS: "2" }, settings: { fixtureMode: "small" }, steps: [{ command: "wordpress.run-workload", args: ["type=php", "path=/tmp/wp-codebox-workloads/rest-product-batch-import.php"] }] } },
    { id: "typed-workload", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ type: "rest-db-query-profiler", rest_request_cases: [{ id: "products", method: "GET", path: "/wc/store/v1/products" }] }] }, metadata: { caseMetadata: { intent: { plugin: { activation: "woocommerce/woocommerce.php" } } } } },
    { id: "profile-collection", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ type: "rest-db-query-profiler", rest_request_cases: [{ id: "products", method: "GET", path: "/wc/store/v1/products" }] }], after: [{ command: "wordpress.collect-workload-result", args: ["artifact=rest_db_query_profile"] }] }, metadata: { caseMetadata: { intent: { plugin: { activation: "woocommerce/woocommerce.php" } } } } },
    { id: "recipe-run-profile", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.run-workload", args: ["type=php", "path=/tmp/recipe-run-rest-db-query-profiler.php"] }] } },
  ],
}), { requireCoverage: true })

assert.equal(result.status, "passed")
assert.equal(result.success, true)
assert.equal(result.metadata?.runnerMode, "runtime-backed")
assert.equal(result.metadata?.runtimeBackend, "wordpress-playground")
assert.equal((result.metadata?.runnerCapabilities as { mode?: string } | undefined)?.mode, "runtime-backed")
assert.equal(steps.some((step) => step.command === "wordpress.crud-operation"), true)
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
assert.equal(result.cases[9]?.status, "passed")
assert.equal(result.cases[10]?.status, "passed")
const restWriteSet = result.cases[1]?.metadata?.dbWriteSet as { schema?: string; entries?: Array<{ table?: string; operation?: string }>; artifactPath?: string } | undefined
assert.equal(restWriteSet?.schema, "wp-codebox/wordpress-db-write-set/v1")
assert.deepEqual(restWriteSet?.entries?.map((entry) => [entry.table, entry.operation]), [["wp_posts", "delete"]])
assert.equal(restWriteSet?.artifactPath, "files/db-write-sets/destructive-rest.json")
const dbWriteSet = result.cases[4]?.metadata?.dbWriteSet as { entries?: Array<{ rowCountBefore?: number; rowCountAfter?: number }>; totals?: { rowsAffected?: number } } | undefined
assert.deepEqual(dbWriteSet?.entries?.[0], { table: "wp_fuzz", operation: "update", rowsAffected: 1, rowCountBefore: 1, rowCountAfter: 1, resource: { table: "wp_fuzz", identifiers: { id: 1 } }, key: "wp_fuzz:update:1" })
assert.equal(dbWriteSet?.totals?.rowsAffected, 1)
const crudWriteSet = result.cases[5]?.metadata?.dbWriteSet as { repeatedWrites?: unknown[]; totals?: { repeatedWriteKeys?: number } } | undefined
assert.equal(crudWriteSet?.repeatedWrites?.length, 1)
assert.equal(crudWriteSet?.totals?.repeatedWriteKeys, 1)
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
const metadataArtifacts = result.metadata?.artifacts as { fuzzResult?: { persisted?: boolean; metadata?: { schema?: string } }; wordpressHotspots?: { persisted?: boolean; metadata?: { schema?: string } }; fuzzObservationSet?: { persisted?: boolean; metadata?: { schema?: string } }; fuzzHotspotSet?: { persisted?: boolean; metadata?: { schema?: string } }; queryObservations?: { persisted?: boolean; count?: number; metadata?: { schema?: string }; observations?: Array<{ caseId?: string; queryCount?: number }> } } | undefined
assert.equal(metadataArtifacts?.fuzzResult?.persisted, false)
assert.equal(metadataArtifacts?.wordpressHotspots?.metadata?.schema, "wp-codebox/wordpress-hotspots/v1")
assert.equal(metadataArtifacts?.fuzzObservationSet?.metadata?.schema, "wp-codebox/fuzz-observation-set/v1")
assert.equal(metadataArtifacts?.fuzzHotspotSet?.metadata?.schema, "wp-codebox/fuzz-hotspot-set/v1")
assert.equal(metadataArtifacts?.queryObservations?.persisted, false)
assert.equal(metadataArtifacts?.queryObservations?.metadata?.schema, "wp-codebox/query-observation/v1")
assert.equal(metadataArtifacts?.queryObservations?.observations?.some((item) => item.caseId === "rest" && item.queryCount === 3), true)
assert.equal(metadataArtifacts?.queryObservations?.observations?.some((item) => item.caseId === "typed-workload" && item.queryCount === 9), true)
assert.equal(metadataArtifacts?.queryObservations?.observations?.some((item) => item.caseId === "profile-collection" && item.queryCount === 9), true)
assert.equal(metadataArtifacts?.queryObservations?.observations?.some((item) => item.caseId === "recipe-run-profile" && item.queryCount === 11), true)
assert.equal(Array.isArray(metadataArtifacts?.wordpressHotspots?.hotspots), false)
assert.equal(Array.isArray(metadataArtifacts?.fuzzObservationSet?.observations), false)
assert.equal(Array.isArray(metadataArtifacts?.fuzzHotspotSet?.hotspots), false)

const missingProfilePayload = await executeWordPressFuzzSuite(episode, fuzzSuiteContract({
  id: "runtime-backed-missing-profile-payload",
  metadata: { disposableSandboxBoundary },
  cases: [{ id: "marker-only-profile", target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" }, input: { schema: "wp-codebox/wordpress-workload-run/v1", steps: [{ command: "wordpress.run-workload", args: ["type=php", "path=/tmp/marker-only-rest-db-query-profile.php"] }], after: [{ command: "wordpress.collect-workload-result", args: ["artifact=rest-db-query-profile"] }] } }],
}), { requireCoverage: true })
assert.equal(missingProfilePayload.status, "failed")
assert.equal(missingProfilePayload.cases[0]?.status, "failed")

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-fuzz-artifacts-"))
try {
  const durableResult = await executeWordPressFuzzSuite(episode, fuzzSuiteContract({
    id: "runtime-backed-durable-suite",
    metadata: { disposableSandboxBoundary: { disposable: true, destructivePermission: true, teardown: "discard", hostAccess: "declared-mounts-only" } },
    cases: [{ id: "durable-rest", target: { kind: "rest", id: "/wp/v2/types" }, input: { method: "GET" } }, { id: "durable-delete", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/123" }, mutation: { intent: "delete", destructive: true } }],
  }), { artifactStorage: { root: artifactRoot }, requireCoverage: true })
  const durableArtifacts = durableResult.metadata?.artifacts as {
    fuzzBundle?: { schema?: string; resultRef?: { path?: string }; caseResultStreamRef?: { path?: string }; replayCaseRefs?: Array<{ caseId?: string; path?: string }>; hotspotRefs?: Array<{ path?: string }>; artifactRefs?: Array<{ path?: string; kind?: string }>; minimize?: { status?: string; inputKind?: string; operation?: string; reason?: string; metadata?: Record<string, unknown> } }
    fuzzResult?: { persisted?: boolean; path?: string }
    wordpressHotspots?: { persisted?: boolean; path?: string }
    queryObservations?: { persisted?: boolean; count?: number; observations?: Array<{ ref?: { path?: string }; caseId?: string; queryCount?: number }> }
  } | undefined
  assert.equal(durableArtifacts?.fuzzBundle?.schema, "wp-codebox/fuzz-artifact-bundle/v1")
  assert.equal(durableArtifacts?.fuzzBundle?.minimize?.status, "supported")
  assert.equal(durableArtifacts?.fuzzBundle?.minimize?.inputKind, "fuzz-replay-case")
  assert.equal(durableArtifacts?.fuzzBundle?.minimize?.operation, "fuzz-minimize-case")
  assert.equal(durableArtifacts?.fuzzBundle?.minimize?.metadata?.supportedReplayShape, "runtime-action sequence replay")
  assert.equal(durableArtifacts?.fuzzResult?.persisted, true)
  assert.equal(durableArtifacts?.wordpressHotspots?.persisted, true)
  assert.equal(durableArtifacts?.queryObservations?.persisted, true)
  assert.equal(durableArtifacts?.queryObservations?.count, 1)
  assert.equal(durableArtifacts?.fuzzBundle?.replayCaseRefs?.[0]?.caseId, "durable-rest")

  const resultArtifact = JSON.parse(await readFile(join(artifactRoot, durableArtifacts?.fuzzBundle?.resultRef?.path ?? ""), "utf8"))
  const replayArtifact = JSON.parse(await readFile(join(artifactRoot, durableArtifacts?.fuzzBundle?.replayCaseRefs?.[0]?.path ?? ""), "utf8"))
  const caseStream = await readFile(join(artifactRoot, durableArtifacts?.fuzzBundle?.caseResultStreamRef?.path ?? ""), "utf8")
  const hotspotArtifact = JSON.parse(await readFile(join(artifactRoot, durableArtifacts?.fuzzBundle?.hotspotRefs?.[0]?.path ?? ""), "utf8"))
  const durableWriteSetPath = durableResult.cases[1]?.artifactRefs?.find((ref) => ref.kind === "wordpress-db-write-set")?.path
  assert.ok(durableWriteSetPath)
  const durableWriteSet = JSON.parse(await readFile(join(artifactRoot, durableWriteSetPath), "utf8"))
  const queryObservationArtifact = JSON.parse(await readFile(join(artifactRoot, durableArtifacts?.queryObservations?.observations?.[0]?.ref?.path ?? ""), "utf8"))
  assert.equal(resultArtifact.schema, "wp-codebox/fuzz-suite-result/v1")
  assert.equal(replayArtifact.schema, "wp-codebox/fuzz-replay-case-input/v1")
  assert.equal(replayArtifact.case.id, "durable-rest")
  assert.equal(JSON.parse(caseStream.trim().split("\n")[0] ?? "{}").id, "durable-rest")
  assert.equal(hotspotArtifact.schema, "wp-codebox/wordpress-hotspots/v1")
  assert.equal(durableWriteSet.schema, "wp-codebox/wordpress-db-write-set/v1")
  assert.equal(durableWriteSet.entries[0].operation, "delete")
  assert.equal(queryObservationArtifact.schema, "wp-codebox/query-observation/v1")
  assert.equal(queryObservationArtifact.caseId, "durable-rest")
  assert.equal(queryObservationArtifact.queryCount, 3)
  assert.equal(queryObservationArtifact.duplicateGroups[0]?.count, 2)
  assert.equal(queryObservationArtifact.tables.some((table: { name?: string }) => table.name === "wp_posts"), true)
} finally {
  await rm(artifactRoot, { recursive: true, force: true })
}

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
  cases: [{ id: "destructive-rest-restore-failure", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/123", bodyJson: { force: true } }, mutation: { intent: "delete", destructive: true, intensity: "high" } }],
}), { requireCoverage: true })
assert.equal(restoreFailureResult.status, "passed")
assert.deepEqual(restoreFailureResult.cases[0]?.diagnostics, [])

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
