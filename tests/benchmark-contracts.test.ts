import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { writeBenchmarkArtifactEvidence } from "../packages/cli/src/commands/recipe-run-benchmark-artifacts.js"
import { createBenchmarkDefinitionJsonSchema, type BenchmarkDefinition, type BenchResults } from "../packages/runtime-core/src/benchmark-contracts.js"
import { withTempDir } from "../scripts/test-kit.js"

const routeMatrixDefinition = {
  schema: "wp-codebox/benchmark-definition/v1",
  component_id: "generic-api",
  plugin_slug: "generic-api",
  workloads: [
    {
      id: "rest-catalog",
      source: "config",
      route_matrix: [
        {
          id: "items-list",
          method: "GET",
          path: "/example/v1/items",
          params: { per_page: 10 },
          "capture-response": true,
          "metric-prefix": "rest_items_list",
        },
      ],
      rest_request_cases: [
        {
          id: "items-search",
          method: "GET",
          path: "/example/v1/items",
          params: { search: "hat" },
          "capture-response": true,
        },
      ],
      artifacts: {
        "route-summary": {
          path: "bench/rest-route-summary.json",
          kind: "json",
          source: "scenario-artifact",
        },
      },
    },
  ],
} satisfies BenchmarkDefinition

const schema = createBenchmarkDefinitionJsonSchema()
const workloadDefinition = (schema.$defs as Record<string, { properties?: Record<string, unknown> }>).workload
const workloadStepDefinition = (schema.$defs as Record<string, { properties?: Record<string, unknown> }>).workloadStep
const routeDefinition = (schema.$defs as Record<string, { anyOf?: unknown; properties?: Record<string, unknown> }>).restRouteMatrixEntry
const restCaseDefinition = (schema.$defs as Record<string, { anyOf?: unknown; properties?: Record<string, unknown> }>).restRequestCaseEntry

assert.ok(routeMatrixDefinition.workloads[0].route_matrix?.[0].path)
assert.ok(workloadDefinition.properties?.route_matrix, "benchmark definition schema should expose workload route_matrix")
assert.ok(workloadDefinition.properties?.rest_request_cases, "benchmark definition schema should expose workload rest_request_cases")
assert.ok(workloadDefinition.properties?.request_cases, "benchmark definition schema should expose workload request_cases")
assert.ok(routeDefinition.properties?.["capture-response"], "route_matrix entries should expose REST response capture")
assert.ok(restCaseDefinition.properties?.case_id, "REST request case entries should expose case_id")
assert.ok(workloadStepDefinition.properties?.helperPath, "workload steps should expose artifact-postprocess helperPath")
assert.ok(workloadStepDefinition.properties?.inputArtifactRoot, "workload steps should expose artifact-postprocess inputArtifactRoot")
assert.ok(workloadStepDefinition.properties?.outputArtifactPath, "workload steps should expose artifact-postprocess outputArtifactPath")
assert.ok(workloadStepDefinition.properties?.expectedOutputSchema, "workload steps should expose artifact-postprocess expectedOutputSchema")
assert.deepEqual(routeDefinition.anyOf, [{ required: ["path"] }, { required: ["route"] }])
assert.deepEqual(restCaseDefinition.anyOf, [{ required: ["path"] }, { required: ["route"] }])

await withTempDir("wp-codebox-route-matrix-artifacts-", async (directory) => {
  await mkdir(join(directory, "files"), { recursive: true })
  await mkdir(join(directory, "files", "browser"), { recursive: true })
  await writeFile(join(directory, "files", "browser", "request-coverage.json"), JSON.stringify({
    schema: "wp-codebox/browser-request-coverage/v1",
    totals: { requests: 2 },
  }))
  const manifestPath = join(directory, "manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    id: "artifact-bundle",
    contentDigest: { algorithm: "sha256", inputs: [], value: "0".repeat(64) },
    createdAt: "2026-01-01T00:00:00.000Z",
    runtime: { id: "runtime", backend: "test" },
    files: [{ path: "files/browser/request-coverage.json", kind: "browser-request-coverage", contentType: "application/json" }],
  }))
  const result: BenchResults = {
    schema: "wp-codebox/bench-results/v1",
    component_id: "generic-api",
    iterations: 1,
    warmup_iterations: 0,
    scenarios: [{
      id: "rest-catalog",
      source: "config",
      iterations: 1,
      metrics: {},
      diagnostics: [],
      artifacts: {
        "db-inventory": {
          schema: "wp-codebox/wordpress-db-inventory/v1",
          tables: [{ name: "wp_posts", rowCount: 2, columns: [{ name: "ID", type: "bigint" }], indexes: [{ name: "PRIMARY", column: "ID", unique: true }] }],
          totals: { tableCount: 1, rowCount: 2, columnCount: 1, indexCount: 1, totalBytes: 512 },
        },
        "external-http-guardrail": {
          schema: "wp-codebox/wordpress-external-http-guardrail/v1",
          summary: { event_count: 2, allowed_count: 1, blocked_count: 1, hosts: [{ host: "example.test", count: 2 }] },
          events: [],
        },
        "rest-db-query-profile": {
          schema: "wp-codebox/wordpress-rest-db-query-profile/v1",
          summary: { case_count: 1, query_count: 1, total_time_ms: 2.5, sample_limit: 1, query_length_limit: 500 },
          cases: [{ case_id: "items-search", method: "GET", path: "/example/v1/items", summary: { query_count: 1, total_time_ms: 2.5, operations: [{ operation: "SELECT", count: 1, time_ms: 2.5 }] }, samples: [{ sql: "SELECT * FROM wp_posts WHERE post_title = '?'", time_ms: 2.5, caller: "wpdb->get_results" }] }],
        },
      },
      steps: [{
        schema: "wp-codebox/bench-command-step/v1",
        type: "rest-request",
        route_matrix_index: 0,
        route_id: "list",
        method: "GET",
        path: "/example/v1/items",
        route: "/example/v1/items",
        status: 200,
        timing: { duration_ms: 12.5 },
        response: [{ id: 123, secret: "not persisted" }],
      }, {
        schema: "wp-codebox/bench-command-step/v1",
        type: "rest-request",
        rest_request_case_index: 0,
        case_id: "items-search",
        method: "GET",
        path: "/example/v1/items",
        route: "/example/v1/items",
        status: 200,
        timing: { duration_ms: 15.5 },
        response: { id: 456, secret: "also not persisted" },
      }],
    }],
    diagnostics: [],
    provenance: {
      command: "wordpress.bench",
      component: { id: "generic-api", plugin_slug: "generic-api" },
      definition: routeMatrixDefinition,
    },
  }

  await writeBenchmarkArtifactEvidence({ id: "artifact-bundle", directory, contentDigest: "digest", manifestPath } as Parameters<typeof writeBenchmarkArtifactEvidence>[0], [result])
  const summary = JSON.parse(await readFile(join(directory, "files", "bench", "generic-api", "rest-catalog-route-matrix-summary.json"), "utf8")) as { routes: Array<{ response?: { bytes: number; shape: unknown } }> }
  assert.equal(summary.routes[0].response?.bytes, Buffer.byteLength(JSON.stringify([{ id: 123, secret: "not persisted" }]), "utf8"))
  assert.deepEqual(summary.routes[0].response?.shape, { type: "array", length: 1, items: { type: "object", keys: { id: "number", secret: "string" } } })
  assert.doesNotMatch(JSON.stringify(summary), /not persisted/)

  const caseSummary = JSON.parse(await readFile(join(directory, "files", "bench", "generic-api", "rest-catalog-rest-request-case-summary.json"), "utf8")) as { schema: string; cases: Array<{ caseId?: string; response?: { bytes: number; shape: unknown } }> }
  assert.equal(caseSummary.schema, "wp-codebox/benchmark-rest-request-case-summary/v1")
  assert.equal(caseSummary.cases[0].caseId, "items-search")
  assert.deepEqual(caseSummary.cases[0].response?.shape, { type: "object", keys: { id: "number", secret: "string" } })
  assert.doesNotMatch(JSON.stringify(caseSummary), /also not persisted/)

  const dbInventory = JSON.parse(await readFile(join(directory, "files", "bench", "generic-api", "rest-catalog-db-inventory.json"), "utf8")) as { schema: string; inventory: { totals: { tableCount: number } } }
  assert.equal(dbInventory.schema, "wp-codebox/benchmark-db-inventory/v1")
  assert.equal(dbInventory.inventory.totals.tableCount, 1)

  const externalHttpGuardrail = JSON.parse(await readFile(join(directory, "files", "bench", "generic-api", "rest-catalog-external-http-guardrail.json"), "utf8")) as { schema: string; guardrail: { summary: { blocked_count: number } } }
  assert.equal(externalHttpGuardrail.schema, "wp-codebox/benchmark-external-http-guardrail/v1")
  assert.equal(externalHttpGuardrail.guardrail.summary.blocked_count, 1)

  const restDbQueryProfile = JSON.parse(await readFile(join(directory, "files", "bench", "generic-api", "rest-catalog-rest-db-query-profile.json"), "utf8")) as { schema: string; profile: { summary: { query_count: number } } }
  assert.equal(restDbQueryProfile.schema, "wp-codebox/benchmark-rest-db-query-profile/v1")
  assert.equal(restDbQueryProfile.profile.summary.query_count, 1)

  const benchArtifacts = JSON.parse(await readFile(join(directory, "files", "bench-results.json"), "utf8")) as { scenarios: Array<{ artifactRefs: Array<{ kind: string; name: string; path: string; contentType?: string; sha256?: string; source?: string }> }> }
  assert.doesNotMatch(JSON.stringify(benchArtifacts), /not persisted/)
  assert.deepEqual(benchArtifacts.scenarios[0].artifactRefs.map((ref) => ({ ...ref, sha256: "sha" })), [{
    path: "files/bench/generic-api/rest-catalog-db-inventory.json",
    kind: "benchmark-db-inventory",
    contentType: "application/json",
    sha256: "sha",
    source: "scenario-artifact",
    name: "db-inventory",
  }, {
    path: "files/bench/generic-api/rest-catalog-external-http-guardrail.json",
    kind: "benchmark-external-http-guardrail",
    contentType: "application/json",
    sha256: "sha",
    source: "scenario-artifact",
    name: "external-http-guardrail",
  }, {
    path: "files/bench/generic-api/rest-catalog-rest-db-query-profile.json",
    kind: "benchmark-rest-db-query-profile",
    contentType: "application/json",
    sha256: "sha",
    source: "scenario-artifact",
    name: "rest-db-query-profile",
  }, {
    path: "files/bench/generic-api/rest-catalog-route-matrix-summary.json",
    kind: "benchmark-route-matrix-summary",
    contentType: "application/json",
    sha256: "sha",
    source: "scenario-artifact",
    name: "route-matrix-summary",
  }, {
    path: "files/bench/generic-api/rest-catalog-rest-request-case-summary.json",
    kind: "benchmark-rest-request-case-summary",
    contentType: "application/json",
    sha256: "sha",
    source: "scenario-artifact",
    name: "rest-request-case-summary",
  }, {
    path: "files/browser/request-coverage.json",
    kind: "browser-request-coverage",
    contentType: "application/json",
    sha256: "sha",
    source: "browser-artifact",
  }])
})

console.log("benchmark contracts ok")
