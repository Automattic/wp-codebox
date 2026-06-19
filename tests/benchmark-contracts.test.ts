import assert from "node:assert/strict"

import { createBenchmarkDefinitionJsonSchema, type BenchmarkDefinition } from "../packages/runtime-core/src/benchmark-contracts.js"

const routeMatrixDefinition = {
  schema: "wp-codebox/benchmark-definition/v1",
  component_id: "woocommerce-api",
  plugin_slug: "woocommerce",
  workloads: [
    {
      id: "rest-catalog",
      source: "config",
      route_matrix: [
        {
          id: "products-list",
          method: "GET",
          path: "/wc/v3/products",
          params: { per_page: 10 },
          "capture-response": true,
          "metric-prefix": "rest_products_list",
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

console.log("benchmark contracts ok")
