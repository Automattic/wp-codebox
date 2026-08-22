import assert from "node:assert/strict"
import { createServer } from "node:http"
import {
  artifactBundleFileManifest,
  browserRunResultEnvelope,
  browserArtifactGrant,
  browserArtifactPersistenceProjection,
  browserArtifactRef,
  browserCallbackCapability,
  browserCallbackResultEnvelope,
  browserCallbackSignature,
  extractMaterializationResultEnvelope,
  materializationResultEnvelope,
  materializationPhaseResult,
  materializationRunArtifactRefs,
  normalizeBrowserRunResult,
  normalizeMaterializationArtifactRefs,
  normalizeMaterializationResultEnvelope,
  persistedBrowserArtifactRefs,
  trustedBrowserSessionOrigin,
  trustedBrowserSessionOrigins,
  verifyBrowserCallbackSignature,
} from "../packages/runtime-core/src/index.js"
import { browserPreviewAuthCookieUrls, browserPreviewReadinessError, browserPreviewTopology } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { browserReviewSummary, type BrowserArtifact } from "../packages/runtime-playground/src/browser-artifacts.js"
import { closeHttpServer, listenLocalHttpServer, withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  canonicalBrowserOrigin: "https://example.test",
  localProxyOrigin: "http://127.0.0.1:9400",
})
assert.deepEqual(topology.authCookieUrls(["https://example.test/wp-admin/"]), [
  "http://127.0.0.1/",
  "https://example.test/",
  "https://static.example.test/",
])
assert.equal(topology.networkPolicy.mode, "block")
assert.deepEqual([...topology.networkPolicy.routeHosts].sort(), ["example.test", "static.example.test"])
assert.deepEqual(topology.navigationScope.resolve("/beta/", "https://example.test/alpha/"), {
  allowed: true,
  rawOrigin: "https://example.test",
  effectiveOrigin: "https://example.test",
  routeDecision: "relative",
  reason: "effective-preview-origin",
})
assert.deepEqual(topology.navigationScope.resolve("http://static.example.test:8080/alpha/", "https://example.test/"), {
  allowed: true,
  rawOrigin: "http://static.example.test:8080",
  effectiveOrigin: "https://example.test",
  routeDecision: "routed-preview",
  reason: "declared-route-host",
})
assert.deepEqual(topology.navigationScope.resolve("https://cdn.example.test/asset", "https://example.test/"), {
  allowed: false,
  rawOrigin: "https://cdn.example.test",
  effectiveOrigin: "https://cdn.example.test",
  routeDecision: "external",
  reason: "network-host-allowed-but-not-routed",
})
assert.equal(topology.navigationScope.resolve("https://outside.example/", "https://example.test/").reason, "host-not-routed-to-preview")
assert.deepEqual(browserPreviewAuthCookieUrls("http://localhost:9400", ["PUBLIC.example.test"], ["https://public.example.test/wp-admin/"]), ["http://localhost/", "https://public.example.test/"])

const canonicalTopology = browserPreviewTopology(
  ["route-host=localhost"],
  { preview: { siteUrl: "http://localhost/events/" } },
  "http://127.0.0.1:9400",
  "http://127.0.0.1:9500",
)
assert.equal(canonicalTopology.preview.effectiveOrigin, "http://localhost/events/")
assert.equal(canonicalTopology.resolveUrl("/events/near-me/"), "http://localhost/events/near-me/")
assert.deepEqual(canonicalTopology.origins, {
  localPreviewOrigin: "http://127.0.0.1:9400",
  effectivePreviewOrigin: "http://localhost/events/",
  canonicalBrowserOrigin: "http://localhost",
  localProxyOrigin: "http://127.0.0.1:9400",
  upstreamRuntimeOrigin: "http://127.0.0.1:9500",
})
assert.equal(canonicalTopology.preview.diagnostics[0]?.code, "preview-canonical-routed-origin")
const canonicalReview = browserReviewSummary([{
  artifactType: "probe",
  requestedUrl: "http://localhost/events/",
  url: "http://localhost/events/",
  preview: canonicalTopology.preview,
  ...canonicalTopology.origins,
  files: { summary: "files/browser/summary.json" },
  summary: { consoleMessages: 0, errors: 0, htmlSnapshot: false, networkEvents: 0, replayability: "diagnostic-only", screenshot: false, viewport: null },
} satisfies BrowserArtifact])
assert.deepEqual(canonicalReview?.probes[0] && {
  canonicalBrowserOrigin: canonicalReview.probes[0].canonicalBrowserOrigin,
  localProxyOrigin: canonicalReview.probes[0].localProxyOrigin,
  upstreamRuntimeOrigin: canonicalReview.probes[0].upstreamRuntimeOrigin,
}, {
  canonicalBrowserOrigin: "http://localhost",
  localProxyOrigin: "http://127.0.0.1:9400",
  upstreamRuntimeOrigin: "http://127.0.0.1:9500",
})
const unsupportedCanonicalTopology = browserPreviewTopology(
  ["route-host=secure.example.test"],
  { preview: { siteUrl: "https://secure.example.test/" } },
  "http://127.0.0.1:9400",
)
assert.equal(unsupportedCanonicalTopology.preview.effectiveOrigin, "http://127.0.0.1:9400")
assert.deepEqual(unsupportedCanonicalTopology.preview.diagnostics[0], {
  code: "preview-canonical-origin-preservation-inconclusive",
  severity: "error",
  message: "The local Playground provider cannot preserve this declared canonical preview protocol.",
  details: { status: "inconclusive", canonicalOrigin: "https://secure.example.test", supportedProtocols: ["http:"] },
})
assert.match(browserPreviewReadinessError(unsupportedCanonicalTopology.preview)?.message ?? "", /cannot preserve/)

let activeUpstreamRequests = 0
let maxActiveUpstreamRequests = 0
let forwardedServiceWorkerHeaders: { serviceWorker?: string | string[]; destination?: string | string[] } | undefined
const targetServer = createServer(async (request, response) => {
  activeUpstreamRequests += 1
  maxActiveUpstreamRequests = Math.max(maxActiveUpstreamRequests, activeUpstreamRequests)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  activeUpstreamRequests -= 1
  if (request.url?.startsWith("/service-worker-redirect")) {
    forwardedServiceWorkerHeaders = { serviceWorker: request.headers["service-worker"], destination: request.headers["sec-fetch-dest"] }
    response.writeHead(302, { location: `${targetServerUrl}/login?token=PRIVATE_REDIRECT_TOKEN` })
    response.end()
    return
  }
  if (request.url === "/canceled-service-worker-redirect") {
    response.writeHead(302, { location: `${targetServerUrl}/login?token=PRIVATE_CANCELED_TOKEN` })
    response.flushHeaders()
    setTimeout(() => response.end(), 100)
    return
  }
  if (request.url === "/truncated-service-worker") {
    response.writeHead(200, { "content-type": "application/javascript" })
    response.flushHeaders()
    response.socket?.destroy()
    return
  }
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
  assert.equal(proxied.wordpressUrl, targetServerUrl)
  assert.notEqual(proxied.serverUrl, proxied.wordpressUrl)
  const initialProxyDiagnostics = proxied.previewProxyDiagnostics
  assert.deepEqual(initialProxyDiagnostics, {
    schema: "wp-codebox/preview-proxy-diagnostics/v1",
    upstreamConcurrency: "serialized",
    maxConcurrentUpstreamRequests: 1,
    queue: "fifo",
    bind: "127.0.0.1",
    targetOrigin: new URL(targetServerUrl).origin,
    requestTrace: { scope: "service-worker", capacity: 64, total: 0, dropped: 0, entries: [] },
  })
  await Promise.all([fetch(proxied.serverUrl), fetch(proxied.serverUrl)])
  assert.equal(maxActiveUpstreamRequests, 1)
  await fetch(`${proxied.serverUrl}/service-worker-redirect?nonce=PRIVATE_ORDINARY_NONCE`, { redirect: "manual" })
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.total, 0, "ordinary redirects remain outside the service-worker trace")
  await fetch(`${proxied.serverUrl}/sw.js`)
  assert.deepEqual(proxied.previewProxyDiagnostics?.requestTrace.entries.at(-1), {
    sequence: 1,
    method: "GET",
    path: "/sw.js",
    destination: null,
    serviceWorker: false,
    outcome: "response",
    status: 200,
  })
  const redirectResponse = await fetch(`${proxied.serverUrl}/service-worker-redirect?nonce=PRIVATE_REQUEST_NONCE`, {
    headers: { "service-worker": "script", "sec-fetch-dest": "serviceworker" },
    redirect: "manual",
  })
  assert.equal(redirectResponse.status, 302)
  assert.deepEqual(forwardedServiceWorkerHeaders, { serviceWorker: undefined, destination: undefined })
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.total, 2)
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.dropped, 0)
  assert.deepEqual(proxied.previewProxyDiagnostics?.requestTrace.entries.at(-1), {
    sequence: 2,
    method: "GET",
    path: "/service-worker-redirect?nonce=[redacted]",
    destination: "serviceworker",
    serviceWorker: true,
    outcome: "response",
    status: 302,
    upstreamLocation: `${targetServerUrl}/login?token=[redacted]`,
    visibleLocation: `${proxied.serverUrl}/login?token=[redacted]`,
  })
  assert.equal(initialProxyDiagnostics?.requestTrace.total, 0, "completed diagnostics snapshots do not mutate with later proxy requests")
  assert.doesNotMatch(JSON.stringify(proxied.previewProxyDiagnostics), /PRIVATE_REQUEST_NONCE|PRIVATE_REDIRECT_TOKEN/)
  const canceledRedirect = new AbortController()
  const canceledRedirectResponse = await fetch(`${proxied.serverUrl}/canceled-service-worker-redirect`, { headers: { "service-worker": "script" }, redirect: "manual", signal: canceledRedirect.signal })
  assert.equal(canceledRedirectResponse.status, 302)
  canceledRedirect.abort()
  await canceledRedirectResponse.body?.cancel().catch(() => undefined)
  assert.deepEqual(proxied.previewProxyDiagnostics?.requestTrace.entries.at(-1), {
    sequence: 3,
    method: "GET",
    path: "/canceled-service-worker-redirect",
    destination: null,
    serviceWorker: true,
    outcome: "response",
    status: 302,
    upstreamLocation: `${targetServerUrl}/login?token=[redacted]`,
    visibleLocation: `${proxied.serverUrl}/login?token=[redacted]`,
  })
  assert.doesNotMatch(JSON.stringify(proxied.previewProxyDiagnostics), /PRIVATE_CANCELED_TOKEN/)
  await fetch(`${proxied.serverUrl}/truncated-service-worker`, { headers: { "service-worker": "script" }, redirect: "manual" }).then((response) => response.text()).catch(() => undefined)
  assert.deepEqual(proxied.previewProxyDiagnostics?.requestTrace.entries.at(-1), {
    sequence: 4,
    method: "GET",
    path: "/truncated-service-worker",
    destination: null,
    serviceWorker: true,
    outcome: "upstream-error",
    status: 200,
  })
  assert.doesNotMatch(JSON.stringify(proxied.previewProxyDiagnostics), /PRIVATE_TRUNCATED_TOKEN/)
  await Promise.all(Array.from({ length: 64 }, (_, index) => fetch(`${proxied.serverUrl}/bounded-trace/${index}`, { headers: { "service-worker": "script", ...(index === 0 ? { "sec-fetch-dest": "PRIVATE_DESTINATION" } : {}) } })))
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.total, 68)
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.dropped, 4)
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.entries.length, 64)
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.entries[0]?.sequence, 5)
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.entries[0]?.destination, null)
  assert.equal(proxied.previewProxyDiagnostics?.requestTrace.entries.at(-1)?.sequence, 68)
  assert.doesNotMatch(JSON.stringify(proxied.previewProxyDiagnostics), /PRIVATE_DESTINATION/)
} finally {
  await proxied[Symbol.asyncDispose]()
  await closeHttpServer(targetServer)
}
assert.equal(disposed, true)

let hangingRequestReached: (() => void) | undefined
const hangingRequest = new Promise<void>((resolve) => {
  hangingRequestReached = resolve
})
const hangingTargetServer = createServer((request, response) => {
  if (request.url === "/hang") {
    hangingRequestReached?.()
    return
  }

  response.end("ok")
})
const hangingTargetServerUrl = await listenLocalHttpServer(hangingTargetServer)
const abortableProxy = await withPreviewProxy({
  playground: { async run() { return { text: "" } } },
  serverUrl: hangingTargetServerUrl,
  async [Symbol.asyncDispose]() {},
} satisfies PlaygroundCliServer, 0)
try {
  const controller = new AbortController()
  const abortedRequest = fetch(`${abortableProxy.serverUrl}/hang`, { headers: { "service-worker": "script" }, signal: controller.signal }).catch((error) => error)
  await hangingRequest
  controller.abort()
  await abortedRequest
  for (let attempt = 0; attempt < 50 && abortableProxy.previewProxyDiagnostics?.requestTrace.total === 0; attempt += 1) {
    await wait(10)
  }
  assert.equal(abortableProxy.previewProxyDiagnostics?.requestTrace.entries.at(-1)?.outcome, "client-canceled")

  const nextRequest = await Promise.race([
    fetch(`${abortableProxy.serverUrl}/ok`).then((response) => response.text()),
    wait(500).then(() => "timed-out"),
  ])
  assert.equal(nextRequest, "ok", "aborted preview requests must release the serialized upstream proxy slot")
} finally {
  await abortableProxy[Symbol.asyncDispose]()
  await closeHttpServer(hangingTargetServer)
}

let releaseFirstQueuedRequest: (() => void) | undefined
let firstQueuedRequestReached: (() => void) | undefined
const firstQueuedRequest = new Promise<void>((resolve) => {
  firstQueuedRequestReached = resolve
})
const queuedTargetRequests: string[] = []
const queuedTargetServer = createServer((request, response) => {
  queuedTargetRequests.push(request.url ?? "")
  if (request.url === "/first") {
    firstQueuedRequestReached?.()
    new Promise<void>((resolve) => {
      releaseFirstQueuedRequest = resolve
    }).then(() => response.end("first"))
    return
  }
  response.end("third")
})
const queuedTargetServerUrl = await listenLocalHttpServer(queuedTargetServer)
const queuedAbortProxy = await withPreviewProxy({
  playground: { async run() { return { text: "" } } },
  serverUrl: queuedTargetServerUrl,
  async [Symbol.asyncDispose]() {},
} satisfies PlaygroundCliServer, 0)
let secondQueuedRequestReached: (() => void) | undefined
const secondQueuedRequest = new Promise<void>((resolve) => {
  secondQueuedRequestReached = resolve
})
let secondQueuedRequestCanceled: (() => void) | undefined
const secondQueuedCancellation = new Promise<void>((resolve) => {
  secondQueuedRequestCanceled = resolve
})
const stopObservingQueuedRequest = queuedAbortProxy.previewRoutes?.add((request, response) => {
  if (request.url === "/second") {
    secondQueuedRequestReached?.()
    response.once("close", () => secondQueuedRequestCanceled?.())
  }
  return false
})
try {
  const firstRequest = fetch(`${queuedAbortProxy.serverUrl}/first`)
  await firstQueuedRequest

  const controller = new AbortController()
  const canceledRequest = fetch(`${queuedAbortProxy.serverUrl}/second`, { headers: { "sec-fetch-dest": "serviceworker" }, signal: controller.signal }).catch((error) => error)
  await secondQueuedRequest
  controller.abort()
  await canceledRequest
  await secondQueuedCancellation

  releaseFirstQueuedRequest?.()
  assert.equal(await (await firstRequest).text(), "first")
  assert.equal(await (await fetch(`${queuedAbortProxy.serverUrl}/third`)).text(), "third")
  assert.deepEqual(queuedTargetRequests, ["/first", "/third"], "a canceled queued request must not open an upstream request")
  assert.deepEqual(queuedAbortProxy.previewProxyDiagnostics?.requestTrace.entries, [{
    sequence: 1,
    method: "GET",
    path: "/second",
    destination: "serviceworker",
    serviceWorker: true,
    outcome: "canceled-before-upstream",
  }])
} finally {
  stopObservingQueuedRequest?.()
  await queuedAbortProxy[Symbol.asyncDispose]()
  await closeHttpServer(queuedTargetServer)
}

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
  projections: [{ kind: "browser-artifacts", schema: "wp-codebox/browser-artifact-persistence/ref/v1", artifacts: [] }],
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
assert.equal(projection.schema, "wp-codebox/browser-artifact-persistence/ref/v1")
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
assert.deepEqual(persistedBrowserArtifactRefs(projection), projection.artifactRefs)
assert.deepEqual(browserArtifactPersistenceProjection(projection).artifactRefs, projection.artifactRefs)
assert.deepEqual(browserArtifactPersistenceProjection({ schema: "wp-codebox/browser-artifact-persistence-projection/v1", artifacts: projection.artifacts, artifactBundle: projection.artifactBundle }).artifactRefs.slice(0, 2), projection.artifactRefs.slice(0, 2))

const browserRun = normalizeBrowserRunResult({ success: true, data: materializationEnvelope.result }, "browser-session-recipe")
assert.equal(browserRun.schema, "wp-codebox/browser-run-result/v1")
assert.equal(browserRun.status, "completed")
assert.equal(browserRun.success, true)
assert.deepEqual(browserRun.artifactRefs, projection.artifactRefs)
assert.equal(browserRunResultEnvelope({ operation: "browser-session-recipe", result: materializationEnvelope.result, artifactRefs: projection.artifactRefs }).schema, "wp-codebox/browser-run-result/v1")

const canonicalMaterialization = extractMaterializationResultEnvelope({
  schema: "wp-codebox/materialization-result/v1",
  task: "generic-materialization",
  success: true,
  result: { artifact: { path: "files/output.json", kind: "generic-json", sha256: "abc" } },
})
assert.equal(canonicalMaterialization.task, "generic-materialization")
assert.deepEqual(canonicalMaterialization.result, { artifact: { path: "files/output.json", kind: "generic-json", sha256: "abc" } })

const nestedCaptureMaterialization = normalizeMaterializationResultEnvelope({
  response: {
    schema: "wp-codebox/browser-materialization/v1",
    success: true,
    task: "capture-materialization",
    captures: [{
      schema: "wp-codebox/browser-capture/v1",
      path: "/tmp/materialization.json",
      json: { success: true, result: { artifact: { path: "files/captured.json", kind: "generic-json", sha256: "123" } } },
    }],
  },
})
assert.equal(nestedCaptureMaterialization.status, "completed")
assert.deepEqual(nestedCaptureMaterialization.result, { artifact: { path: "files/captured.json", kind: "generic-json", sha256: "123" } })

const nestedCaptureContentMaterialization = normalizeMaterializationResultEnvelope({
  response: {
    schema: "wp-codebox/browser-materialization/v1",
    success: true,
    task: "capture-content-materialization",
    captures: [{
      schema: "wp-codebox/browser-capture/v1",
      path: "/tmp/materialization.json",
      content: JSON.stringify({ success: true, result: { artifact: { path: "files/captured-content.json", kind: "generic-json", sha256: "456" } } }),
    }],
  },
})
assert.equal(nestedCaptureContentMaterialization.status, "completed")
assert.deepEqual(nestedCaptureContentMaterialization.result, { artifact: { path: "files/captured-content.json", kind: "generic-json", sha256: "456" } })

const explicitFailureMaterialization = normalizeMaterializationResultEnvelope({
  schema: "wp-codebox/materialization-result/v1",
  task: "generic-materialization",
  success: false,
  error: { name: "Error", message: "explicit materialization failure", code: "explicit-failure" },
})
assert.equal(explicitFailureMaterialization.status, "failed")
assert.equal(explicitFailureMaterialization.error.message, "explicit materialization failure")
assert.equal(explicitFailureMaterialization.error.code, "explicit-failure")

const missingResultMaterialization = normalizeMaterializationResultEnvelope({
  schema: "wp-codebox/materialization-result/v1",
  task: "generic-materialization",
  success: true,
})
assert.equal(missingResultMaterialization.status, "failed")
assert.equal(missingResultMaterialization.error.message, "Materialization failed.")

assert.deepEqual(normalizeMaterializationArtifactRefs([
  { kind: "browser-html", path: "files/browser/index.html", sha256: "def" },
  { role: "browser-html", path: "files/browser/index.html", content_digest: "def" },
  { artifact_type: "browser-screenshot", artifact_id: "screenshot-1", artifacts_path: "files/browser/screenshot.png", contentDigest: { algorithm: "sha256", value: "123" } },
]), [
  { kind: "browser-html", path: "files/browser/index.html", digest: { algorithm: "sha256", value: "def" } },
  { kind: "browser-screenshot", id: "screenshot-1", path: "files/browser/screenshot.png", digest: { algorithm: "sha256", value: "123" } },
])
assert.deepEqual(artifactBundleFileManifest(projection), {
  schema: "wp-codebox/artifact-bundle-file-manifest/v1",
  bundle: {
    kind: "artifact-bundle",
    id: "artifact-bundle-sha256-abc",
    path: "artifacts/run-1",
    digest: { algorithm: "sha256", value: "abc" },
  },
  files: [
    {
      kind: "browser-html",
      path: "files/browser/index.html",
      digest: { algorithm: "sha256", value: "def" },
    },
  ],
  paths: ["files/browser/index.html"],
})
const callbackEnvelope = browserCallbackResultEnvelope({
  capability: "persist-browser-artifact",
  ability: "wp-codebox/persist-browser-artifact",
  result: materializationEnvelope.result,
})
assert.equal(callbackEnvelope.schema, "wp-codebox/browser-callback-result/v1")
assert.deepEqual(callbackEnvelope.artifactRefs, projection.artifactRefs)
const normalizedFailureEnvelope = normalizeMaterializationResultEnvelope({ success: true, response: { success: false, error: { message: "fixture failure" } } })
assert.equal(normalizedFailureEnvelope.schema, "wp-codebox/materialization-result/v1")
assert.equal(normalizedFailureEnvelope.status, "failed")
assert.equal(normalizedFailureEnvelope.success, false)
assert.equal(normalizedFailureEnvelope.error.message, "fixture failure")
