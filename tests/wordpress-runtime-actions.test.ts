import assert from "node:assert/strict"
import { fuzzSuiteContract, runFuzzSuite } from "../packages/runtime-core/src/index.js"
import {
  collectWordPressArtifacts,
  createWordPressFuzzSuiteRuntimeActionExecutor,
  describeWordPressExecutionSurfaces,
  discoverWordPressRuntime,
  executeFuzzSuite,
  executeWordPressRestMatrix,
  inventoryWordPressAdminPages,
  inventoryWordPressFrontendUrls,
  inventoryWordPressRestRoutes,
  invokeWordPressCronEvent,
  invokeWordPressHook,
  invokeWordPressWpCli,
  renderWordPressBlock,
  exerciseWordPressBlock,
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
        stdout: action.command === "wordpress.run-php" && (action.args ?? []).some((arg) => arg.includes("wp-codebox/wordpress-rollback-capture-request/v1"))
          ? JSON.stringify({ schema: "wp-codebox/wordpress-rollback-capture/v1", options: { rollback_probe: { exists: true, value: "same" } }, tables: {}, objects: {} })
          : action.command.includes("browser") || action.command.includes("editor") || action.command.includes("rest") || action.command.includes("page-load") ? JSON.stringify({ performance: { timing: { durationMs: 12 }, memory: { peakBytes: 1234 }, database: { queryCount: 2, repeatedQueries: [{ fingerprint: "SELECT ?", count: 2 }] } } }) : "ok\n",
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
await requestWordPressRest(fakeEpisode, { path: "/wp/v2/types", method: "GET", capture: { queries: true } })
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
await describeWordPressExecutionSurfaces(fakeEpisode)
await invokeWordPressWpCli(fakeEpisode, { command: "option get siteurl", mutates: false })
await invokeWordPressHook(fakeEpisode, { hook: "wp_codebox_test_hook", args: ["demo"], mutates: true, capability: "manage_options", destructiveBoundary: "disposable-runtime" })
await invokeWordPressCronEvent(fakeEpisode, { hook: "wp_codebox_test_cron", operation: "schedule-single", timestamp: 1770000000, args: ["demo"], mutates: true })
await runWordPressCrudOperation(fakeEpisode, { operation: "read", resource: { kind: "post", type: "page", id: 42 } })
await readWordPressDatabase(fakeEpisode, { resource: { table: "posts", identifiers: { ID: 42 } }, query: { limit: 1 } })
await renderWordPressBlock(fakeEpisode, { blockName: "core/paragraph", attrs: { align: "wide" }, content: "Hello" })
await exerciseWordPressBlock(fakeEpisode, { blockName: "core/latest-posts", mode: "serialize-parse", attrs: { postsToShow: 3 } })
await loadWordPressAdminPage(fakeEpisode, { path: "edit.php?post_type=page", user: "admin", capture: { queries: true } })
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
  "wordpress.execution-surfaces",
  "wordpress.invoke-wp-cli",
  "wordpress.invoke-hook",
  "wordpress.invoke-cron-event",
  "wordpress.crud-operation",
  "wordpress.db-operation",
  "wordpress.block-render",
  "wordpress.block-exercise",
  "wordpress.simulated-admin-page-load",
  "wordpress.simulated-frontend-page-load",
])
assert.deepEqual(calls[0]?.args, ["command=option get siteurl"])
assert.ok(calls[1]?.args.includes("code=echo get_bloginfo('name');"))
assert.ok(calls[1]?.args.includes("bootstrap=wordpress"))
assert.equal(calls[1]?.timeoutMs, 5000)
assert.ok(calls[2]?.args.includes("path=/wp/v2/types"))
assert.ok(calls[2]?.args.includes('capture-json={"queries":true}'))
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
assert.deepEqual(calls[15]?.args, [])
assert.deepEqual(calls[16]?.args, ["command=option get siteurl", "mutates=false"])
assert.deepEqual(calls[17]?.args, ["hook=wp_codebox_test_hook", 'args-json=["demo"]', "mutates=true", "capability=manage_options", "destructive-boundary=disposable-runtime"])
assert.deepEqual(calls[18]?.args, ["hook=wp_codebox_test_cron", "operation=schedule-single", 'args-json=["demo"]', "timestamp=1770000000", "mutates=true"])
assert.equal(JSON.parse(calls[19]?.args[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-crud-operation/v1")
assert.equal(JSON.parse(calls[19]?.args[0]?.replace("operation-json=", "") ?? "{}").operation, "read")
assert.equal(JSON.parse(calls[20]?.args[0]?.replace("operation-json=", "") ?? "{}").schema, "wp-codebox/wordpress-db-operation/v1")
assert.equal(JSON.parse(calls[20]?.args[0]?.replace("operation-json=", "") ?? "{}").operation, "read")
assert.deepEqual(calls[21]?.args, ["block-name=core/paragraph", 'attrs-json={"align":"wide"}', "content=Hello", "mode=render"])
assert.deepEqual(calls[22]?.args, ["block-name=core/latest-posts", 'attrs-json={"postsToShow":3}', "mode=serialize-parse"])
assert.deepEqual(calls[23]?.args, ["path=edit.php?post_type=page", "user=admin", 'capture-json={"queries":true}'])
assert.deepEqual(calls[24]?.args, ["path=/sample-page/", "query-json={\"preview\":true}"])
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
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "runtime-actions-baseline" },
  metadata: { disposableSandboxBoundary: { disposable: true, destructivePermission: true, teardown: "discard", backend: "wordpress-playground", hostAccess: "declared-mounts-only" } },
  target: { kind: "runtime-action" },
  cases: [
    { id: "browser", input: { type: "browser", operation: "capture", capture: ["html"] } },
    { id: "random-walk", input: { type: "random_walk", context: "admin", seed: "runtime-random", max_steps: 3, action_families: ["capture", "press"], start_url: "/wp-admin/", capture: ["html"] } },
    { id: "editor", input: { type: "editor_open", target: "post-new", post_type: "page" } },
    { id: "admin", input: { type: "admin_page", path: "plugins.php" } },
    { id: "page", input: { type: "page", path: "/sample-page/" } },
    { id: "crud", input: { type: "crud_operation", operation: "read", resource: { kind: "post", type: "page", id: 42 } } },
    { id: "db-write", input: { type: "db_operation", operation: "write", query: { table: "options", where: { option_name: "wp-codebox-fuzz-missing" }, values: { option_value: "fuzz" }, limit: 1 }, options: { mutation: "update" } } },
    { id: "hook", input: { type: "wordpress_hook", hook: "wp_codebox_test_hook", args: ["demo"], mutates: true, capability: "manage_options" } },
    { id: "cron", input: { type: "wordpress_cron_event", hook: "wp_codebox_test_cron", operation: "run-hook", args: ["demo"], mutates: true } },
  ],
}), {
  runtimeActionExecutor: createWordPressFuzzSuiteRuntimeActionExecutor(fakeEpisode),
  resetExecutor: async ({ policy }) => ({ mode: policy.mode, status: "passed", checkpointName: policy.checkpointName }),
})
assert.equal(runtimeActionFuzzResult.status, "passed")
assert.deepEqual(runtimeActionFuzzResult.summary, { total: 9, passed: 9, failed: 0, error: 0, skipped: 0 })
assert.deepEqual(calls.slice(beforeFuzzCalls).map((call) => call.command), [
  "wordpress.browser-actions",
  "wordpress.browser-actions",
  "wordpress.editor-open",
  "wordpress.browser-probe",
  "wordpress.browser-probe",
  "wordpress.crud-operation",
  "wordpress.db-operation",
  "wordpress.invoke-hook",
  "wordpress.invoke-cron-event",
])
assert.equal((runtimeActionFuzzResult.cases[1]?.metadata?.adapter as Record<string, unknown> | undefined)?.actionType, "random_walk")
assert.equal((runtimeActionFuzzResult.cases[6]?.metadata?.mutationIsolation as Record<string, unknown> | undefined)?.artifactKind, "mutation-isolation")
assert.equal(((runtimeActionFuzzResult.cases[6]?.metadata?.mutationIsolation as Record<string, unknown> | undefined)?.sandboxBoundary as Record<string, unknown> | undefined)?.destructivePermission, true)

console.log("wordpress runtime actions ok")
