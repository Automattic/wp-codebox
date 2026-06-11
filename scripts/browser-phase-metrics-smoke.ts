import assert from "node:assert/strict"
import { browserProbeBenchMetrics } from "../packages/runtime-playground/src/browser-metrics.js"
import { browserProbePerformanceArtifact } from "../packages/runtime-playground/src/browser-probe.js"
import type { BrowserProbeCheckpointRecord, BrowserProbeNetworkRecord } from "../packages/runtime-playground/src/browser-artifacts.js"

const startedAt = "2026-06-11T00:00:00.000Z"
const checkpoints: BrowserProbeCheckpointRecord[] = [
  checkpoint("after-navigation", "2026-06-11T00:00:01.000Z", 2, 4096, 42, 320),
  checkpoint("after-script", "2026-06-11T00:00:02.000Z", 4, 8192, 48, 320),
  checkpoint("final", "2026-06-11T00:00:03.000Z", 5, 12288, 52, 640),
]
const network: BrowserProbeNetworkRecord[] = [
  networkRecord("https://example.test/", "document", "2026-06-11T00:00:00.500Z", 200, 1000),
  networkRecord("https://cdn.example.test/app.js", "script", "2026-06-11T00:00:01.500Z", 200, 2000),
  networkRecord("https://cdn.example.test/missing.css", "stylesheet", "2026-06-11T00:00:02.500Z", 404, 3000),
]
const performance = browserProbePerformanceArtifact(checkpoints, {
  startedAt,
  network,
  consoleMessages: [
    { type: "error", text: "early console error", timestamp: "2026-06-11T00:00:01.250Z" },
    { type: "error", text: "late console error", timestamp: "2026-06-11T00:00:02.750Z" },
  ],
  errors: [
    { type: "pageerror", name: "Error", message: "script failed", timestamp: "2026-06-11T00:00:01.750Z" },
    { type: "probe-error", name: "Error", message: "probe failed", timestamp: "2026-06-11T00:00:02.900Z" },
  ],
})

assert.equal(performance.phaseMetrics?.schema, "wp-codebox/browser-phase-metrics/v1")
assert.equal(performance.phaseMetrics?.phases.length, 3)

const navigation = performance.phaseMetrics?.phases.find((phase) => phase.name === "before-navigation-complete")
assert.ok(navigation, "after-navigation checkpoint should become a navigation phase")
assert.equal(navigation.elapsedMs, 1000)
assert.equal(navigation.network.requests, 1)
assert.equal(navigation.network.responses, 1)
assert.equal(navigation.network.failures, 0)
assert.equal(navigation.network.transferSizeBytes, 1000)
assert.equal(navigation.errors.console, 0)
assert.equal(navigation.errors.page, 0)
assert.equal(navigation.performance.resources, 2)
assert.equal(navigation.performance.firstContentfulPaintMs, 320)
assert.equal(navigation.network.firstRequest?.host, "example.test")

const script = performance.phaseMetrics?.phases.find((phase) => phase.name === "before-script-complete")
assert.ok(script, "after-script checkpoint should become a script phase")
assert.equal(script.network.requests, 2)
assert.equal(script.network.transferSizeBytes, 3000)
assert.equal(script.errors.console, 1)
assert.equal(script.errors.page, 1)
assert.equal(script.network.firstRequestByHost["cdn.example.test"]?.resourceType, "script")

const final = performance.phaseMetrics?.phases.find((phase) => phase.name === "before-final")
assert.ok(final, "final checkpoint should become a final phase")
assert.equal(final.network.requests, 3)
assert.equal(final.network.responses, 3)
assert.equal(final.errors.console, 2)
assert.equal(final.errors.page, 1)
assert.equal(final.errors.probe, 1)
assert.equal(final.performance.largestContentfulPaintMs, 640)

const metrics = browserProbeBenchMetrics(undefined, performance)
assert.equal(metrics.browser_phase_before_navigation_complete_request_count, 1)
assert.equal(metrics.browser_phase_before_navigation_complete_elapsed_ms, 1000)
assert.equal(metrics.browser_phase_before_script_complete_transfer_size_bytes, 3000)
assert.equal(metrics.browser_phase_before_script_complete_console_error_count, 1)
assert.equal(metrics.browser_phase_before_final_page_error_count, 1)
assert.equal(metrics.browser_phase_before_final_probe_error_count, 1)
assert.equal(metrics.browser_phase_before_final_lcp_ms, 640)

console.log("Browser phase metrics smoke passed")

function checkpoint(name: string, timestamp: string, resources: number, transferSizeBytes: number, domNodes: number, lcpMs: number): BrowserProbeCheckpointRecord {
  return {
    schema: "wp-codebox/browser-checkpoint/v1",
    name,
    timestamp,
    metrics: {
      timestamp,
      memory: {
        performanceMemory: { usedJSHeapSize: null, totalJSHeapSize: null, jsHeapSizeLimit: null },
        cdpHeap: { usedSize: null, totalSize: null },
        domCounters: { documents: null, nodes: domNodes, jsEventListeners: null },
      },
      performance: {
        cdpMetrics: {},
        navigation: { type: "navigate", redirectCount: 0, durationMs: null, domContentLoadedMs: null, loadEventMs: null, responseStartMs: null, responseEndMs: null, requestStartMs: null, ttfbMs: null, redirectMs: null },
        paint: { firstPaintMs: null, firstContentfulPaintMs: 320, largestContentfulPaintMs: lcpMs, largestContentfulPaintSize: null, largestContentfulPaintElement: null, largestContentfulPaintUrl: null },
        dom: { nodes: domNodes, documents: 1, iframes: 0 },
        resources: { count: resources, transferSizeBytes, encodedBodySizeBytes: 0, decodedBodySizeBytes: 0 },
        longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
        layoutShifts: { cls: 0, count: 0, totalCount: 0, max: 0, entries: [] },
      },
    },
  }
}

function networkRecord(url: string, resourceType: string, timestamp: string, status: number, transferSize: number): BrowserProbeNetworkRecord {
  return {
    type: "response",
    url,
    method: "GET",
    resourceType,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    ok: status >= 200 && status < 400,
    timestamp,
    transferSize,
    responseBodySize: transferSize,
  }
}
