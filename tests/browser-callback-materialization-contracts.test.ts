import assert from "node:assert/strict"
import { createServer } from "node:http"
import {
  browserArtifactGrant,
  browserArtifactPersistenceProjection,
  browserArtifactRef,
  browserCallbackCapability,
  browserCallbackResultEnvelope,
  browserCallbackSignature,
  materializationResultEnvelope,
  materializationPhaseResult,
  materializationRunArtifactRefs,
  normalizeMaterializationResultEnvelope,
  trustedBrowserSessionOrigin,
  trustedBrowserSessionOrigins,
  verifyBrowserCallbackSignature,
} from "../packages/runtime-core/src/index.js"
import { browserPreviewAuthCookieUrls, browserPreviewTopology } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { closeHttpServer, listenLocalHttpServer, withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

assert.deepEqual(trustedBrowserSessionOrigin("http://localhost:8881/path?x=1"), {
  schema: "wp-codebox/trusted-browser-session-origin/v1",
  origin: "http://localhost:8881",
  secure: true,
  loopback: true,
})
assert.throws(() => trustedBrowserSessionOrigin("http://example.test"), /https/)
assert.equal(trustedBrowserSessionOrigins(["https://example.test/a", "https://example.test/b"]).length, 1)

const artifactGrant = browserArtifactGrant({
  caller: "studio-web",
  sessionId: "session-123",
  expiresAt: new Date("2026-01-02T03:04:05.000Z"),
  artifactsPath: "/tmp/wp-codebox/artifacts",
})
assert.deepEqual(artifactGrant, {
  schema: "wp-codebox/browser-artifact-grant/v1",
  scope: "artifact:write",
  session_id: "session-123",
  authorization: {
    schema: "wp-codebox/trusted-orchestrator-authorization/v1",
    caller: "studio-web",
    scope: "artifact:write",
  },
  expires_at: "2026-01-02T03:04:05.000Z",
  artifacts_path: "/tmp/wp-codebox/artifacts",
})
assert.deepEqual(browserArtifactRef({ artifact_id: "artifact-bundle-sha256-abc", content_digest: "abc", directory: "/tmp/wp-codebox/artifacts/artifact-bundle-sha256-abc", status: "created", session_id: "session-123", grant: artifactGrant }), {
  schema: "wp-codebox/browser-artifact-ref/v1",
  artifact_id: "artifact-bundle-sha256-abc",
  content_digest: "abc",
  artifacts_path: "/tmp/wp-codebox/artifacts/artifact-bundle-sha256-abc",
  status: "created",
  session_id: "session-123",
  grant: artifactGrant,
})
assert.throws(() => browserArtifactGrant({ caller: "", sessionId: "session-123" }), /caller/)
assert.throws(() => browserArtifactRef({ content_digest: "abc" }), /artifact_id/)

const callbackCapability = browserCallbackCapability({
  capability: "persist-browser-artifact",
  ability: "wp-codebox/persist-browser-artifact",
  caller: "studio-web",
  scope: "artifact:write",
  allowedOrigins: ["https://playground.wordpress.net/editor", "https://playground.wordpress.net/"],
})
assert.deepEqual(callbackCapability, {
  schema: "wp-codebox/browser-callback-capability/v1",
  capability: "persist-browser-artifact",
  ability: "wp-codebox/persist-browser-artifact",
  authorization: {
    schema: "wp-codebox/trusted-orchestrator-authorization/v1",
    caller: "studio-web",
    scope: "artifact:write",
  },
  allowedOrigins: ["https://playground.wordpress.net"],
  signatureHeader: "x-wp-codebox-callback-signature",
  timestampHeader: "x-wp-codebox-callback-timestamp",
  maxAgeSeconds: 300,
})
const callbackBody = JSON.stringify({ files: [{ path: "website/index.html", content: "ok" }] })
const callbackSignature = browserCallbackSignature(callbackBody, "secret", "2026-01-02T03:04:05.000Z")
assert.equal(callbackSignature, "sha256=f1ed25e24ee4803ddd73238fcfa6eb965af2b96efc03ca61fb35a96b4e59453a")
assert.equal(verifyBrowserCallbackSignature({ body: callbackBody, secret: "secret", timestamp: "2026-01-02T03:04:05.000Z", signature: callbackSignature }), true)
assert.equal(verifyBrowserCallbackSignature({ body: callbackBody, secret: "secret", timestamp: "2026-01-02T03:04:05.000Z", signature: callbackSignature.replace(/.$/, "0") }), false)

const topology = browserPreviewTopology(
  ["preview-mode=secure", "route-host=example.test,static.example.test", "network-policy=block", "allow-host=cdn.example.test"],
  { preview: { publicUrl: "https://example.test/site" } },
  "http://127.0.0.1:9400",
)
assert.equal(topology.preview.effectiveOrigin, "https://example.test/site")
assert.equal(topology.resolveUrl("/wp-admin/"), "https://example.test/wp-admin/")
assert.deepEqual(topology.routedHosts, ["example.test", "static.example.test"])
assert.deepEqual(topology.origins, {
  localPreviewOrigin: "http://127.0.0.1:9400",
  requestedPreviewOrigin: "https://example.test/site",
  effectivePreviewOrigin: "https://example.test/site",
})
assert.deepEqual(topology.authCookieUrls(["https://example.test/wp-admin/"]), [
  "http://127.0.0.1/",
  "https://example.test/",
  "https://static.example.test/",
])
assert.equal(topology.networkPolicy.mode, "block")
assert.deepEqual([...topology.networkPolicy.routeHosts].sort(), ["example.test", "static.example.test"])
assert.deepEqual(browserPreviewAuthCookieUrls("http://localhost:9400", ["PUBLIC.example.test"], ["https://public.example.test/wp-admin/"]), ["http://localhost/", "https://public.example.test/"])

let activeUpstreamRequests = 0
let maxActiveUpstreamRequests = 0
const targetServer = createServer(async (_request, response) => {
  activeUpstreamRequests += 1
  maxActiveUpstreamRequests = Math.max(maxActiveUpstreamRequests, activeUpstreamRequests)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  activeUpstreamRequests -= 1
  response.end("ok")
})
const targetServerUrl = await listenLocalHttpServer(targetServer)
let disposed = false
const proxied = await withPreviewProxy({
  playground: { async run() { return { text: "" } } },
  serverUrl: targetServerUrl,
  async [Symbol.asyncDispose]() {
    disposed = true
  },
} satisfies PlaygroundCliServer, 0)
try {
  assert.deepEqual(proxied.previewProxyDiagnostics, {
    schema: "wp-codebox/preview-proxy-diagnostics/v1",
    upstreamConcurrency: "serialized",
    maxConcurrentUpstreamRequests: 1,
    queue: "fifo",
    bind: "127.0.0.1",
    targetOrigin: new URL(targetServerUrl).origin,
  })
  await Promise.all([fetch(proxied.serverUrl), fetch(proxied.serverUrl)])
  assert.equal(maxActiveUpstreamRequests, 1)
} finally {
  await proxied[Symbol.asyncDispose]()
  await closeHttpServer(targetServer)
}
assert.equal(disposed, true)

const phase = materializationPhaseResult({
  phase: "persist-browser-artifacts",
  status: "completed",
  artifactRefs: [{ kind: "browser-bundle", path: "files/browser/index.html", digest: { algorithm: "sha256", value: "abc" } }],
})
assert.equal(phase.schema, "wp-codebox/materialization-phase-result/v1")
assert.deepEqual(materializationRunArtifactRefs([phase]), [
  {
    kind: "materialization:browser-bundle",
    path: "files/browser/index.html",
    digest: { algorithm: "sha256", value: "abc" },
  },
])

const failedMaterializationEnvelope = materializationResultEnvelope({
  task: "package-runtime-replay",
  status: "failed",
  phases: [materializationPhaseResult({
    phase: "snapshot-validation",
    status: "failed",
    error: { name: "Error", message: "invalid snapshot", code: "invalid-snapshot" },
  })],
  projections: [{ kind: "browser-artifacts", schema: "wp-codebox/browser-artifact-persistence-projection/v1", artifacts: [] }],
})
assert.equal(failedMaterializationEnvelope.schema, "wp-codebox/materialization-result/v1")
assert.equal(failedMaterializationEnvelope.status, "failed")
assert.equal(failedMaterializationEnvelope.success, false)
assert.equal(failedMaterializationEnvelope.error.message, "invalid snapshot")
assert.deepEqual(failedMaterializationEnvelope.diagnostics, [{
  code: "invalid-snapshot",
  message: "invalid snapshot",
  severity: "error",
  phase: "snapshot-validation",
}])
assert.equal(failedMaterializationEnvelope.projections?.[0]?.kind, "browser-artifacts")

const materializationEnvelope = normalizeMaterializationResultEnvelope({
  success: true,
  response: {
    schema: "wp-codebox/materialization-result/v1",
    task: "persist-browser-artifacts",
    success: true,
    response: {
      success: true,
      result: {
        artifact: { path: "files/browser/index.html", kind: "browser-html", sha256: "def" },
        artifact_bundle: { id: "artifact-bundle-sha256-abc", contentDigest: { algorithm: "sha256", value: "abc" }, directory: "artifacts/run-1" },
        materialization: { id: "materialization-1", status: "completed" },
      },
    },
  },
})
assert.equal(materializationEnvelope.schema, "wp-codebox/materialization-result/v1")
assert.equal(materializationEnvelope.task, "persist-browser-artifacts")
const projection = browserArtifactPersistenceProjection(materializationEnvelope)
assert.equal(projection.schema, "wp-codebox/browser-artifact-persistence-projection/v1")
assert.deepEqual(projection.artifacts, [{ path: "files/browser/index.html", kind: "browser-html", sha256: "def" }])
assert.deepEqual(projection.artifactRefs, [
  {
    kind: "artifact-bundle",
    id: "artifact-bundle-sha256-abc",
    path: "artifacts/run-1",
    digest: { algorithm: "sha256", value: "abc" },
  },
  {
    kind: "browser-html",
    path: "files/browser/index.html",
    digest: { algorithm: "sha256", value: "def" },
  },
  {
    kind: "materialization",
    id: "materialization-1",
  },
])
const callbackEnvelope = browserCallbackResultEnvelope({
  capability: "persist-browser-artifact",
  ability: "wp-codebox/persist-browser-artifact",
  result: materializationEnvelope.result,
})
assert.equal(callbackEnvelope.schema, "wp-codebox/browser-callback-result/v1")
assert.deepEqual(callbackEnvelope.artifactRefs, projection.artifactRefs)
assert.throws(() => normalizeMaterializationResultEnvelope({ success: true, response: { success: false, error: { message: "fixture failure" } } }), /fixture failure/)
