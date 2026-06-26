import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

const root = new URL("../", import.meta.url)
const runtimeSource = await readFile(new URL("packages/wordpress-plugin/assets/browser-runtime.js", root), "utf8")

const sandbox = {
  window: {} as { wpCodebox?: Record<string, any>, wpCodeboxBrowser?: Record<string, any> },
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
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
    "browser-preview:start",
    "browser-contained-site-sync:consume",
    "browser-runtime:boot-executable-session",
    "browser-runtime:parent-tool-bridge",
    "browser-runtime:aggregate-fanout-outputs",
    "browser-runtime:invoke-result",
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
assert.equal(typeof api.v1.runBrowserSessionRecipe, "function")
assert.equal(typeof api.v1.startBrowserPreview, "function")
assert.equal(typeof api.v1.consumeContainedSiteSync, "function")
assert.equal(typeof api.v1.bootExecutableBrowserSession, "function")
assert.equal(typeof api.v1.createParentToolRequest, "function")
assert.equal(typeof api.v1.validateBrowserRuntimeMaterialization, "function")
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

const previousFetch = (sandbox as any).fetch
const requestedRoutes: Array<{ route: string, method: string, body?: string }> = []
;(sandbox as any).fetch = async (route: string, request: { method?: string, body?: string } = {}) => {
  requestedRoutes.push({ route, method: request.method || "GET", body: request.body })
  const payloadByRoute: Record<string, unknown> = {
    "/playground-site-sync/v1/manifest": { schema: "playground-site-sync/manifest/v1" },
    "/playground-site-sync/v1/resources": { schema: "playground-site-sync/resources/v1" },
    "/playground-site-sync/v1/export": {
      schema: "playground-site-sync/playground-package/v1",
      descriptor: { bootable: true },
      blueprint: { steps: [] },
      base_snapshot: "snapshot-1",
    },
    "/playground-site-sync/v1/apply-plan/generate": { schema: "playground-site-sync/apply-plan/v1", apply_plan: { steps: [] } },
    "/playground-site-sync/v1/apply-plan/validate": { schema: "playground-site-sync/validation/v1", validation_hash: "validation-1" },
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
    manifest: "/playground-site-sync/v1/manifest",
    resources: "/playground-site-sync/v1/resources",
    export: "/playground-site-sync/v1/export",
    apply_plan_generate: "/playground-site-sync/v1/apply-plan/generate",
    apply_plan_validate: "/playground-site-sync/v1/apply-plan/validate",
  },
}, { projectId: 123 })
assert.equal(syncConsumption.schema, "wp-codebox/browser-contained-site-sync-consumption/v1")
assert.equal(syncConsumption.status, "success")
assert.equal(syncConsumption.project_id, 123)
assert.equal(syncConsumption.hydration.status, "ready")
assert.equal(syncConsumption.validation_hash, "validation-1")
assert.deepEqual(requestedRoutes.map(({ route, method }) => `${method} ${route}`), [
  "GET /playground-site-sync/v1/manifest",
  "GET /playground-site-sync/v1/resources",
  "POST /playground-site-sync/v1/export",
  "POST /playground-site-sync/v1/apply-plan/generate",
  "POST /playground-site-sync/v1/apply-plan/validate",
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

assert.deepEqual(plain(api.v1.browserArtifactPersistenceRef({
  schema: "wp-codebox/browser-artifact-persistence/ref/v1",
  artifactRefs: [
    { kind: "artifact-bundle", id: "artifact-bundle-sha256-abc", directory: "artifacts/run-1", contentDigest: { algorithm: "sha256", value: "abc" } },
  ],
}).artifactRefs), [
  { kind: "artifact-bundle", id: "artifact-bundle-sha256-abc", path: "artifacts/run-1", digest: { algorithm: "sha256", value: "abc" } },
])

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
