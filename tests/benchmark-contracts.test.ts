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
const routeDefinition = (schema.$defs as Record<string, { anyOf?: unknown; properties?: Record<string, unknown> }>).restRouteMatrixEntry

assert.ok(routeMatrixDefinition.workloads[0].route_matrix?.[0].path)
assert.ok(workloadDefinition.properties?.route_matrix, "benchmark definition schema should expose workload route_matrix")
assert.ok(routeDefinition.properties?.["capture-response"], "route_matrix entries should expose REST response capture")
assert.deepEqual(routeDefinition.anyOf, [{ required: ["path"] }, { required: ["route"] }])

await withTempDir("wp-codebox-route-matrix-artifacts-", async (directory) => {
  await mkdir(join(directory, "files"), { recursive: true })
  const manifestPath = join(directory, "manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    id: "artifact-bundle",
    contentDigest: { algorithm: "sha256", inputs: [], value: "0".repeat(64) },
    createdAt: "2026-01-01T00:00:00.000Z",
    runtime: { id: "runtime", backend: "test" },
    files: [],
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

  const benchArtifacts = JSON.parse(await readFile(join(directory, "files", "bench-results.json"), "utf8")) as { scenarios: Array<{ artifactRefs: Array<{ kind: string; name: string; path: string; contentType?: string; sha256?: string; source?: string }> }> }
  assert.doesNotMatch(JSON.stringify(benchArtifacts), /not persisted/)
  assert.deepEqual(benchArtifacts.scenarios[0].artifactRefs[0], {
    path: "files/bench/generic-api/rest-catalog-route-matrix-summary.json",
    kind: "benchmark-route-matrix-summary",
    contentType: "application/json",
    sha256: benchArtifacts.scenarios[0].artifactRefs[0].sha256,
    source: "scenario-artifact",
    name: "route-matrix-summary",
  })
})

console.log("benchmark contracts ok")
