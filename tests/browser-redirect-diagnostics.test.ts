import assert from "node:assert/strict"

import type { BrowserProbeNetworkRecord } from "../packages/runtime-playground/src/browser-artifacts.js"
import { browserRedirectDiagnosticsArtifact } from "../packages/runtime-playground/src/browser-probe-support.js"

const response = (url: string, status: number, timestamp: string): BrowserProbeNetworkRecord => ({
  type: "response",
  method: "GET",
  url,
  resourceType: "document",
  status,
  timestamp,
})

const artifact = (network: BrowserProbeNetworkRecord[], error?: Error) => browserRedirectDiagnosticsArtifact({
  artifactPath: "files/browser/redirect-diagnostics.json",
  error,
  finalAttemptedUrl: network.at(-1)?.url ?? "https://example.test/",
  network,
  requestedUrl: network[0]?.url ?? "https://example.test/",
})

const repeatedSuccessfulVisits = artifact([
  response("https://example.test/community/", 200, "2026-08-01T00:00:00.000Z"),
  response("https://example.test/community/", 200, "2026-08-01T00:00:01.000Z"),
  response("https://example.test/community/", 200, "2026-08-01T00:00:02.000Z"),
])
assert.equal(repeatedSuccessfulVisits, undefined)

const redirectChain = artifact([
  response("https://example.test/start", 301, "2026-08-01T00:00:00.000Z"),
  response("https://example.test/next", 302, "2026-08-01T00:00:01.000Z"),
  response("https://example.test/final", 200, "2026-08-01T00:00:02.000Z"),
])
assert.equal(redirectChain?.classification, "redirect-chain")
assert.equal(redirectChain?.summary.redirectResponses, 2)
assert.deepEqual(redirectChain?.summary.repeatedHosts, [{ host: "example.test", count: 3 }])

const redirectThenRepeatedSuccessfulVisits = artifact([
  response("https://example.test/start", 302, "2026-08-01T00:00:00.000Z"),
  response("https://example.test/community/", 200, "2026-08-01T00:00:01.000Z"),
  response("https://example.test/community/", 200, "2026-08-01T00:00:02.000Z"),
])
assert.equal(redirectThenRepeatedSuccessfulVisits?.classification, "redirect-chain")
assert.deepEqual(redirectThenRepeatedSuccessfulVisits?.summary.repeatedUrls, [{ url: "https://example.test/community/", count: 2 }])

const redirectLoop = artifact([
  response("https://example.test/first", 302, "2026-08-01T00:00:00.000Z"),
  response("https://example.test/second", 302, "2026-08-01T00:00:01.000Z"),
  response("https://example.test/first", 302, "2026-08-01T00:00:02.000Z"),
])
assert.equal(redirectLoop?.classification, "redirect-loop")
assert.equal(redirectLoop?.reason, "redirect responses repeated document URL values")
assert.equal(redirectLoop?.summary.redirectResponses, 3)
assert.deepEqual(redirectLoop?.summary.repeatedUrls, [{ url: "https://example.test/first", count: 2 }])

const browserReportedLoop = artifact([], new Error("page.goto: net::ERR_TOO_MANY_REDIRECTS at https://example.test/loop"))
assert.equal(browserReportedLoop?.classification, "redirect-loop")
assert.equal(browserReportedLoop?.summary.redirectResponses, 0)

console.log("browser redirect diagnostics ok")
