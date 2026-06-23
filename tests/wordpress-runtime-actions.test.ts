import assert from "node:assert/strict"
import { fuzzSuiteContract, runFuzzSuite } from "../packages/runtime-core/src/index.js"
import {
  collectWordPressArtifacts,
  createWordPressFuzzSuiteRuntimeActionExecutor,
  discoverWordPressRuntime,
  executeFuzzSuite,
  executeWordPressRestMatrix,
  inventoryWordPressAdminPages,
  inventoryWordPressFrontendUrls,
  inventoryWordPressRestRoutes,
  loadWordPressAdminPage,
  loadWordPressFrontendPage,
  openWordPressAdminPage,
  openWordPressEditor,
  probeWordPressBrowser,
  readWordPressDatabase,
  requestWordPressRest,
  runWordPressCrudOperation,
  runWordPressBrowserAction,
  runWordPressPhp,
  runWordPressWpCli,
  setWordPressPluginState,
  setupWordPressPlugin,
  setupWordPressTheme,
  visitWordPressPage,
  type WordPressRuntimeActionEpisode,
} from "../packages/runtime-playground/src/public.js"

const calls: Array<{ command: string; args: string[]; kind?: string; timeoutMs?: number }> = []

const fakeEpisode: WordPressRuntimeActionEpisode = {
  async step(action, observation) {
    calls.push({ command: action.command, args: action.args ?? [], kind: action.kind, timeoutMs: action.timeoutMs })
    return {
      id: `${action.command}:step`,
      index: calls.length - 1,
      action: {
        schema: "wp-codebox/runtime-episode-action/v1",
        id: `${action.command}:action`,
        kind: action.kind ?? "command",
        command: action.command,
        args: action.args ?? [],
        digest: { algorithm: "sha256", value: action.command },
      },
      actionRef: { kind: "action", id: `${action.command}:action` },
      execution: {
        id: `${action.command}:execution`,
        command: action.command,
        args: action.args ?? [],
        exitCode: 0,
        stdout: action.command.includes("browser") || action.command.includes("editor") || action.command.includes("rest") ? JSON.stringify({ performance: { timing: { durationMs: 12 }, memory: { peakBytes: 1234 }, database: { queryCount: 2, repeatedQueries: [{ fingerprint: "SELECT ?", count: 2 }] } } }) : "ok\n",
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.000Z",
      },
      executionRef: { kind: "execution", id: `${action.command}:execution` },
      ...(observation ? { observation: { type: "runtime-info", data: {}, observedAt: "2026-01-01T00:00:00.000Z" } } : {}),
    }
  },
}

await runWordPressWpCli(fakeEpisode, "option get siteurl")
await runWordPressPhp(fakeEpisode, { code: "echo get_bloginfo('name');", bootstrap: "wordpress", timeout_ms: 5000 })
await requestWordPressRest(fakeEpisode, { path: "/wp/v2/types", method: "GET" })
await runWordPressBrowserAction(fakeEpisode, { operation: "navigate", url: "/", capture: ["html"] })
await probeWordPressBrowser(fakeEpisode, { url: "/", wait_for: "load", capture: ["screenshot"] })
await openWordPressEditor(fakeEpisode, { target: "post-new", post_type: "post", capture: ["editor-state"] })
const adminObservation = await openWordPressAdminPage(fakeEpisode, { path: "plugins.php", capture: ["html"] })
const pageObservation = await visitWordPressPage(fakeEpisode, { path: "/sample-page/", capture: ["html"] })
await setupWordPressPlugin(fakeEpisode, { action: "list" })
await setWordPressPluginState(fakeEpisode, { action: "activate", plugin: "query-monitor" })
await setupWordPressTheme(fakeEpisode, { action: "list" })
await discoverWordPressRuntime(fakeEpisode, { surfaces: ["rest", "admin"], timeoutMs: 1000 })
await inventoryWordPressRestRoutes(fakeEpisode)
await inventoryWordPressAdminPages(fakeEpisode)
await inventoryWordPressFrontendUrls(fakeEpisode)
await runWordPressCrudOperation(fakeEpisode, { operation: "read", resource: { kind: "post", type: "page", id: 42 } })
await readWordPressDatabase(fakeEpisode, { resource: { table: "posts", identifiers: { ID: 42 } }, query: { limit: 1 } })
await loadWordPressAdminPage(fakeEpisode, { path: "edit.php?post_type=page", user: "admin", captureDiagnostics: ["wpdb-queries"] })
await loadWordPressFrontendPage(fakeEpisode, { path: "/sample-page/", query: { preview: true } })

assert.deepEqual(calls.map((call) => call.command), [
  "wordpress.wp-cli",
  "wordpress.run-php",
  "wordpress.rest-request",
  "wordpress.browser-actions",
  "wordpress.browser-probe",
  "wordpress.editor-open",
  "wordpress.browser-probe",
  "wordpress.browser-probe",
  "wordpress.plugin-setup",
  "wordpress.plugin-state",
  "wordpress.theme-setup",
  "wordpress.runtime-discovery",
  "wordpress.rest-route-inventory",
  "wordpress.admin-page-inventory",
  "wordpress.frontend-url-inventory",
  "wordpress.crud-operation",
  "wordpress.db-operation",
  "wordpress.admin-page-load",
  "wordpress.frontend-page-load",
])
assert.deepEqual(calls[0]?.args, ["command=option get siteurl"])
assert.ok(calls[1]?.args.includes("code=echo get_bloginfo('name');"))
assert.ok(calls[1]?.args.includes("bootstrap=wordpress"))
assert.equal(calls[1]?.timeoutMs, 5000)
assert.ok(calls[2]?.args.includes("path=/wp/v2/types"))
assert.ok(calls[3]?.args.some((arg) => arg.startsWith("steps-json=")))
assert.ok(calls[4]?.args.includes("url=/"))
assert.ok(calls[5]?.args.includes("target=post-new"))
assert.ok(calls[6]?.args.includes("url=/wp-admin/plugins.php"))
assert.ok(calls[7]?.args.includes("url=/sample-page/"))
assert.deepEqual(calls[8]?.args, ["action=list"])
assert.deepEqual(calls[9]?.args, ["action=activate", "plugin=query-monitor"])
assert.deepEqual(calls[10]?.args, ["action=list"])
assert.deepEqual(calls[11], { command: "wordpress.runtime-discovery", args: ["surface=rest,admin"], kind: "command", timeoutMs: 1000 })
assert.deepEqual(calls[12]?.args, [])
assert.deepEqual(calls[13]?.args, [])
assert.deepEqual(calls[14]?.args, [])
assert.equal(JSON.parse(calls[15]?.args[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-crud-operation/v1")
assert.equal(JSON.parse(calls[15]?.args[0]?.replace("operation-json=", "") ?? "{}").operation, "read")
assert.equal(JSON.parse(calls[16]?.args[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-db-operation/v1")
assert.equal(JSON.parse(calls[16]?.args[0]?.replace("operation-json=", "") ?? "{}").operation, "read")
assert.deepEqual(calls[17]?.args, ["path=edit.php?post_type=page", "user=admin", "capture-diagnostics=wpdb-queries"])
assert.deepEqual(calls[18]?.args, ["path=/sample-page/", "query-json={\"preview\":true}"])
assert.equal(adminObservation.performance?.schema, "wp-codebox/performance-observation/v1")
assert.equal(pageObservation.performance?.target, "/sample-page/")

const executor = async (spec: { command: string; args?: string[] }) => ({
  id: `${spec.command}:execution`,
  command: spec.command,
  args: spec.args ?? [],
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:00.000Z",
})
const fuzzResult = await executeFuzzSuite({
  schema: "wp-codebox/fuzz-suite/v1",
  id: "public-facade-suite",
  target: { kind: "command", entrypoint: "wordpress.wp-cli" },
  cases: [{ id: "siteurl", input: { args: ["command=option get siteurl"] } }],
}, { executor })
assert.equal(fuzzResult.success, true)

const restMatrixResult = await executeWordPressRestMatrix({
  schema: "wp-codebox/wordpress-rest-matrix/v1",
  id: "public-facade-rest-matrix",
  cases: [{ id: "types", method: "GET", path: "/wp/v2/types" }],
}, { executor })
assert.equal(restMatrixResult.schema, "wp-codebox/wordpress-rest-matrix-result/v1")
assert.equal(restMatrixResult.success, true)

const artifactBundle = { id: "bundle", directory: "artifacts/runtime", contentDigest: "digest", createdAt: "2026-01-01T00:00:00.000Z" }
assert.equal(await collectWordPressArtifacts({ async collectArtifacts() { return artifactBundle } }), artifactBundle)

const beforeFuzzCalls = calls.length
const runtimeActionFuzzResult = await runFuzzSuite(fuzzSuiteContract({
  id: "wordpress-episode-runtime-actions",
  target: { kind: "runtime-action" },
  cases: [
    { id: "browser", input: { type: "browser", operation: "capture", capture: ["html"] } },
    { id: "editor", input: { type: "editor_open", target: "post-new", post_type: "page" } },
    { id: "admin", input: { type: "admin_page", path: "plugins.php" } },
    { id: "page", input: { type: "page", path: "/sample-page/" } },
    { id: "crud", input: { type: "crud_operation", operation: "read", resource: { kind: "post", type: "page", id: 42 } } },
  ],
}), {
  runtimeActionExecutor: createWordPressFuzzSuiteRuntimeActionExecutor(fakeEpisode),
})
assert.equal(runtimeActionFuzzResult.status, "passed")
assert.deepEqual(runtimeActionFuzzResult.summary, { total: 5, passed: 5, failed: 0, error: 0, skipped: 0 })
assert.deepEqual(calls.slice(beforeFuzzCalls).map((call) => call.command), [
  "wordpress.browser-actions",
  "wordpress.editor-open",
  "wordpress.browser-probe",
  "wordpress.browser-probe",
  "wordpress.crud-operation",
])

console.log("wordpress runtime actions ok")
