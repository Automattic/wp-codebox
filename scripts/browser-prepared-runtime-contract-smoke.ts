import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

const source = await readFile(new URL("../packages/wordpress-plugin/assets/browser-runtime.js", import.meta.url), "utf8")
const context = vm.createContext({
  window: {},
  TextDecoder,
  TextEncoder,
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
})
vm.runInContext(source, context)

const runtime = (context.window as { wpCodeboxBrowser?: Record<string, (...args: unknown[]) => unknown> }).wpCodeboxBrowser!
assert.equal(typeof runtime.preparedBrowserRuntimeContract, "function")
assert.equal(typeof runtime.selectPreparedBrowserBlueprint, "function")
assert.equal(typeof runtime.preparedBrowserRuntimeStatus, "function")
assert.equal(typeof runtime.runBrowserSessionRecipe, "function", "existing dynamic browser contract should remain available")

const fallbackBlueprint = { steps: [{ step: "login" }, { step: "runPHP", code: "<?php echo 'fallback';" }] }
const preparedBlueprint = { steps: [{ step: "runPHP", code: "<?php echo 'prepared';" }] }
const hitSession = {
  schema: "wp-codebox/browser-playground-session/v1",
  success: true,
  recipe: { schema: "wp-codebox/workspace-recipe/v1", browser: { task_path: "/tmp/task.json" }, workflow: { steps: [{ command: "wordpress.run-php", args: ["code=<?php echo '{}';"] }] } },
  playground: {
    blueprint: preparedBlueprint,
    prepared_runtime: {
      schema: "wp-codebox/browser-prepared-runtime/v1",
      status: "hit",
      selected: "prepared",
      cache_key: "known-site",
      input_hash: "a".repeat(64),
      blueprint: preparedBlueprint,
      fallback_blueprint: fallbackBlueprint,
      diagnostics: {
        schema: "wp-codebox/browser-prepared-runtime-diagnostics/v1",
        prepared_snapshot_hit: true,
        prepared_snapshot_key: "known-site",
        source_digest: { algorithm: "sha256", value: "a".repeat(64) },
      },
    },
  },
}

assert.equal(runtime.preparedBrowserRuntimeContract(hitSession)?.status, "hit")
assert.deepEqual(runtime.selectPreparedBrowserBlueprint(hitSession), preparedBlueprint)
assert.equal(JSON.stringify(runtime.preparedBrowserRuntimeStatus(hitSession)), JSON.stringify({
  schema: "wp-codebox/browser-prepared-runtime-status/v1",
  status: "hit",
  selected: "prepared",
  cache_key: "known-site",
  input_hash: "a".repeat(64),
  source_digest: { algorithm: "sha256", value: "a".repeat(64) },
  diagnostics: {
    schema: "wp-codebox/browser-prepared-runtime-diagnostics/v1",
    prepared_snapshot_hit: true,
    prepared_snapshot_key: "known-site",
    source_digest: { algorithm: "sha256", value: "a".repeat(64) },
  },
  invalidation: null,
}))

const missSession = {
  ...hitSession,
  playground: {
    blueprint: fallbackBlueprint,
    prepared_runtime: {
      ...hitSession.playground.prepared_runtime,
      status: "miss",
      selected: "fallback",
      invalidation: { reason: "input-hash-mismatch" },
    },
  },
}
assert.deepEqual(runtime.selectPreparedBrowserBlueprint(missSession), fallbackBlueprint)
assert.equal(runtime.preparedBrowserRuntimeStatus(missSession)?.invalidation?.reason, "input-hash-mismatch")

const dynamicSession = { ...hitSession, playground: { blueprint: fallbackBlueprint }, runtime: {} }
assert.equal(runtime.preparedBrowserRuntimeContract(dynamicSession)?.status, "disabled")
assert.deepEqual(runtime.selectPreparedBrowserBlueprint(dynamicSession), fallbackBlueprint)

console.log("Browser prepared runtime contract smoke passed")
