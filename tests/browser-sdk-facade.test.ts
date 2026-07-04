import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

import { browserArtifactPersistenceProjection } from "../packages/runtime-core/src/index.js"

const root = new URL("../", import.meta.url)
const runtimeSource = await readFile(new URL("packages/wordpress-plugin/assets/browser-runtime.js", root), "utf8")

const sandbox = {
  window: { dispatchEvent: () => true } as { wpCodebox?: Record<string, any>, wpCodeboxBrowser?: Record<string, any>, wp?: Record<string, any>, dispatchEvent?: (event: any) => boolean },
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
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
  ],
  globals: {
    name: "wpCodeboxBrowser",
    facade: "wpCodeboxBrowser.v1",
  },
})

assert.equal(api.v1.methods.runPhpRequest, api.runPhpRequest)
assert.equal(api.v1.methods.writeFile, api.writeFile)
assert.equal(api.v1.methods.validateBrowserRuntimeMaterialization, api.validateBrowserRuntimeMaterialization)
assert.equal(typeof api.v1.setFrontendAdminBarVisible, "function")
assert.equal(api.v1.methods.setFrontendAdminBarVisible, api.setFrontendAdminBarVisible)
assert.equal(typeof api.v1.runBrowserSessionRecipe, "function")
assert.equal(typeof api.v1.startBrowserPreview, "function")
assert.equal(typeof api.v1.consumeContainedSiteSync, "function")
assert.equal(typeof api.v1.openOrCreateBrowserContainedSite, "function")
const studioNativeConsumedTopLevelMethods = [
  "consumeContainedSiteSync",
  "ensureDirectory",
  "openOrCreateBrowserContainedSite",
  "runBrowserSessionRecipe",
  "runRecipe",
  "setFrontendAdminBarVisible",
  "writeFile",
] as const
for (const method of studioNativeConsumedTopLevelMethods) {
  assert.equal(typeof api.v1[method], "function", `Studio Native consumes wpCodeboxBrowser.v1.${method} top-level`)
}
assert.equal(Object.isFrozen(api.v1), true, "browser SDK v1 facade remains frozen")
assert.equal(typeof api.v1.bootExecutableBrowserSession, "function")
assert.equal(typeof api.v1.createBrowserConnectorRequest, "function")
assert.equal(typeof api.v1.executeBrowserConnectorRequest, "function")
assert.equal(typeof api.v1.createParentToolRequest, "function")
assert.equal(typeof api.v1.validateBrowserRuntimeMaterialization, "function")
assert.equal(typeof api.v1.createRuntimeTaskRequest, "function")
assert.equal(typeof api.v1.runRuntimeTask, "function")
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
  forceRequest: true,
})
assert.equal(directRunCode.includes("wp_json_encode"), true)
assert.deepEqual(plain(directRunResult), { success: true, data: { mode: "direct-run" }, error: null })

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
const previewStart = await sandbox.window.wpCodebox!.startBrowserPreview({
  schema: "wp-codebox/browser-preview-boot-config/v1",
  session_id: "preview-session-1",
  remote_url: "https://playground.wordpress.net/remote.html",
  cors_proxy_url: "https://playground.wordpress.net/proxy.php",
  scope: "preview-session-1",
  blueprint_ref_dto: { schema: "wp-codebox/browser-blueprint-ref/v1", ref: "prepared:preview:abc", hydrator_ability: "wp-codebox/hydrate-browser-blueprint-ref" },
  preview: { public_url: "https://preview.example.test/" },
}, {
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
})
assert.equal(previewStart.schema, "wp-codebox/browser-preview-start-result/v1")
assert.equal(previewStart.success, true)
assert.equal(previewStart.status, "started")
assert.equal(previewStart.session_id, "preview-session-1")
assert.deepEqual(plain(previewStart.request), { remoteUrl: "https://playground.wordpress.net/remote.html", corsProxyUrl: "https://playground.wordpress.net/proxy.php", scope: "preview-session-1", hasIframe: true, hasBlueprint: true })
assert.deepEqual(plain(previewStarts), [{ iframe: { tagName: "IFRAME" }, remoteUrl: "https://playground.wordpress.net/remote.html", corsProxyUrl: "https://playground.wordpress.net/proxy.php", scope: "preview-session-1", blueprint: { steps: [{ step: "login" }] } }])

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
