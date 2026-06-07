import assert from "node:assert/strict"
import {
  BROWSER_RESULT_SCHEMA_VERSION,
  normalizeBrowserNetworkRequest,
  normalizeBrowserPerformanceProfile,
  normalizeBrowserTimingRows,
  normalizeBrowserTraceEnvelope,
  normalizeBrowserTraceEvent,
} from "@automattic/wp-codebox-core"

assert.deepEqual(normalizeBrowserTraceEvent("browser", "navigation", { url: "/" }, 12.34567), {
  data: { url: "/" },
  event: "navigation",
  source: "browser",
  t_ms: 12.346,
})

assert.deepEqual(normalizeBrowserTraceEvent({ source: "probe", event: "checkpoint", data: "after-load", timestampMs: 30 }), {
  data: { value: "after-load" },
  event: "checkpoint",
  source: "probe",
  t_ms: 30,
})

assert.deepEqual(normalizeBrowserTraceEnvelope({
  componentId: "editor",
  scenario_id: "open-post",
  status: "pass",
  summary: "Opened the editor",
  timeline: [{ z: 1, a: 2 }],
  assertions: [{ message: "loaded", status: "pass" }],
  artifacts: [{ relativePath: "files/browser/summary.json", kind: "browser-summary" }, { label: "missing-path" }],
}), {
  artifacts: [{ kind: "browser-summary", path: "files/browser/summary.json" }],
  assertions: [{ message: "loaded", status: "pass" }],
  component_id: "editor",
  scenario_id: "open-post",
  status: "pass",
  summary: "Opened the editor",
  timeline: [{ a: 2, z: 1 }],
})

const profile = normalizeBrowserPerformanceProfile({
  url: "https://example.test/wp-admin/post.php?post=1",
  summary: { resources: 2, durationMs: 120.12345 },
  phase_marks: [
    { label: "DOM Ready", startTime: 20 },
    { name: "Navigation", start_time_ms: 0 },
  ],
  resources: [
    { name: "https://example.test/wp-includes/style.css", startTime: 30, responseStart: 40, responseEnd: 50, duration: 20, initiatorType: "link" },
  ],
  network: [
    { url: "https://example.test/wp-includes/style.css", method: "get", status: 200, start_time_ms: 31, duration_ms: 18, resourceType: "stylesheet" },
    { url: "https://cdn.example.test/app.js", method: "get", status: 404, failed: true, start_time_ms: 55, response_end_ms: 70 },
  ],
})

assert.equal(profile.schema_version, BROWSER_RESULT_SCHEMA_VERSION)
assert.deepEqual(profile.phase_marks, [
  { name: "navigation", start_time_ms: 0 },
  { name: "dom_ready", start_time_ms: 20 },
])
assert.deepEqual(profile.phases, {
  dom_ready: { duration_ms: 0, end_time_ms: null, start_time_ms: 20 },
  navigation: { duration_ms: 20, end_time_ms: 20, start_time_ms: 0 },
})

assert.deepEqual(normalizeBrowserTimingRows(profile, {
  normalizeUrl: (url) => new URL(url, "https://example.test").hostname,
}), [
  {
    durationMs: 20,
    initiatorType: "link",
    method: "GET",
    normalizedUrl: "example.test",
    phase: "dom_ready",
    raw: {
      duration: 20,
      duration_ms: 18,
      initiatorType: "link",
      method: "get",
      name: "https://example.test/wp-includes/style.css",
      resourceType: "stylesheet",
      responseEnd: 50,
      responseStart: 40,
      startTime: 30,
      start_time_ms: 31,
      status: 200,
      url: "https://example.test/wp-includes/style.css",
    },
    startTime: 30,
    status: 200,
    ttfbMs: 10,
    url: "https://example.test/wp-includes/style.css",
  },
  {
    durationMs: 15,
    failed: true,
    method: "GET",
    normalizedUrl: "cdn.example.test",
    phase: "dom_ready",
    raw: {
      failed: true,
      method: "get",
      response_end_ms: 70,
      start_time_ms: 55,
      status: 404,
      url: "https://cdn.example.test/app.js",
    },
    startTime: 55,
    status: 404,
    url: "https://cdn.example.test/app.js",
  },
])

assert.deepEqual(normalizeBrowserNetworkRequest({
  name: "https://example.test/wp-json/",
  requestMethod: "post",
  resourceType: "fetch",
  statusCode: 201,
  startTime: 1.23456,
  duration: 9.87654,
}), {
  duration_ms: 9.877,
  failed: false,
  method: "POST",
  resource_type: "fetch",
  start_time_ms: 1.235,
  status: 201,
  url: "https://example.test/wp-json/",
})

console.log("Browser result shape normalization smoke passed")
