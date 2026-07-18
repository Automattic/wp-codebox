import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { RUNTIME_COMMAND_RESULT_SCHEMA } from "../packages/runtime-core/src/runtime-contracts.js"
import { CLOUDFLARE_RUNTIME_HEALTH_MARKER, CLOUDFLARE_RUNTIME_HEALTH_SCHEMA, cloudflareRuntimeHealthResponse } from "../packages/runtime-cloudflare/src/health-envelope.js"

test("Cloudflare health response preserves the Codebox execution envelope", async () => {
  const health = {
    schema: CLOUDFLARE_RUNTIME_HEALTH_SCHEMA,
    marker: CLOUDFLARE_RUNTIME_HEALTH_MARKER,
    wordpressVersion: "6.8.1",
    phpVersion: "8.5.8",
    runtime: { backend: "wordpress-playground" as const, environment: "wordpress" as const },
    evidence: { initialization: "completed" as const, execution: "completed" as const, initializationScope: "isolate" as const },
  }
  const response = cloudflareRuntimeHealthResponse(health)
  const payload = await response.json() as { execution: { schema: string; status: string; json: unknown }; marker: string; evidence: unknown }

  assert.equal(response.headers.get("content-type"), "application/json")
  assert.equal(payload.marker, CLOUDFLARE_RUNTIME_HEALTH_MARKER)
  assert.deepEqual(payload.evidence, health.evidence)
  assert.equal(payload.execution.schema, RUNTIME_COMMAND_RESULT_SCHEMA)
  assert.equal(payload.execution.status, "ok")
  assert.deepEqual(payload.execution.json, health)
})

test("Cloudflare runtime declares the paid-plan WordPress boot CPU budget", async () => {
  const config = JSON.parse(await readFile(new URL("../packages/runtime-cloudflare/wrangler.jsonc", import.meta.url), "utf8")) as { limits?: { cpu_ms?: number } }
  assert.equal(config.limits?.cpu_ms, 300_000)
})
