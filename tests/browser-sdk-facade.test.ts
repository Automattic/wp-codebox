import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

import { browserArtifactPersistenceProjection } from "../packages/runtime-core/src/index.js"

const root = new URL("../", import.meta.url)
const runtimeSource = await readFile(new URL("packages/wordpress-plugin/assets/browser-runtime.js", root), "utf8")
const previewFixture = JSON.parse(await readFile(new URL("contracts/browser-product-preview.fixture.json", root), "utf8"))

const sandbox = {
  window: { dispatchEvent: () => true } as { wpCodebox?: Record<string, any>, wpCodeboxBrowser?: Record<string, any>, wp?: Record<string, any>, dispatchEvent?: (event: any) => boolean },
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  CustomEvent: class CustomEvent {
    type: string
    detail: unknown
    constructor(type: string, init: { detail?: unknown } = {}) {
      this.type = type
      this.detail = init.detail
    }
  },
  TextDecoder,
  TextEncoder,
  URL,
  setTimeout,
  clearTimeout,
}

vm.runInNewContext(runtimeSource, sandbox, { filename: "browser-runtime.js" })

const api = sandbox.window.wpCodeboxBrowser
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

assert.ok(api, "browser runtime must publish window.wpCodeboxBrowser")
assert.equal(typeof sandbox.window.wpCodebox?.startBrowserPreview, "function", "browser runtime must publish window.wpCodebox.startBrowserPreview")
assert.equal(typeof api.runPhpRequest, "function", "legacy top-level methods remain available")
assert.equal(typeof api.v1, "object", "browser runtime must expose the stable v1 facade")

assert.deepEqual(plain(api.v1.info()), {
  schema: "wp-codebox/browser-sdk/v1",
  apiVersion: "v1",
  version: "1.0.0",
  capabilities: [
    "browser-runtime:info",
    "browser-runtime:normalize-error",
    "browser-runtime:normalize-result",
    "browser-runtime:normalize-browser-run-result",
    "runtime-task:create-request",
    "runtime-task:run",
    "browser-preview:start",
    "browser-preview:lifecycle",
    "browser-preview:double-buffer",
    "browser-preview:navigation",
    "browser-contained-site-sync:consume",
    "browser-runtime:boot-executable-session",
    "browser-runtime:parent-tool-bridge",
    "browser-runtime:aggregate-fanout-outputs",
    "browser-runtime:invoke-result",
    "browser-connector:request",
    "playground:run-php",
    "playground:run-recipe",
    "browser-runtime:validate-materialization",
    "wordpress:operation",
    "filesystem:write-file",
    "filesystem:ensure-directory",
    "review:write-file",
    "contract:probe",
    "browser-viewport:capture",
    "browser-viewport:verify",
  ],
  globals: {
    name: "wpCodeboxBrowser",
    facade: "wpCodeboxBrowser.v1",
  },
})

const expectedV1TopLevelKeys = [
  "schema",
  "apiVersion",
  "version",
  "capabilities",
  "getCapabilities",
  "info",
  "normalizeError",
  "normalizeBrowserRunResult",
  "browserArtifactPersistenceRef",
  "createRuntimeTaskRequest",
  "runRuntimeTask",
  "consumeContainedSiteSync",
  "openOrCreateBrowserContainedSite",
  "createBrowserPreviewBuffer",
  "startBrowserPreview",
  "aggregateFanoutOutputs",
  "validateBrowserRuntimeMaterialization",
  "ensureDirectory",
  "writeFile",
  "readFile",
  "listDirectory",
  "grep",
  "editFile",
  "applyPatch",
  "runRecipe",
  "normalizeResult",
  "result",
  "executableBrowserSession",
  "bootExecutableBrowserSession",
  "parentToolBridge",
  "createBrowserConnectorRequest",
  "executeBrowserConnectorRequest",
  "createParentToolRequest",
  "dispatchParentTool",
  "runBrowserSessionRecipe",
  "captureViewportScreenshot",
  "verifyViewportScreenshot",
  "setFrontendAdminBarVisible",
  "methods",
] as const
assert.deepEqual(Object.keys(api.v1), expectedV1TopLevelKeys, "wpCodeboxBrowser.v1 top-level keys must remain contract-derived and stable")

const expectedV1MethodKeys = [
  "activateTheme",
  "browserSessionRecipe",
  "captureViewportScreenshot",
  "createBrowserConnectorRequest",
  "executeBrowserConnectorRequest",
  "executeBrowserProviderProxyRequest",
  "consumeContainedSiteSync",
  "openOrCreateBrowserContainedSite",
  "createBrowserPreviewBuffer",
  "startBrowserPreview",
  "bootExecutableBrowserSession",
  "createParentToolRequest",
  "dispatchParentTool",
  "ensureDirectory",
  "readFile",
  "listDirectory",
  "grep",
  "editFile",
  "applyPatch",
  "executableBrowserSession",
  "installTheme",
  "parentToolBridge",
  "validateBrowserRuntimeMaterialization",
  "aggregateFanoutOutputs",
  "preparedBrowserRuntimeContract",
  "preparedBrowserRuntimeStatus",
  "runBrowserRuntimeContractProbe",
  "runBrowserSessionRecipe",
  "runPhpRequest",
  "runRecipe",
  "runWordPressOperation",
  "selectPreparedBrowserBlueprint",
  "setFrontendAdminBarVisible",
  "verifyViewportScreenshot",
  "writeFile",
  "writeReviewFile",
] as const
assert.deepEqual(Object.keys(api.v1.methods), expectedV1MethodKeys, "wpCodeboxBrowser.v1.methods must match the SDK methods contract")
for (const method of expectedV1MethodKeys) {
  assert.equal(api.v1.methods[method], api[method], `wpCodeboxBrowser.v1.methods.${method} must be derived from the runtime API map`)
}

const expectedRuntimeInternalKeys = [
  "normalizeOperationResult",
  "parseJsonResponse",
] as const
assert.deepEqual(
  Object.keys(api).filter((key) => key !== "v1").sort(),
  [...expectedV1MethodKeys, ...expectedRuntimeInternalKeys].sort(),
  "every public runtime API method must be covered by the SDK methods contract or explicitly internal",
)

assert.equal(api.v1.methods.runPhpRequest, api.runPhpRequest)
assert.equal(api.v1.methods.writeFile, api.writeFile)
assert.equal(api.v1.methods.validateBrowserRuntimeMaterialization, api.validateBrowserRuntimeMaterialization)
assert.equal(typeof api.v1.setFrontendAdminBarVisible, "function")
assert.equal(api.v1.methods.setFrontendAdminBarVisible, api.setFrontendAdminBarVisible)
assert.equal(typeof api.v1.runBrowserSessionRecipe, "function")
assert.equal(typeof api.v1.captureViewportScreenshot, "function")
assert.equal(typeof api.v1.verifyViewportScreenshot, "function")
assert.equal(typeof api.v1.startBrowserPreview, "function")
assert.equal(typeof api.v1.createBrowserPreviewBuffer, "function")
assert.equal(typeof api.v1.consumeContainedSiteSync, "function")
assert.equal(typeof api.v1.openOrCreateBrowserContainedSite, "function")
const studioNativeConsumedTopLevelMethods = [
  "consumeContainedSiteSync",
  "ensureDirectory",
  "openOrCreateBrowserContainedSite",
  "createBrowserPreviewBuffer",
  "runBrowserSessionRecipe",
  "runRecipe",
  "setFrontendAdminBarVisible",
  "startBrowserPreview",
  "writeFile",
] as const
for (const method of studioNativeConsumedTopLevelMethods) {
  assert.equal(typeof api.v1[method], "function", `Studio Native consumes wpCodeboxBrowser.v1.${method} top-level`)
  assert.equal(typeof api.v1.methods[method], "function", `Studio Native consumes wpCodeboxBrowser.v1.methods.${method}`)
}
assert.equal(Object.isFrozen(api.v1), true, "browser SDK v1 facade remains frozen")
assert.equal(typeof api.v1.bootExecutableBrowserSession, "function")
assert.equal(typeof api.v1.createBrowserConnectorRequest, "function")
assert.equal(typeof api.v1.executeBrowserConnectorRequest, "function")
assert.equal(typeof api.v1.createParentToolRequest, "function")
assert.equal(typeof api.v1.validateBrowserRuntimeMaterialization, "function")
assert.equal(typeof api.v1.createRuntimeTaskRequest, "function")
assert.equal(typeof api.v1.runRuntimeTask, "function")

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")
let viewportInvocation: Record<string, unknown> | undefined
const captured = await api.v1.captureViewportScreenshot({}, {
  route: "/example",
  viewport: { width: 1440, height: 900 },
  timeout_ms: 50,
}, {
  browserInvoker: async (request: Record<string, unknown>) => {
    viewportInvocation = request
    return { png_base64: png, diagnostics: [{ code: "browser_ready", message: "Browser is ready.", severity: "info" }] }
  },
  persistArtifact: async () => ({ artifact: { id: "viewport-1", path: "files/browser/example.png", sha256: "a".repeat(64) } }),
})
assert.deepEqual(plain(viewportInvocation), {
  schema: "wp-codebox/browser-invocation-request/v1",
  operation: "viewport-screenshot",
  client: {},
  route: "/example",
  viewport: { width: 1440, height: 900 },
  timeout_ms: 50,
})
assert.deepEqual(plain(captured), {
  schema: "wp-codebox/browser-viewport-screenshot/v1",
  success: true,
  status: "captured",
  route: "/example",
  viewport: { width: 1440, height: 900 },
  artifact: { id: "viewport-1", path: "files/browser/example.png", kind: "browser-viewport-screenshot", contentType: "image/png", sha256: "a".repeat(64) },
  sha256: "a".repeat(64),
  diagnostics: [{ code: "browser_ready", message: "Browser is ready.", severity: "info" }],
})
const verified = await api.v1.verifyViewportScreenshot(captured, {
  verifyArtifact: async () => ({ success: true, exists: true, sha256: "a".repeat(64) }),
})
assert.equal(verified.status, "verified")
assert.equal(verified.success, true)

const routeFailure = await api.v1.captureViewportScreenshot({}, { route: "https://example.test", viewport: { width: 375, height: 667 } }, {})
assert.equal(routeFailure.status, "failed")
assert.equal(routeFailure.diagnostics[0].code, "viewport_capture_route_invalid")
const timeoutFailure = await api.v1.captureViewportScreenshot({}, { route: "/slow", viewport: { width: 375, height: 667 }, timeout_ms: 1 }, {
  browserInvoker: async () => await new Promise(() => undefined),
  persistArtifact: async () => ({ artifact: { id: "unused", path: "unused.png", sha256: "a".repeat(64) } }),
})
assert.equal(timeoutFailure.status, "failed")
assert.equal(timeoutFailure.diagnostics[0].code, "viewport_capture_timeout")
const missingArtifact = await api.v1.verifyViewportScreenshot(captured, {
  verifyArtifact: async () => ({ success: false, exists: false, sha256: "a".repeat(64) }),
})
assert.equal(missingArtifact.status, "failed")
assert.equal(missingArtifact.diagnostics[0].code, "viewport_capture_artifact_missing")
const checksumMismatch = await api.v1.verifyViewportScreenshot(captured, {
  verifyArtifact: async () => ({ success: true, exists: true, sha256: "b".repeat(64) }),
})
assert.equal(checksumMismatch.status, "failed")
assert.equal(checksumMismatch.diagnostics[0].code, "viewport_capture_checksum_mismatch")
const previousViewportAbilityWp = sandbox.window.wp
const viewportAbilityRequests: any[] = []
sandbox.window.wp = {
  apiFetch: async (request: any) => {
    viewportAbilityRequests.push(request)
    if (request.path === "/wp-abilities/v1/abilities/wp-codebox/persist-browser-artifact/run") {
      return {
        schema: "wp-codebox/browser-persisted-artifact-bundle/v1",
        artifact_ref: { schema: "wp-codebox/browser-artifact-ref/v1", artifact_id: "bundle-1", content_digest: "c".repeat(64), artifacts_path: "/artifacts/bundle-1" },
        files: [{ artifact_path: "files/browser/screenshot.png", kind: "browser-screenshot", mime_type: "image/png", sha256: { algorithm: "sha256", value: "c".repeat(64) } }],
      }
    }
    return { success: true, artifact: { changed_files: { files: [{ artifactPath: "files/browser/screenshot.png", sha256: { algorithm: "sha256", value: "c".repeat(64) } }] } }, verification: { valid: true } }
  },
}
const ownedCapture = await api.v1.captureViewportScreenshot({}, { route: "/owned", viewport: { width: 375, height: 667 } }, { browserInvoker: async () => ({ png_base64: png }) })
assert.equal(ownedCapture.success, true)
assert.equal(ownedCapture.artifact.artifact_id, "bundle-1")
assert.equal(ownedCapture.artifact.sha256, "c".repeat(64))
assert.equal((await api.v1.verifyViewportScreenshot(ownedCapture)).status, "verified")
assert.deepEqual(plain(viewportAbilityRequests.map((request) => request.path)), [
  "/wp-abilities/v1/abilities/wp-codebox/persist-browser-artifact/run",
  "/wp-abilities/v1/abilities/wp-codebox/inspect-artifact/run",
])
sandbox.window.wp = previousViewportAbilityWp
assert.deepEqual(plain(api.v1.normalizeError(Object.assign(new Error("Nope"), { code: "demo_error", phase: "probe", status: 418, data: { demo: true } }))), {
  schema: "wp-codebox/browser-sdk-error/v1",
  code: "demo_error",
  message: "Nope",
  phase: "probe",
  status: 418,
  data: { demo: true },
})

assert.deepEqual(plain(await api.v1.result("demo.ok", async () => ({ ok: true }))), {
  schema: "wp-codebox/browser-sdk-result/v1",
  operation: "demo.ok",
  success: true,
  data: { ok: true },
  error: null,
})

const failed = await api.v1.result("demo.fail", async () => {
  throw Object.assign(new Error("Broken"), { code: "demo_failed", phase: "demo" })
})
assert.equal(failed.schema, "wp-codebox/browser-sdk-result/v1")
assert.equal(failed.operation, "demo.fail")
assert.equal(failed.success, false)
assert.equal(failed.error.code, "demo_failed")
assert.equal(failed.error.message, "Broken")

let directRunCode = ""
const directRunClient = {
  run: async (input: { code?: string } | string) => {
    directRunCode = typeof input === "string" ? input : input.code || ""
    return JSON.stringify({ success: true, data: { mode: "direct-run" }, error: null })
  },
}
const directRunResult = await api.v1.methods.runPhpRequest(directRunClient, {
  code: "<?php echo wp_json_encode( array( 'success' => true ) );",
  expectJson: true,
})
assert.equal(directRunCode.includes("wp_json_encode"), true)
assert.deepEqual(plain(directRunResult), { success: true, data: { mode: "direct-run" }, error: null })

await assert.rejects(
  () => api.v1.methods.runPhpRequest(directRunClient, {
    code: "<?php echo wp_json_encode( array( 'success' => true ) );",
    expectJson: true,
    forceRequest: true,
  }),
  (error: any) => {
    assert.equal(error.schema, "wp-codebox/browser-runtime-error/v1")
    assert.equal(error.phase, "write_file")
    assert.equal(error.code, "playground_write_file_unavailable")
    return true
  },
)

const failedRequestClient = {
  writeFile: async () => undefined,
  request: async () => {
    throw Object.assign(new Error("PHP endpoint returned 500"), { code: "http_500" })
  },
}
await assert.rejects(
  () => api.v1.methods.runPhpRequest(failedRequestClient, {
    code: "<?php throw new Exception( 'broken' );",
    forceRequest: true,
  }),
  (error: any) => {
    assert.equal(error.code, "playground_request_failed")
    assert.match(error.message, /PHP endpoint returned 500/)
    assert.equal(error.data.last_error.code, "http_500")
    assert.equal(error.data.attempts.length, 2)
    return true
  },
)

let providerProxyInstallations = 0
let materializerDirectRuns = 0
let materializerRequests = 0
const materializerRecipeClient = {
  run: async () => {
    materializerDirectRuns += 1
    return JSON.stringify(materializerDirectRuns === 1
      ? { success: true, data: null, error: null }
      : { success: true, response: { success: true, result: { theme_slug: "example" }, diagnostics: [] }, error: null })
  },
  writeFile: async () => undefined,
  request: async () => {
    materializerRequests += 1
    throw new Error("materializer recipes must run directly")
  },
  onMessage: () => {
    providerProxyInstallations += 1
    throw new Error("materializer recipes must not install the provider proxy")
  },
}
const materializerRecipeResult = await api.v1.methods.runRecipe(materializerRecipeClient, {
  browser: {
    task_path: "/wordpress/wp-content/uploads/wp-codebox/task.json",
  },
  workflow: {
    steps: [ { command: "wordpress.run-php", args: [ "code=<?php echo '{}';" ] } ],
  },
}, { materializer: { task: "example/run" } })
assert.equal(providerProxyInstallations, 0)
assert.equal(materializerDirectRuns, 2)
assert.equal(materializerRequests, 0)
assert.deepEqual(plain(materializerRecipeResult), {
  schema: "wp-codebox/materialization-result/v1",
  success: true,
  task: "example/run",
  result: { theme_slug: "example" },
  report: null,
  response: { success: true, response: { success: true, result: { theme_slug: "example" }, diagnostics: [] }, error: null },
  error: null,
})

let failedMaterializerRuns = 0
const failedMaterializerResult = await api.v1.methods.runRecipe({
  run: async () => {
    failedMaterializerRuns += 1
    return JSON.stringify(failedMaterializerRuns === 1
      ? { success: true, data: null, error: null }
      : {
          success: true,
          response: {
            success: false,
            error: { code: "quality_gate_failed", message: "Fallback blocks remain." },
            diagnostics: [ { code: "fallback_blocks", count: 2 } ],
          },
          error: null,
        })
  },
}, {
  browser: { task_path: "/wordpress/wp-content/uploads/wp-codebox/task.json" },
  workflow: { steps: [ { command: "wordpress.run-php", args: [ "code=<?php echo '{}';" ] } ] },
}, { materializer: { task: "example/run" } })
assert.equal(failedMaterializerResult.success, false)
assert.equal(failedMaterializerResult.error.code, "quality_gate_failed")
assert.deepEqual(plain(failedMaterializerResult.result.diagnostics), [ { code: "fallback_blocks", count: 2 } ])

const browserRun = api.v1.normalizeBrowserRunResult({
  success: true,
  data: {
    artifact: { path: "files/browser/index.html", kind: "browser-html", sha256: "def" },
    artifact_bundle: { id: "artifact-bundle-sha256-abc", directory: "artifacts/run-1", contentDigest: { algorithm: "sha256", value: "abc" } },
  },
}, "browser-session-recipe")
assert.equal(browserRun.schema, "wp-codebox/browser-run-result/v1")
assert.equal(browserRun.status, "completed")
assert.equal(browserRun.success, true)
assert.deepEqual(plain(browserRun.artifactRefs), [
  { kind: "artifact-bundle", id: "artifact-bundle-sha256-abc", path: "artifacts/run-1", digest: { algorithm: "sha256", value: "abc" } },
  { kind: "browser-html", path: "files/browser/index.html", digest: { algorithm: "sha256", value: "def" } },
])
assert.equal(api.v1.browserArtifactPersistenceRef(browserRun.result).schema, "wp-codebox/browser-artifact-persistence/ref/v1")

const previousAbilityWp = sandbox.window.wp
let abilityRequest: { path?: string, method?: string, data?: unknown } | null = null
sandbox.window.wp = {
  apiFetch: async (request: { path?: string, method?: string, data?: unknown }) => {
    abilityRequest = request
    return { schema: "wp-codebox/browser-contained-site-open-or-create/v1", success: true, action: "opened" }
  },
}
const containedSiteOpen = await api.v1.openOrCreateBrowserContainedSite({
  mode: "open-only",
  contained_site: { site_id: "site-1" },
})
assert.deepEqual(plain(containedSiteOpen), { schema: "wp-codebox/browser-contained-site-open-or-create/v1", success: true, action: "opened" })
assert.deepEqual(plain(abilityRequest), {
  path: "/wp-abilities/v1/abilities/wp-codebox/open-or-create-browser-contained-site/run",
  method: "POST",
  data: { input: { mode: "open-only", contained_site: { site_id: "site-1" } } },
})
sandbox.window.wp = previousAbilityWp

const previousFetch = (sandbox as any).fetch
const requestedRoutes: Array<{ route: string, method: string, body?: string }> = []
;(sandbox as any).fetch = async (route: string, request: { method?: string, body?: string } = {}) => {
  requestedRoutes.push({ route, method: request.method || "GET", body: request.body })
  const payloadByRoute: Record<string, unknown> = {
    "/wp-codebox/v1/browser-contained-site-sync/source-connect": { schema: "wp-codebox/browser-contained-site-sync-source/v1", success: true },
    "/wp-codebox/v1/browser-contained-site-sync/manifest": { schema: "wp-codebox/browser-contained-site-sync-manifest/v1", success: true, manifest: { resources: [] } },
    "/wp-codebox/v1/browser-contained-site-sync/export": {
      schema: "wp-codebox/browser-contained-site-sync-export/v1",
      success: true,
      package: {
        schema: "backend-package/v1",
        descriptor: { bootable: true },
        blueprint: { steps: [] },
        base_snapshot: "snapshot-1",
      },
    },
    "/wp-codebox/v1/browser-contained-site-sync/apply-plan/generate": { schema: "wp-codebox/browser-contained-site-sync-apply-plan/v1", apply_plan: { steps: [] } },
    "/wp-codebox/v1/browser-contained-site-sync/apply-plan/validate": { schema: "wp-codebox/browser-contained-site-sync-validation/v1", validation_hash: "validation-1" },
  }
  return {
    ok: true,
    status: 200,
    json: async () => payloadByRoute[route],
  }
}
const syncConsumption = await api.v1.consumeContainedSiteSync(null, {
  schema: "wp-codebox/browser-contained-site-sync-delegation/v1",
  routes: {
    source_connect: "/wp-codebox/v1/browser-contained-site-sync/source-connect",
    manifest: "/wp-codebox/v1/browser-contained-site-sync/manifest",
    export: "/wp-codebox/v1/browser-contained-site-sync/export",
    apply_plan_generate: "/wp-codebox/v1/browser-contained-site-sync/apply-plan/generate",
    apply_plan_validate: "/wp-codebox/v1/browser-contained-site-sync/apply-plan/validate",
  },
}, { projectId: 123 })
assert.equal(syncConsumption.schema, "wp-codebox/browser-contained-site-sync-consumption/v1")
assert.equal(syncConsumption.status, "success")
assert.equal(syncConsumption.project_id, 123)
assert.equal(syncConsumption.hydration.status, "ready")
assert.equal(syncConsumption.validation_hash, "validation-1")
assert.deepEqual(requestedRoutes.map(({ route, method }) => `${method} ${route}`), [
  "POST /wp-codebox/v1/browser-contained-site-sync/source-connect",
  "GET /wp-codebox/v1/browser-contained-site-sync/manifest",
  "POST /wp-codebox/v1/browser-contained-site-sync/export",
  "POST /wp-codebox/v1/browser-contained-site-sync/apply-plan/generate",
  "POST /wp-codebox/v1/browser-contained-site-sync/apply-plan/validate",
])
;(sandbox as any).fetch = previousFetch

const runtimeSession = {
  runtime: {
    plugins: [ { slug: "demo-plugin", targetFolderName: "demo-plugin", activate: true } ],
    mu_plugins: [ { slug: "demo-mu", file: "demo-mu.php" } ],
  },
}
const readyRuntime = {
  schema: "wp-codebox/browser-runtime-materialization-result/v1",
  success: true,
  status: "ready",
  dependencies: [ { kind: "plugin", slug: "demo-plugin", status: "active" } ],
  diagnostics: [],
  error: null,
}
const readyClient = { run: async () => JSON.stringify(readyRuntime) }
assert.deepEqual(plain(await api.v1.validateBrowserRuntimeMaterialization(readyClient, runtimeSession)), readyRuntime)

const failedRuntime = {
  schema: "wp-codebox/browser-runtime-materialization-result/v1",
  success: false,
  status: "failed",
  dependencies: [ { kind: "plugin", slug: "demo-plugin", status: "missing", code: "wp_codebox_browser_runtime_plugin_missing" } ],
  diagnostics: [ { code: "wp_codebox_browser_runtime_plugin_missing", severity: "error", slug: "demo-plugin" } ],
  error: { code: "wp_codebox_browser_runtime_materialization_failed", message: "Browser runtime dependencies failed to materialize." },
}
const failedClient = { run: async () => JSON.stringify(failedRuntime) }
await assert.rejects(
  () => api.v1.runBrowserSessionRecipe(failedClient, runtimeSession, {}),
  (error: any) => {
    assert.equal(error.code, "wp_codebox_browser_runtime_materialization_failed")
    assert.equal(error.phase, "browser_runtime_materialization")
    assert.deepEqual(plain(error.data), failedRuntime)
    return true
  },
)

const canonicalBrowserRun = api.v1.normalizeBrowserRunResult({
  schema: "wp-codebox/browser-run-result/v1",
  operation: "legacy-operation",
  status: "failed",
  success: true,
  result: "not-an-object",
  artifactRefs: [
    { kind: "browser-html", path: "files/browser/index.html", sha256: "def" },
    { role: "browser-html", path: "files/browser/index.html", content_digest: "def" },
  ],
  diagnostics: [
    { code: "capture-warning", message: "Captured with fallback.", severity: "notice" },
    { code: "capture-failed", message: "Capture failed.", severity: "error", metadata: { path: "files/browser/index.html" } },
  ],
  error: { message: "failed from canonical input", code: "canonical-failed" },
}, "browser-run")
assert.equal(canonicalBrowserRun.schema, "wp-codebox/browser-run-result/v1")
assert.equal(canonicalBrowserRun.operation, "legacy-operation")
assert.equal(canonicalBrowserRun.status, "failed")
assert.equal(canonicalBrowserRun.success, false)
assert.equal(canonicalBrowserRun.result, null)
assert.deepEqual(plain(canonicalBrowserRun.artifactRefs), [
  { kind: "browser-html", path: "files/browser/index.html", digest: { algorithm: "sha256", value: "def" } },
])
assert.deepEqual(plain(canonicalBrowserRun.diagnostics), [
  { code: "capture-warning", message: "Captured with fallback." },
  { code: "capture-failed", message: "Capture failed.", severity: "error", metadata: { path: "files/browser/index.html" } },
])
assert.equal(canonicalBrowserRun.error.schema, "wp-codebox/browser-sdk-error/v1")
assert.equal(canonicalBrowserRun.error.code, "canonical-failed")

const connectorRequest = api.v1.createBrowserConnectorRequest({
  id: "connector-request-1",
  connector: "primary-ai",
  provider: "openai",
  model: "gpt-4.1-mini",
  operation: "http.request",
  request: { method: "POST", uri: "/v1/responses", body: "{}" },
  sandbox_session_id: "browser-session-1",
  caller_session_id: "caller-session-1",
  authorization: { caller: "wp-codebox", scope: "browser-connector:request" },
})
assert.deepEqual(plain(connectorRequest), {
  schema: "wp-codebox/browser-connector-request/v1",
  id: "connector-request-1",
  connector: "primary-ai",
  provider: "openai",
  model: "gpt-4.1-mini",
  operation: "http.request",
  payload: { method: "POST", uri: "/v1/responses", body: "{}" },
  session: { sandbox_session_id: "browser-session-1", caller_session_id: "caller-session-1" },
  authorization: { caller: "wp-codebox", scope: "browser-connector:request" },
})

let providerProxyRequest: any = null
sandbox.window.wp = {
  apiFetch: async (request: any) => {
    providerProxyRequest = request
    return { success: true, response: { http: { status: 200, body: "{}" } } }
  },
}
const connectorResponse = await api.v1.executeBrowserConnectorRequest(connectorRequest)
assert.equal(connectorResponse.success, true)
assert.equal(providerProxyRequest.path, "/wp-codebox/v1/browser-provider-request")
assert.equal(providerProxyRequest.data.schema, "wp-codebox/browser-provider-proxy-request/v1")
assert.equal(providerProxyRequest.data.connector, "primary-ai")
assert.deepEqual(plain(providerProxyRequest.data.request), { method: "POST", uri: "/v1/responses", body: "{}" })
await api.v1.methods.executeBrowserProviderProxyRequest({
  schema: "wp-codebox/browser-provider-proxy-request/v1",
  operation: "http.request",
  connector: "primary-ai",
  inherit: { connectors: ["primary-ai"] },
  orchestrator: { id: "legacy-runtime" },
  request: { method: "POST", uri: "/v1/responses" },
})
assert.deepEqual(plain(providerProxyRequest.data.inherit), { connectors: ["primary-ai"] })
assert.deepEqual(plain(providerProxyRequest.data.orchestrator), { id: "legacy-runtime" })
delete sandbox.window.wp

const runtimeTaskRequest = api.v1.createRuntimeTaskRequest({
  targetId: "wp-codebox/browser-playground",
  task: "Run the browser task",
  input: { goal: "Run the browser task" },
})
assert.deepEqual(plain(runtimeTaskRequest), {
  schema: "wp-codebox/runtime-task-request/v1",
  target_id: "wp-codebox/browser-playground",
  task: "Run the browser task",
  input: { goal: "Run the browser task" },
})
assert.throws(
  () => api.v1.createRuntimeTaskRequest({ task: "missing target" }),
  (error: any) => {
    assert.equal(error.code, "runtime_task_target_id_required")
    return true
  },
)

const previousWp = (sandbox.window as any).wp
const runtimeTaskCalls: any[] = []
;(sandbox.window as any).wp = {
  apiFetch: async (request: any) => {
    runtimeTaskCalls.push(request)
    return { schema: "wp-codebox/runtime-task-result/v1", success: true, status: "completed", result: { ok: true } }
  },
}
const runtimeTaskResult = await api.v1.runRuntimeTask(runtimeTaskRequest)
assert.equal(runtimeTaskResult.schema, "wp-codebox/runtime-task-result/v1")
assert.deepEqual(plain(runtimeTaskCalls), [{ path: "/wp-codebox/v1/runtime-task", method: "POST", data: plain(runtimeTaskRequest) }])
;(sandbox.window as any).wp = previousWp

const persistenceProjectionInput = {
  schema: "wp-codebox/browser-artifact-persistence/ref/v1",
  artifactRefs: [
    { kind: "artifact-bundle", id: "artifact-bundle-sha256-abc", directory: "artifacts/run-1", contentDigest: { algorithm: "sha256", value: "abc" } },
    { role: "browser-html", path: "files/browser/index.html", digest: { content_digest: "def" } },
  ],
  artifact: { kind: "browser-html", path: "files/browser/index.html", sha256: "def" },
}
const expectedPersistenceArtifactRefs = [
  { kind: "artifact-bundle", id: "artifact-bundle-sha256-abc", path: "artifacts/run-1", digest: { algorithm: "sha256", value: "abc" } },
  { kind: "browser-html", path: "files/browser/index.html", digest: { algorithm: "sha256", value: "def" } },
]
assert.deepEqual(plain(api.v1.browserArtifactPersistenceRef(persistenceProjectionInput).artifactRefs), expectedPersistenceArtifactRefs)
assert.deepEqual(plain(browserArtifactPersistenceProjection(persistenceProjectionInput).artifactRefs), expectedPersistenceArtifactRefs)

const executableSession = {
  schema: "wp-codebox/browser-executable-session/v1",
  success: true,
  session_id: "executable-session-1",
  status: "ready",
  preview: { schema: "wp-codebox/preview-lease/v1", public_url: "https://preview.example.test/" },
  runtime_readiness: { schema: "wp-codebox/browser-runtime-readiness/v1", ready: true, status: "ready" },
  runtime_handoff: {
    schema: "wp-codebox/browser-runtime-handoff/v1",
    owner: "wp-codebox",
    session_id: "executable-session-1",
    hydrator_ability: "wp-codebox/hydrate-browser-blueprint-ref",
    blueprint_ref: {
      schema: "wp-codebox/browser-blueprint-ref/v1",
      ref: "prepared:site:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      hydrator_ability: "wp-codebox/hydrate-browser-blueprint-ref",
    },
    parent_tool_bridge: {
      schema: "wp-codebox/parent-tool-bridge/v1",
      version: 1,
      allowed_tools: ["workspace.read"],
      dispatcher: { owner: "wp-codebox", mode: "host_endpoint", request_schema: "wp-codebox/parent-tool-request/v1", result_schema: "wp-codebox/parent-tool-result/v1" },
      sandbox_env: { mode: "metadata-only", secret_env: [] },
      authorization: { mode: "allowlist" },
      redaction: { transcript_artifact_refs: [] },
      metadata: {},
    },
  },
}
const blueprintRuns: any[] = []
const booted = await api.v1.bootExecutableBrowserSession({
  run: async (request: any) => {
    blueprintRuns.push(request)
    return { success: true, data: { booted: true } }
  },
}, executableSession, {
  hydrateBlueprintRef: async (request: any) => {
    assert.equal(request.ability, "wp-codebox/hydrate-browser-blueprint-ref")
    assert.equal(request.ref, executableSession.runtime_handoff.blueprint_ref.ref)
    return { schema: "wp-codebox/browser-blueprint-hydration/v1", blueprint: { steps: [{ step: "runPHP", code: "<?php echo 'ok';" }] } }
  },
})
assert.equal(booted.schema, "wp-codebox/browser-run-result/v1")
assert.equal(booted.status, "completed")
assert.equal(booted.success, true)
assert.deepEqual(plain(blueprintRuns), [{ blueprint: { steps: [{ step: "runPHP", code: "<?php echo 'ok';" }] } }])

const previewStarts: any[] = []
const previewArchive = new Uint8Array([80, 75, 3, 4, 0])
const previewStart = await api.v1.startBrowserPreview(previewFixture.response.preview_boot, {
  iframe: { tagName: "IFRAME" },
  hydrateBlueprintRef: async (request: any) => {
    assert.equal(request.ability, "wp-codebox/hydrate-browser-blueprint-ref")
    assert.equal(request.ref, "prepared:preview:abc")
    return { schema: "wp-codebox/browser-blueprint-hydration/v1", blueprint: { steps: [{ step: "login" }] } }
  },
  startPlaygroundWeb: async (request: any) => {
    previewStarts.push(request)
    return { client: "playground" }
  },
  zipWpContent: async () => previewArchive,
})
assert.equal(previewStart.schema, "wp-codebox/browser-preview-start-result/v1")
assert.equal(previewStart.success, true)
assert.equal(previewStart.status, "started")
assert.equal(previewStart.session_id, "preview-session-1")
assert.deepEqual(plain(previewStart.request), { remoteUrl: "https://playground.wordpress.net/remote.html", corsProxyUrl: "https://playground.wordpress.net/proxy.php", scope: "preview-session-1", hasIframe: true, hasBlueprint: true })
assert.deepEqual(plain(previewStarts), [{ iframe: { tagName: "IFRAME" }, remoteUrl: "https://playground.wordpress.net/remote.html", corsProxyUrl: "https://playground.wordpress.net/proxy.php", scope: "preview-session-1", blueprint: { steps: [{ step: "login" }] } }])
assert.equal(typeof previewStart.dispose, "function", "successful previews expose async disposal without changing the result envelope")
const replayAbilityRequests: any[] = []
sandbox.window.wp = {
  apiFetch: async (request: any) => {
    replayAbilityRequests.push(request)
    if (request.path === "/wp-abilities/v1/abilities/wp-codebox/replay-browser-viewport/run") {
      return { success: true, schema: "wp-codebox/browser-viewport-replay-result/v1", status: "captured", png_base64: png }
    }
    return { artifact: { id: "viewport-replay", path: "files/browser/screenshot.png", sha256: "d".repeat(64) } }
  },
}
const replayCapture = await api.v1.captureViewportScreenshot(previewStart.client, { route: "/replayed", viewport: { width: 390, height: 844 }, timeout_ms: 5000 })
assert.equal(replayCapture.success, true)
assert.equal(replayCapture.artifact.id, "viewport-replay")
assert.deepEqual(plain(replayAbilityRequests.map(({ signal: _signal, ...request }: any) => request)), [
  {
    path: "/wp-abilities/v1/abilities/wp-codebox/replay-browser-viewport/run",
    method: "POST",
    data: {
      archive_base64: Buffer.from(previewArchive).toString("base64"),
      route: "/replayed",
      viewport: { width: 390, height: 844 },
      timeout_ms: 5000,
    },
  },
  {
    path: "/wp-abilities/v1/abilities/wp-codebox/persist-browser-artifact/run",
    method: "POST",
    data: {
      caller_schema: "wp-codebox/browser-viewport-screenshot/v1",
      caller_kind: "browser-viewport-screenshot",
      caller_metadata: { route: "/replayed", viewport: { width: 390, height: 844 }, diagnostics: [] },
      entrypoint: "screenshot.png",
      files: [{ path: "screenshot.png", content_base64: png, encoding: "base64", mime_type: "image/png", kind: "browser-screenshot" }],
    },
  },
])
delete sandbox.window.wp
const apiFetchRequests: any[] = []
const restRelativePreviewBoot = {
  ...previewFixture.response.preview_boot,
  blueprint_ref: {
    ...previewFixture.response.preview_boot.blueprint_ref,
    hydration_endpoint: "/wp-codebox/v1/browser-blueprint-ref?ref=prepared%3Apreview%3Aabc",
  },
}
sandbox.window.wp = {
  apiFetch: async (request: any) => {
    apiFetchRequests.push(request)
    return { schema: "wp-codebox/browser-blueprint-hydration/v1", blueprint: { steps: [{ step: "login" }] } }
  },
}
await api.v1.startBrowserPreview(restRelativePreviewBoot, {
  iframe: { tagName: "IFRAME" },
  startPlaygroundWeb: async () => ({ client: "playground" }),
})
assert.deepEqual(plain(apiFetchRequests), [{
  path: restRelativePreviewBoot.blueprint_ref.hydration_endpoint,
  method: "GET",
}])
delete sandbox.window.wp
await assert.rejects(
  () => api.v1.startBrowserPreview({
    ...previewFixture.response.preview_boot,
    blueprint_ref: { ...previewFixture.response.preview_boot.blueprint_ref, hydratable: false },
  }, { iframe: { tagName: "IFRAME" }, startPlaygroundWeb: async () => ({}) }),
  (error: any) => {
    assert.equal(error.code, "browser_preview_blueprint_ref_not_hydratable")
    return true
  },
)

const lifecycleBoot = {
  ...previewFixture.response.preview_boot,
  scope: "preview-lifecycle-test",
}
const preAborted = new AbortController()
preAborted.abort()
let preAbortStarted = false
await assert.rejects(
  () => api.v1.startBrowserPreview(lifecycleBoot, {
    signal: preAborted.signal,
    hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
    startPlaygroundWeb: async () => {
      preAbortStarted = true
      return {}
    },
  }),
  (error: any) => error.code === "browser_preview_aborted",
)
assert.equal(preAbortStarted, false, "a pre-aborted signal does not start Playground")

let finishHydration: ((value: unknown) => void) | undefined
let duringAbortStarted = false
const duringAbort = new AbortController()
const duringAbortIframe: { src: string } = { src: "https://playground.example/remote.html" }
const duringAbortStart = api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-abort-during-startup" }, {
  iframe: duringAbortIframe,
  signal: duringAbort.signal,
  hydrateBlueprintRef: () => new Promise((resolve) => {
    finishHydration = resolve
  }),
  startPlaygroundWeb: async () => {
    duringAbortStarted = true
    return {}
  },
})
duringAbort.abort()
await assert.rejects(duringAbortStart, (error: any) => error.code === "browser_preview_aborted")
finishHydration?.({ blueprint: { steps: [] } })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(duringAbortStarted, false, "aborting startup suppresses work after hydration")
assert.equal(duringAbortIframe.src, "about:blank", "aborting startup resets the associated iframe")

let finishLateStart: ((value: unknown) => void) | undefined
let lateStartReleased = 0
const lateStartAbort = new AbortController()
const lateStart = api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-abort-late-start" }, {
  iframe: { src: "https://playground.example/remote.html" },
  signal: lateStartAbort.signal,
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startPlaygroundWeb: () => new Promise((resolve) => {
    finishLateStart = resolve
  }),
  disposeClient: async () => { lateStartReleased += 1 },
})
await new Promise((resolve) => setTimeout(resolve, 0))
lateStartAbort.abort()
await assert.rejects(lateStart, (error: any) => error.code === "browser_preview_aborted")
finishLateStart?.({ client: "late-start" })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(lateStartReleased, 1, "an aborted late start releases its returned client")

const timeoutIframe: { src: string } = { src: "https://playground.example/remote.html" }
let timedOutStarts = 0
await assert.rejects(
  () => api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-startup-timeout" }, {
    iframe: timeoutIframe,
    startupTimeoutMs: 5,
    hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
    startPlaygroundWeb: () => new Promise(() => {}),
    disposeClient: async () => { timedOutStarts += 1 },
  }),
  (error: any) => {
    assert.equal(error.schema, "wp-codebox/browser-runtime-error/v1")
    assert.equal(error.phase, "browser_preview_start")
    assert.equal(error.code, "browser_preview_startup_timeout")
    assert.deepEqual(plain(error.data), {
      schema: "wp-codebox/browser-preview-startup-timeout/v1",
      phase: "startup",
      timeout_ms: 5,
      scope: "preview-startup-timeout",
      session_id: "preview-session-1",
      cleanup: {
        schema: "wp-codebox/browser-preview-dispose-result/v1",
        success: true,
        status: "disposed",
        scope: "preview-startup-timeout",
        iframe_reset: true,
        listeners_released: true,
        pending_work_cancellation_requested: true,
        pending_work_cancelled: false,
        stale_result_suppression_enabled: true,
        client_release_requested: false,
        client_released: false,
        client_release_error: null,
        client_release_evidence: null,
        runtime_release_requested: true,
        runtime_termination_requested: false,
        runtime_terminated: false,
        lifecycle_released: true,
      },
    })
    return true
  },
)
assert.equal(timedOutStarts, 0, "an unresolved startup has no client to release")
assert.equal(timeoutIframe.src, "about:blank", "startup timeout resets the associated iframe")

for (let index = 0; index < 3; index += 1) {
  await assert.rejects(
    () => api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-timeout-cycle" }, {
      iframe: { src: "https://playground.example/remote.html" },
      startupTimeoutMs: 5,
      hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
      startPlaygroundWeb: () => new Promise(() => {}),
    }),
    (error: any) => error.code === "browser_preview_startup_timeout",
  )
}
const timeoutCycleReplacement = await api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-timeout-cycle" }, {
  iframe: { src: "https://playground.example/remote.html" },
  startupTimeoutMs: 0,
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startPlaygroundWeb: async () => ({ client: "timeout-cycle-replacement" }),
})
assert.equal(timeoutCycleReplacement.client.client, "timeout-cycle-replacement", "repeated timeouts release scope ownership for a new preview")
await timeoutCycleReplacement.dispose()

let finishTimedOutStart: ((value: unknown) => void) | undefined
let timedOutLateRelease = 0
let timedOutLateCallbacks = 0
const timedOutLateStart = api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-timeout-late-start" }, {
  iframe: { src: "https://playground.example/remote.html" },
  startupTimeoutMs: 5,
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startOptions: { onClientConnected: () => { timedOutLateCallbacks += 1 } },
  startPlaygroundWeb: (request: Record<string, any>) => new Promise((resolve) => {
    finishTimedOutStart = (client) => {
      request.onClientConnected()
      resolve(client)
    }
  }),
  disposeClient: async () => { timedOutLateRelease += 1; return true },
})
await assert.rejects(timedOutLateStart, (error: any) => error.code === "browser_preview_startup_timeout")
finishTimedOutStart?.({ client: "timed-out-late-start" })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(timedOutLateRelease, 1, "a late timeout result releases its client exactly once")
assert.equal(timedOutLateCallbacks, 0, "a timed-out lifecycle suppresses late Playground callbacks")

let finishReplacedStart: ((value: unknown) => void) | undefined
let replacedLateRelease = 0
let replacedLateCallbacks = 0
const replacedStart = api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-replaced-start" }, {
  iframe: { src: "https://playground.example/remote.html" },
  startupTimeoutMs: 0,
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startOptions: { onClientConnected: () => { replacedLateCallbacks += 1 } },
  startPlaygroundWeb: (request: Record<string, any>) => new Promise((resolve) => {
    finishReplacedStart = (client) => {
      request.onClientConnected()
      resolve(client)
    }
  }),
  disposeClient: async () => { replacedLateRelease += 1; return true },
})
await new Promise((resolve) => setTimeout(resolve, 0))
const replacementAfterPendingStart = await api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-replaced-start" }, {
  iframe: { src: "https://playground.example/remote.html" },
  startupTimeoutMs: 5,
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startPlaygroundWeb: async () => ({ client: "replacement-after-pending-start" }),
})
await assert.rejects(replacedStart, (error: any) => error.code === "browser_preview_replaced")
finishReplacedStart?.({ client: "replaced-late-start" })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(replacedLateRelease, 1, "a replaced late start releases its client exactly once")
assert.equal(replacedLateCallbacks, 0, "a replaced lifecycle suppresses late Playground callbacks")
assert.equal(replacementAfterPendingStart.client.client, "replacement-after-pending-start", "same-scope replacement starts without awaiting the prior startup")
await replacementAfterPendingStart.dispose()

let replacementCleanupAttempted = false
const neverDisposes = await api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-hanging-replacement-cleanup" }, {
  iframe: { src: "https://playground.example/remote.html" },
  startupTimeoutMs: 0,
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startPlaygroundWeb: async () => ({ client: "hanging-cleanup" }),
  disposeClient: () => {
    replacementCleanupAttempted = true
    return new Promise(() => {})
  },
})
await assert.rejects(
  () => api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-hanging-replacement-cleanup" }, {
    iframe: { src: "https://playground.example/remote.html" },
    startupTimeoutMs: 5,
    hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
    startPlaygroundWeb: () => new Promise(() => {}),
  }),
  (error: any) => error.code === "browser_preview_startup_timeout",
)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(replacementCleanupAttempted, true, "replacement starts the prior client cleanup without waiting for it")

const lifecycleCallbacks: Record<string, (...args: any[]) => unknown> = {}
const lifecycleIframe: { src: string } = { src: "https://playground.example/remote.html" }
let callbackMutations = 0
let releasedClients = 0
let lifecycleClientReleased = false
const lifecycleClient = {
  client: "lifecycle-playground",
  run: async () => {
    if (lifecycleClientReleased) throw new Error("released")
    return "running"
  },
}
const lifecyclePreview = await api.v1.startBrowserPreview(lifecycleBoot, {
  iframe: lifecycleIframe,
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startOptions: {
    onBlueprintStepCompleted: () => { callbackMutations += 1 },
    onBlueprintValidated: () => { callbackMutations += 1 },
    onClientConnected: () => { callbackMutations += 1 },
  },
  startPlaygroundWeb: async (request: Record<string, any>) => {
    Object.assign(lifecycleCallbacks, {
      onBlueprintStepCompleted: request.onBlueprintStepCompleted,
      onBlueprintValidated: request.onBlueprintValidated,
      onClientConnected: request.onClientConnected,
    })
    return lifecycleClient
  },
  disposeClient: async (client: { client: string }) => {
    assert.equal(client.client, "lifecycle-playground")
    lifecycleClientReleased = true
    releasedClients += 1
    return { client_released: true, runtime_termination_requested: false, runtime_terminated: false }
  },
})
lifecycleCallbacks.onBlueprintStepCompleted()
lifecycleCallbacks.onBlueprintValidated()
lifecycleCallbacks.onClientConnected()
assert.equal(callbackMutations, 3, "Playground lifecycle callbacks retain existing behavior while active")
const disposed = await lifecyclePreview.dispose()
assert.deepEqual(plain(disposed), {
  schema: "wp-codebox/browser-preview-dispose-result/v1",
  success: true,
  status: "disposed",
  scope: "preview-lifecycle-test",
  iframe_reset: true,
  listeners_released: true,
  pending_work_cancellation_requested: true,
  pending_work_cancelled: false,
  stale_result_suppression_enabled: true,
  client_release_requested: true,
  client_released: true,
  client_release_error: null,
  client_release_evidence: { client_released: true, runtime_termination_requested: false, runtime_terminated: false },
  runtime_release_requested: true,
  runtime_termination_requested: false,
  runtime_terminated: false,
  lifecycle_released: true,
})
assert.equal(await lifecyclePreview.dispose(), disposed, "preview disposal is idempotent")
assert.equal(releasedClients, 1, "disposal releases a host-owned client connection once")
await assert.rejects(() => lifecyclePreview.client.run(), /released/, "disposed previews release the old client")
assert.equal(lifecycleIframe.src, "about:blank", "disposal resets but does not remove the caller-owned iframe")
lifecycleCallbacks.onBlueprintStepCompleted()
lifecycleCallbacks.onBlueprintValidated()
lifecycleCallbacks.onClientConnected()
assert.equal(callbackMutations, 3, "disposed previews suppress late Playground lifecycle callbacks")
const replacementPreview = await api.v1.startBrowserPreview(lifecycleBoot, {
  iframe: { src: "https://playground.example/remote.html" },
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startPlaygroundWeb: async () => ({ client: "replacement-playground" }),
})
assert.equal(replacementPreview.client.client, "replacement-playground", "disposing releases a scope for a replacement preview")
const defaultDispose = await replacementPreview.dispose()
assert.equal(defaultDispose.client_release_requested, false, "default disposal does not claim a client release")
assert.equal(defaultDispose.client_released, false, "default disposal does not verify a client release")
assert.equal(defaultDispose.runtime_release_requested, true, "iframe reset requests runtime release")
assert.equal(defaultDispose.runtime_terminated, false, "default disposal does not verify runtime termination")

let moduleDisposedClient: unknown
const moduleDisposePreview = await api.v1.startBrowserPreview({ ...lifecycleBoot, client_module_url: "https://playground.example/client/index.js", scope: "preview-module-dispose-test" }, {
  iframe: { src: "https://playground.example/remote.html" },
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  importModule: async () => ({
    startPlaygroundWeb: async () => lifecycleClient,
    disposePlaygroundClient: async (client: unknown) => {
      moduleDisposedClient = client
      return { client_released: true, runtime_termination_requested: true, runtime_terminated: false }
    },
  }),
})
const moduleDisposeResult = await moduleDisposePreview.dispose()
assert.equal(moduleDisposedClient, lifecycleClient, "default disposal delegates runtime teardown to the imported Playground module")
assert.equal(moduleDisposeResult.client_release_requested, true, "module-owned runtime teardown is reported as requested")
assert.equal(moduleDisposeResult.client_released, true, "module-owned client release evidence is preserved")
assert.equal(moduleDisposeResult.runtime_termination_requested, true, "module-owned runtime termination request evidence is preserved")
assert.equal(moduleDisposeResult.runtime_terminated, false, "module-owned teardown does not overstate confirmed runtime termination")

let replacementReleased = 0
const replacementCallbacks: Record<string, () => unknown> = {}
const firstReplacement = await api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-replacement-test" }, {
  iframe: { src: "https://playground.example/remote.html" },
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startOptions: { onClientConnected: () => { callbackMutations += 1 } },
  startPlaygroundWeb: async (request: Record<string, any>) => {
    replacementCallbacks.onClientConnected = request.onClientConnected
    return { client: "first-replacement" }
  },
  disposeClient: async () => { replacementReleased += 1; return true },
})
const secondReplacement = await api.v1.startBrowserPreview({ ...lifecycleBoot, scope: "preview-replacement-test" }, {
  iframe: { src: "https://playground.example/remote.html" },
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startPlaygroundWeb: async () => ({ client: "second-replacement" }),
})
replacementCallbacks.onClientConnected()
assert.equal(replacementReleased, 1, "replacement releases the prior scope owner")
assert.equal(callbackMutations, 3, "replacement suppresses callbacks from prior ownership")
await firstReplacement.dispose()
await secondReplacement.dispose()

let repeatedReleases = 0
for (let index = 0; index < 8; index += 1) {
  const preview = await api.v1.startBrowserPreview({ ...lifecycleBoot, scope: `preview-cycle-${index}` }, {
    iframe: { src: "https://playground.example/remote.html" },
    hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
    startPlaygroundWeb: async () => ({ client: index }),
    disposeClient: async () => { repeatedReleases += 1 },
  })
  await Promise.all([preview.dispose(), preview.dispose()])
}
assert.equal(repeatedReleases, 8, "repeated preview disposal remains bounded and idempotent")

const workspaceChildren: any[] = []
const workspaceContainer = {
	attach(iframe: any) {
		iframe.parentNode = this
		iframe.remove = () => {
			const index = workspaceChildren.indexOf(iframe)
			if (index >= 0) workspaceChildren.splice(index, 1)
			iframe.parentNode = null
		}
	},
  appendChild(iframe: any) {
	this.attach(iframe)
    workspaceChildren.push(iframe)
  },
	replaceChild(next: any, previous: any) {
		const index = workspaceChildren.indexOf(previous)
		assert.notEqual(index, -1)
		previous.parentNode = null
		this.attach(next)
		workspaceChildren[index] = next
	},
}
const createWorkspaceIframe = () => ({
  src: "about:blank",
  loading: "lazy",
  style: { display: "" },
  attributes: {} as Record<string, string>,
  setAttribute(name: string, value: string) { this.attributes[name] = value },
  removeAttribute(name: string) { delete this.attributes[name] },
  cloneNode() { return createWorkspaceIframe() },
})
const workspaceTemplate: any = createWorkspaceIframe()
workspaceTemplate.parentNode = workspaceContainer
const workspaceStarts: string[] = []
const workspaceReleases: string[] = []
const workspaceNavigations: string[] = []
const workspaceNavigationErrors: string[] = []
const previewBuffer = api.v1.createBrowserPreviewBuffer({ iframe: workspaceTemplate, activeAttribute: "data-preview-active" })
const workspaceBoot = (key: string) => ({ ...lifecycleBoot, scope: `workspace-${key}` })
const prepareWorkspacePreview = (slot: string, key: string) => previewBuffer.prepare(slot, workspaceBoot(key), {
  hydrateBlueprintRef: async () => ({ blueprint: { steps: [] } }),
  startPlaygroundWeb: async (request: any) => {
	assert.equal(request.iframe.style.display, "none", "prepared standby runtimes remain invisible")
	assert.equal(request.iframe.loading, "eager", "Codebox owns startup instead of deferring to iframe lazy loading")
    workspaceStarts.push(key)
    return {
      client: key,
      goTo: async (path: string) => {
        workspaceNavigations.push(`${key}:${path}`)
        if (key === "blank-replenishment") throw new Error("late navigation failure")
      },
    }
  },
  disposeClient: async () => {
    workspaceReleases.push(key)
    return true
  },
})
const workspaceA = await prepareWorkspacePreview("slot-a", "site-a@revision-1")
await previewBuffer.activate("slot-a")
assert.deepEqual(plain(await workspaceA.navigate("/site-a")), {
  schema: "wp-codebox/browser-preview-navigation-result/v1",
  success: true,
  status: "requested",
  slot: "slot-a",
  path: "/site-a",
})
const workspaceB = await prepareWorkspacePreview("slot-b", "site-b@revision-1")
assert.equal(previewBuffer.has("slot-a"), true)
assert.equal(await previewBuffer.prepare("slot-a", workspaceBoot("unused")), workspaceA, "preparing an occupied slot returns it without replacing its runtime")
assert.deepEqual(workspaceStarts, ["site-a@revision-1", "site-b@revision-1"], "preparing the double buffer starts exactly two runtimes")
assert.equal(previewBuffer.activeSlot, "slot-a")
assert.equal(previewBuffer.size, 2)
assert.equal(workspaceA.iframe.style.display, "")
assert.equal(workspaceB.iframe.style.display, "none")
assert.equal(workspaceA.iframe.attributes["data-preview-active"], "")
assert.equal(workspaceB.iframe.attributes["data-preview-active"], undefined)
await assert.rejects(() => prepareWorkspacePreview("slot-c", "site-c@revision-1"), (error: any) => error.code === "browser_preview_buffer_full")
await previewBuffer.activate("slot-b")
assert.equal(workspaceA.iframe.style.display, "none", "activation atomically hides the old active iframe")
assert.equal(workspaceB.iframe.style.display, "")
await previewBuffer.release("slot-a")
assert.deepEqual(workspaceReleases, ["site-a@revision-1"], "releasing the old active runtime is explicit")
assert.equal(workspaceChildren.length, 1, "release removes the lifecycle replacement iframe instead of leaking an about:blank browsing context")
const replenishedA = await prepareWorkspacePreview("slot-a", "blank-replenishment")
assert.notEqual(replenishedA.iframe, workspaceA.iframe, "replenishment uses a fresh iframe and runtime")
assert.equal(workspaceB.iframe.style.display, "", "the active site remains visible while standby replenishes")
assert.equal((await replenishedA.navigate("/slow", { onError: (error: Error) => workspaceNavigationErrors.push(error.message) })).status, "requested")
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(workspaceNavigations, ["site-a@revision-1:/site-a", "blank-replenishment:/slow"])
assert.deepEqual(workspaceNavigationErrors, ["late navigation failure"], "navigation dispatch reports asynchronous client failures without blocking readiness")
await previewBuffer.dispose()
assert.deepEqual(workspaceReleases, ["site-a@revision-1", "site-b@revision-1", "blank-replenishment"])
assert.equal(workspaceTemplate.style.display, "", "workspace disposal restores the caller's template iframe")

const parentRequest = api.v1.createParentToolRequest(executableSession, "workspace.read", "read", { path: "README.md" })
assert.equal(parentRequest.schema, "wp-codebox/parent-tool-request/v1")
assert.equal(parentRequest.sandbox_session.sandbox_session_id, "executable-session-1")
assert.deepEqual(plain(parentRequest.authorization.allowed_tools), ["workspace.read"])
await assert.rejects(
  () => api.v1.dispatchParentTool(executableSession, "workspace.write", "write", {}, { dispatchParentTool: async () => ({}) }),
  (error: any) => {
    assert.equal(error.code, "parent_tool_denied")
    return true
  },
)

console.log("browser sdk facade ok")
