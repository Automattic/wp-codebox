import assert from "node:assert/strict"
import {
  RUNTIME_EPISODE_TRACE_ARTIFACT_PATH,
  normalizeArtifactBundleTraceRef,
  normalizeArtifactContentType,
  normalizeArtifactDigest,
  normalizeBrowserArtifactSummaryRefs,
  normalizeObservationArtifactRefs,
  normalizeRuntimeEpisodeTraceRef,
  normalizeRuntimeReferenceArtifactBundleRef,
  normalizeRuntimeReferenceManifestFileRef,
} from "@automattic/wp-codebox-core"

assert.deepEqual(normalizeArtifactDigest("a".repeat(64)), { algorithm: "sha256", value: "a".repeat(64) })
assert.deepEqual(normalizeArtifactDigest({ sha256: "b".repeat(64) }), { algorithm: "sha256", value: "b".repeat(64) })
assert.deepEqual(normalizeArtifactDigest({ digest: { algorithm: "sha256", value: "c".repeat(64) } }), { algorithm: "sha256", value: "c".repeat(64) })

assert.equal(normalizeArtifactContentType({ mime: "text/plain" }), "text/plain")
assert.equal(normalizeArtifactContentType({ mimeType: "application/json" }), "application/json")
assert.equal(normalizeArtifactContentType(undefined), "application/octet-stream")

assert.deepEqual(normalizeRuntimeReferenceManifestFileRef({
  path: RUNTIME_EPISODE_TRACE_ARTIFACT_PATH,
  kind: "runtime-episode-trace",
  mime: "application/json",
  sha256: "d".repeat(64),
}), {
  path: RUNTIME_EPISODE_TRACE_ARTIFACT_PATH,
  kind: "runtime-episode-trace",
  contentType: "application/json",
  sha256: { algorithm: "sha256", value: "d".repeat(64) },
})

assert.deepEqual(normalizeRuntimeEpisodeTraceRef({
  kind: "observation-artifact",
  path: "files/observations/body.txt",
  sha256: "e".repeat(64),
}), {
  kind: "observation-artifact",
  id: "files/observations/body.txt",
  path: "files/observations/body.txt",
  digest: { algorithm: "sha256", value: "e".repeat(64) },
})

assert.deepEqual(normalizeObservationArtifactRefs({
  artifactRefs: [{ kind: "wordpress-state-section", id: "posts", path: "files/observations/posts.json", digest: { value: "f".repeat(64), algorithm: "sha256" } }],
}), [
  { kind: "wordpress-state-section", id: "posts", path: "files/observations/posts.json", digest: { algorithm: "sha256", value: "f".repeat(64) } },
])

assert.deepEqual(normalizeArtifactBundleTraceRef({ id: "artifact-bundle-sha256-test", directory: "/tmp/artifacts", contentDigest: "1".repeat(64) }), {
  kind: "artifact-bundle",
  id: "artifact-bundle-sha256-test",
  artifactId: "artifact-bundle-sha256-test",
  path: "/tmp/artifacts",
  digest: { algorithm: "sha256", value: "1".repeat(64) },
})

assert.deepEqual(normalizeRuntimeReferenceArtifactBundleRef({ id: "artifact-bundle-sha256-test", contentDigest: { algorithm: "sha256", value: "2".repeat(64) } }), {
  kind: "artifact-bundle",
  id: "artifact-bundle-sha256-test",
  digest: { algorithm: "sha256", value: "2".repeat(64) },
})

assert.deepEqual(normalizeBrowserArtifactSummaryRefs({
  probes: [
    {
      html: "files/browser/probe-0.html",
      screenshot: "files/browser/probe-0.png",
      steps: "files/browser/probe-0.steps.ndjson",
      summaryFile: "files/browser/probe-0.summary.json",
    },
  ],
}), [
  { probeIndex: 0, field: "html", kind: "browser-html-snapshot", path: "files/browser/probe-0.html", contentType: "text/html; charset=utf-8" },
  { probeIndex: 0, field: "screenshot", kind: "browser-screenshot", path: "files/browser/probe-0.png", contentType: "image/png" },
  { probeIndex: 0, field: "steps", kind: "browser-steps", path: "files/browser/probe-0.steps.ndjson", contentType: "application/x-ndjson" },
  { probeIndex: 0, field: "summaryFile", kind: "browser-summary", path: "files/browser/probe-0.summary.json", contentType: "application/json" },
])

console.log("Artifact reference normalization smoke passed")
