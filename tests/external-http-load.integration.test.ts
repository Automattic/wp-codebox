import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { withTempDir } from "../scripts/test-kit.js"

const execute = promisify(execFile)

await withTempDir("wp-codebox-external-http-load-integration-", async (artifactRoot) => {
  const workload = [{
    id: "external-load",
    run: [{
      type: "external-http-load",
      url: "/",
      requestCount: 4,
      concurrency: 2,
      expectedStatuses: [200],
    }],
  }]
  const { stdout } = await execute(process.execPath, [
    "packages/cli/dist/index.js",
    "run",
    "--mount", "tests/fixtures/fuzz-relative-plugin:/wordpress/wp-content/plugins/fuzz-relative-plugin",
    "--command", "wordpress.bench",
    "--arg", "plugin-slug=fuzz-relative-plugin",
    "--arg", "iterations=1",
    "--arg", "warmup=0",
    "--arg", `workloads-json=${JSON.stringify(workload)}`,
    "--artifacts", artifactRoot,
    "--json",
  ], {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
  })

  const command = JSON.parse(stdout) as {
    success: boolean
    execution: {
      result: {
        json: {
          schema: string
          provenance: { definition: { workloads: typeof workload } }
          scenarios: Array<{
            metrics: Record<string, { samples: { mean: number } }>
            artifacts: Record<string, {
              schema: string
              completedCount: number
              successCount: number
              failureCount: number
              maxObservedConcurrency: number
              provenance: { source: string; transport: string; runtimeScope: string }
            }>
          }>
        }
      }
    }
  }
  assert.equal(command.success, true)
  const results = command.execution.result.json
  assert.equal(results.schema, "wp-codebox/bench-results/v1")
  assert.deepEqual(results.provenance.definition.workloads, workload)
  const scenario = results.scenarios[0]
  const load = scenario.artifacts["external-http-load"]
  assert.equal(load.schema, "wp-codebox/wordpress-external-http-load/v1")
  assert.equal(load.completedCount, 4)
  assert.equal(load.successCount, 4)
  assert.equal(load.failureCount, 0)
  assert.equal(load.maxObservedConcurrency, 2)
  assert.deepEqual(load.provenance, {
    source: "host-side-external-http",
    transport: "runtime-preview-http",
    runtimeScope: "single-runtime",
    target: "/",
    method: "GET",
  })
  assert.equal(scenario.metrics.external_http_load_completed_count.samples.mean, 4)
  assert.equal(scenario.metrics.external_http_load_max_observed_concurrency_count.samples.mean, 2)
  assert.ok(scenario.metrics.duration.samples.mean > 0)
})

console.log("external HTTP load runs against one WordPress preview runtime")
