import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

const root = new URL("../", import.meta.url)
const runtimeSource = await readFile(new URL("packages/wordpress-plugin/assets/browser-runtime.js", root), "utf8")

const sandbox = {
  window: {} as { wpCodeboxBrowser?: Record<string, any> },
  btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  TextDecoder,
  TextEncoder,
  URL,
}

vm.runInNewContext(runtimeSource, sandbox, { filename: "browser-runtime.js" })

const api = sandbox.window.wpCodeboxBrowser
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

assert.ok(api, "browser runtime must publish window.wpCodeboxBrowser")
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

console.log("browser sdk facade ok")
