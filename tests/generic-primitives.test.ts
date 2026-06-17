import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  artifactFileDigest,
  artifactManifestRelativePath,
  resolveArtifactPath,
  safeArtifactRelativePath,
  artifactStoragePath,
  artifactStoragePublicUrl,
  browserArtifactGrant,
  browserArtifactRef,
  captureArtifactFile,
  evidenceArtifactEnvelope,
  materializationPhaseResult,
  materializationRunArtifactRefs,
  reviewerSafeArtifactRef,
  normalizeArtifactPartPath,
  normalizeRecipeMounts,
  normalizeSharedMounts,
  runtimeOverlayBundle,
  runtimeArtifactStorageDescriptor,
  trustedBrowserSessionOrigin,
  trustedBrowserSessionOrigins,
  validateEvidenceArtifactEnvelope,
  writeArtifactPart,
  validateWorkspaceRecipeJsonSchema,
} from "../packages/runtime-core/src/index.js"
import { benchRunCode } from "../packages/runtime-playground/src/bench-command-handlers.js"
import { browserPreviewAuthCookieUrls, browserPreviewTopology } from "../packages/runtime-playground/src/browser-preview-routing.js"
import { closeHttpServer, listenLocalHttpServer, withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const storage = runtimeArtifactStorageDescriptor({
  root: "./artifacts",
  publicUrlRoot: "https://example.test/codebox///?ignored=1#hash",
  pathPrefix: "/runs/run-1/",
})

assert.equal(storage.schema, "wp-codebox/runtime-artifact-storage/v1")
assert.equal(storage.root, resolve("./artifacts"))
assert.equal(storage.publicUrlRoot, "https://example.test/codebox")
assert.equal(storage.pathPrefix, "runs/run-1")
assert.equal(artifactStoragePath(storage, "files/output.json"), "runs/run-1/files/output.json")
assert.equal(artifactStoragePublicUrl(storage, "files/output.json"), "https://example.test/codebox/runs/run-1/files/output.json")
assert.equal(safeArtifactRelativePath("/files//output.json"), "files/output.json")
assert.equal(resolveArtifactPath(storage.root, "files/output.json").relativePath, "files/output.json")
assert.equal(artifactManifestRelativePath(storage.root, resolve(storage.root, "files/output.json")), "files/output.json")

assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", pathPrefix: "../escape" }), /parent-directory/)
assert.throws(() => runtimeArtifactStorageDescriptor({ root: "./artifacts", publicUrlRoot: "file:///tmp/artifacts" }), /http/)
assert.throws(() => safeArtifactRelativePath("files/../secret.txt"), /parent-directory/)
assert.throws(() => resolveArtifactPath(storage.root, "../secret.txt"), /parent-directory/)
assert.throws(() => artifactManifestRelativePath(storage.root, resolve(storage.root, "../secret.txt")), /inside the artifact root/)

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

assert.deepEqual(reviewerSafeArtifactRef({ path: "/files//browser/screenshot.png", kind: "browser-screenshot", digest: "abc", publicUrl: "https://artifacts.example.test/run-1/files/browser/screenshot.png#local" }), {
  path: "files/browser/screenshot.png",
  kind: "browser-screenshot",
  digest: { algorithm: "sha256", value: "abc" },
  publicUrl: "https://artifacts.example.test/run-1/files/browser/screenshot.png",
})
assert.throws(() => reviewerSafeArtifactRef({ path: "files/browser/screenshot.png", kind: "browser-screenshot", publicUrl: "http://localhost:8881/artifact.png" }), /loopback/)

const evidenceEnvelope = evidenceArtifactEnvelope({
  id: "run-1",
  subject: { kind: "component", id: "example" },
  status: "passed",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  artifacts: [{ path: "files/review.md", kind: "review", contentType: "text/markdown" }],
  browserCaptures: [{
    id: "homepage",
    status: "passed",
    finalUrl: "https://example.test/",
    artifacts: [{ path: "files/browser/home.png", kind: "browser-screenshot", publicUrl: "https://artifacts.example.test/run-1/files/browser/home.png" }],
  }],
})
assert.equal(evidenceEnvelope.schema, "wp-codebox/evidence-artifact-envelope/v1")
assert.equal(evidenceEnvelope.browserCaptures[0].schema, "wp-codebox/browser-evidence-capture/v1")
assert.deepEqual(validateEvidenceArtifactEnvelope(evidenceEnvelope), { valid: true, errors: [] })
assert.equal(validateEvidenceArtifactEnvelope({ ...evidenceEnvelope, artifacts: [{ path: "../secret.txt", kind: "file" }] }).valid, false)

const overlayBundle = runtimeOverlayBundle({
  id: "example-runtime-overlay",
  files: [{ path: "/wordpress/wp-content/mu-plugins/example.php", source: "overlays/example.php" }],
  configPreludes: [{ target: "wp-config.php", contents: "define('EXAMPLE_RUNTIME', true);", order: 10 }],
  localRoutes: [{ path: "/_runtime/example", target: "http://127.0.0.1:9400/example", methods: ["get"], localOnly: true }],
  patches: [{ id: "example.patch", source: "patches/example.patch", appliesTo: "runtime" }],
  capabilities: { provided: ["example/runtime-overlay", "example/runtime-overlay"], required: ["wordpress"] },
})
assert.equal(overlayBundle.schema, "wp-codebox/runtime-overlay-bundle/v1")
assert.deepEqual(overlayBundle.localRoutes?.[0].methods, ["GET"])
assert.deepEqual(overlayBundle.capabilities?.provided, ["example/runtime-overlay"])
assert.throws(() => runtimeOverlayBundle({ id: "gap", unsupportedGaps: [{ capability: "route-alias", reason: "backend does not support local route aliases", failureMode: "fail-closed" }] }), /unsupported fail-closed gaps/)

assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { overlays: [{ kind: "runtime-overlay-bundle", bundle: overlayBundle }] },
  workflow: { steps: [{ command: "noop" }] },
}).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { overlays: [{ kind: "runtime-overlay-bundle", bundle: { ...overlayBundle, localRoutes: [{ path: "/_runtime/example", target: "http://127.0.0.1:9400/example" }] } }] },
  workflow: { steps: [{ command: "noop" }] },
}).valid, false)

assert.deepEqual(normalizeRecipeMounts([{ source: "/host/plugin", target: "//wordpress//wp-content/plugins/plugin" }]), [{ source: "/host/plugin", target: "/wordpress/wp-content/plugins/plugin", mode: "readwrite" }])
assert.throws(() => normalizeSharedMounts([{ source: "/host/plugin", target: "wordpress/wp-content/plugins/plugin" }]), /absolute target/)
assert.throws(() => normalizeSharedMounts([{ source: "/host/plugin", target: "/wordpress/../escape" }]), /parent-directory/)

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

const artifactRoot = mkdtempSync(resolve(tmpdir(), "wp-codebox-artifact-part-"))
const part = await writeArtifactPart({
  root: artifactRoot,
  path: "files/check/result.json",
  kind: "check-result",
  contentType: "application/json",
  contents: "{\"ok\":true}\n",
  redaction: { policy: "required", sensitive: true, reason: "test sensitive artifact" },
  provenance: { source: "test", operation: "write-artifact-part", id: "result" },
})

assert.equal(part.path, "files/check/result.json")
assert.equal(await readFile(part.absolutePath, "utf8"), "{\"ok\":true}\n")
assert.equal(part.manifestFile.path, "files/check/result.json")
assert.deepEqual(part.manifestFile.sha256, artifactFileDigest("{\"ok\":true}\n"))
assert.deepEqual(part.manifestFile.redaction, { policy: "required", sensitive: true, reason: "test sensitive artifact" })
assert.deepEqual(part.manifestFile.provenance, { source: "test", operation: "write-artifact-part", id: "result" })
assert.equal(normalizeArtifactPartPath("/files//check/result.json"), "files/check/result.json")
assert.throws(() => normalizeArtifactPartPath("files/../secret.txt"), /relative path/)

const captureRoot = mkdtempSync(resolve(tmpdir(), "wp-codebox-capture-"))
const redactedCapture = await captureArtifactFile({
  root: captureRoot,
  path: "files/diagnostics/failure.txt",
  kind: "diagnostics",
  contents: "Authorization: bearer-secret\ntoken sk-abcdefghijklmnopqrstuvwxyz\n",
  contentType: "text/plain; charset=utf-8",
  redaction: { policy: "applied", sensitive: true },
  provenance: { source: "test", operation: "capture" },
})
assert.equal(redactedCapture.status, "captured")
assert.equal(await readFile(join(captureRoot, "files/diagnostics/failure.txt"), "utf8"), "Authorization: [redacted]\ntoken [redacted]\n")
assert.equal(redactedCapture.manifestFile?.redaction?.policy, "applied")

const sourceRoot = mkdtempSync(resolve(tmpdir(), "wp-codebox-capture-source-"))
const largeSource = join(sourceRoot, "large.txt")
await writeFile(largeSource, "0123456789")
const oversizedCapture = await captureArtifactFile({
  sourcePath: largeSource,
  root: captureRoot,
  path: "files/large.txt",
  kind: "file",
  allowedRoots: [sourceRoot],
  maxBytes: 4,
})
assert.equal(oversizedCapture.status, "oversized")
assert.equal(oversizedCapture.reason, "max-bytes-exceeded")
assert.equal(oversizedCapture.originalBytes, 10)

const sensitiveCapture = await captureArtifactFile({
  root: captureRoot,
  path: "files/sensitive.txt",
  kind: "file",
  contents: "token sk-abcdefghijklmnopqrstuvwxyz\n",
  maxBytes: 1024,
  skipSensitiveText: true,
})
assert.equal(sensitiveCapture.status, "sensitive")
assert.equal(sensitiveCapture.reason, "secret-like-value")

const benchRunner = benchRunCode({
  componentId: "component",
  pluginSlug: "component",
  iterations: 1,
  warmupIterations: 0,
  dependencySlugs: [],
  env: {},
  bootstrapFiles: [],
  workloads: [{ id: "ability-step", run: [{ type: "ability", name: "example/run" }] }],
  lifecycle: {},
  resetPolicy: {},
})

assert.match(benchRunner, /function wp_codebox_bench_run_command_step\(array \$step, string \$type, callable \$runner\): array/)
assert.match(benchRunner, /function wp_codebox_bench_run_ability_step\(array \$step\): array[\s\S]*wp_codebox_bench_run_command_step\(\$step, 'ability'/)
assert.match(benchRunner, /'schema' => 'wp-codebox\/bench-command-step\/v1'/)
assert.doesNotMatch(benchRunner, /\} elseif \(\$type === 'ability'\) \{[\s\S]{0,500}\$ability->execute/)

const commandStepHelpers = benchRunner.match(/function wp_codebox_bench_metric_prefix[\s\S]*?\nfunction wp_codebox_bench_run_rest_request_step/)?.[0].replace(/\nfunction wp_codebox_bench_run_rest_request_step$/, "")
assert.ok(commandStepHelpers, "bench command step helpers are emitted")

const phpTestFile = join(mkdtempSync(join(tmpdir(), "wp-codebox-bench-step-")), "command-step.php")
writeFileSync(
  phpTestFile,
  `<?php
${commandStepHelpers}
$execution = wp_codebox_bench_run_command_step(array('type' => 'ability', 'name' => 'example/run'), 'ability', static function (array $step): array {
    return array('metrics' => array('custom_count' => 2), 'metadata' => array('called' => $step['name']));
});
$payload = wp_codebox_bench_command_step_payload($execution, 'ability');
echo json_encode($payload, JSON_UNESCAPED_SLASHES);
`,
)
const commandStepPayload = JSON.parse(execFileSync("php", [phpTestFile], { encoding: "utf8" }))
assert.equal(commandStepPayload.steps[0].schema, "wp-codebox/bench-command-step/v1")
assert.equal(commandStepPayload.steps[0].type, "ability")
assert.equal(commandStepPayload.steps[0].name, "example/run")
assert.equal(typeof commandStepPayload.steps[0].timing.duration_ms, "number")
assert.equal(typeof commandStepPayload.metrics.ability_duration_ms, "number")
assert.equal(commandStepPayload.metrics.custom_count, 2)
assert.deepEqual(commandStepPayload.metadata, { called: "example/run" })
