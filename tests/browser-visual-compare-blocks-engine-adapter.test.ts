import assert from "node:assert/strict"

import { blocksEngineVisualParityReportFromVisualCompare } from "../packages/runtime-playground/src/browser-visual-compare.js"

const report = blocksEngineVisualParityReportFromVisualCompare({
  schema: "wp-codebox/visual-compare/v1",
  command: "wordpress.visual-compare",
  status: "different",
  source: { label: "source", url: "/source", finalUrl: "http://example.test/source" },
  candidate: { label: "candidate", url: "/candidate", finalUrl: "http://example.test/candidate" },
  options: { threshold: 0.1 },
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "test" },
  files: {
    sourceScreenshot: "files/browser/visual-compare/source.png",
    candidateScreenshot: "files/browser/visual-compare/candidate.png",
    diffScreenshot: "files/browser/visual-compare/diff.png",
    visualDiff: "files/browser/visual-compare/visual-diff.json",
  },
  comparison: { mismatchRatio: 0.0125, mismatchPixels: 42, totalPixels: 336960, dimensionMismatch: false },
  explanation: {
    schema: "wp-codebox/visual-explanation/v1",
    source: { label: "source", url: "/source", title: "Source", elementCount: 1, capturedElements: 1, truncated: false },
    candidate: { label: "candidate", url: "/candidate", title: "Candidate", elementCount: 1, capturedElements: 1, truncated: false },
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "test" },
    mismatchRegions: [],
    selectors: [{ selector: ".cta", source: { selector: ".cta", matched: 1, captured: 1, paths: ["main > a.cta"] }, candidate: { selector: ".cta", matched: 1, captured: 1, paths: ["main > div.actions > a.cta"] } }],
    selectorDeltas: [{
      selector: ".cta",
      sourcePath: "main > a.cta",
      candidatePath: "main > div.actions > a.cta",
      source: { path: "main > a.cta", tag: "a", boundingBox: { x: 20, y: 40, width: 120, height: 32 } },
      candidate: { path: "main > div.actions > a.cta", tag: "a", boundingBox: { x: 20, y: 52, width: 132, height: 32 } },
      boundingBox: { source: { x: 20, y: 40, width: 120, height: 32 }, candidate: { x: 20, y: 52, width: 132, height: 32 }, delta: { x: 0, y: 12, width: 12, height: 0 }, severity: "error", category: "layout", hint: "Check layout, spacing, sizing, and positioning rules for this selector." },
      styles: [{ property: "gap", source: "4px", candidate: "12px", category: "layout", severity: "warning", hint: "Check layout, flow, sizing, or spacing rules for this selector." }],
    }],
    limits: { maxElements: 25, maxCandidates: 160 },
    truncation: { changed: false, added: false, removed: false },
    summary: { changedElements: 0, addedElements: 0, removedElements: 0, sourceCapturedElements: 1, candidateCapturedElements: 1 },
    changes: [],
    added: [],
    removed: [],
    limitations: [],
  },
})

assert.equal(report.schema, "blocks-engine/php-transformer/visual-parity-report/v1")
assert.equal(report.status, "fail")
assert.equal(report.severity, "error")
assert.deepEqual(report.source_render, {
  kind: "source",
  url: "/source",
  ref: "http://example.test/source",
  renderer: "source",
  screenshot_path: "files/browser/visual-compare/source.png",
})
assert.deepEqual(report.target_render, {
  kind: "target",
  url: "/candidate",
  ref: "http://example.test/candidate",
  renderer: "candidate",
  screenshot_path: "files/browser/visual-compare/candidate.png",
})
assert.deepEqual(report.viewports, [{
  id: "default",
  width: 390,
  height: 844,
  device_scale_factor: 2,
  source_screenshot_path: "files/browser/visual-compare/source.png",
  target_screenshot_path: "files/browser/visual-compare/candidate.png",
  diff_screenshot_path: "files/browser/visual-compare/diff.png",
}])
assert.equal(report.visual_diff?.available, true)
assert.equal(report.visual_diff?.mismatch_percent, 1.25)
assert.equal(report.visual_diff?.mismatch_pixels, 42)
assert.equal(report.visual_diff?.total_pixels, 336960)
assert.equal(report.visual_diff?.threshold, 0.1)
assert.equal(report.findings.length, 1)
assert.equal(report.findings[0]?.id, "visual-diff-default")
assert.equal(report.findings[0]?.recommendation_ids?.[0], "review-visual-diff")
assert.equal(report.recommendations[0]?.priority, "blocking")
assert.equal(report.matches[0]?.source_selector, ".cta")
assert.equal(report.computed_style_deltas?.length, 2)
assert.equal(report.computed_style_deltas?.[0]?.property, "bounding-box")
assert.equal(report.computed_style_deltas?.[0]?.severity, "error")
assert.equal(report.computed_style_deltas?.[0]?.source_selector, ".cta")
assert.equal(report.computed_style_deltas?.[0]?.viewport_id, "default")
assert.deepEqual(report.computed_style_deltas?.[0]?.delta, { x: 0, y: 12, width: 12, height: 0, category: "layout", hint: "Check layout, spacing, sizing, and positioning rules for this selector." })
assert.equal(report.computed_style_deltas?.[1]?.property, "gap")
assert.equal(report.computed_style_deltas?.[1]?.delta?.category, "layout")

const matrixReport = blocksEngineVisualParityReportFromVisualCompare({
  schema: "wp-codebox/visual-compare-matrix/v1",
  command: "wordpress.visual-compare",
  status: "identical",
  metrics: { comparisons: 2, maxMismatchPixels: 0 },
  comparisons: [
    {
      name: "mobile",
      status: "identical",
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "test" },
      files: { sourceScreenshot: "mobile-source.png", candidateScreenshot: "mobile-candidate.png", diffScreenshot: "mobile-diff.png" },
      comparison: { mismatchRatio: 0, mismatchPixels: 0, totalPixels: 336960, dimensionMismatch: false },
    },
  ],
})

assert.equal(matrixReport.status, "pass")
assert.equal(matrixReport.severity, "none")
assert.equal(matrixReport.viewports[0]?.id, "mobile")
assert.equal(matrixReport.visual_diff?.by_viewport?.[0]?.viewport_id, "mobile")
assert.equal(matrixReport.findings.length, 0)

console.log("browser visual compare Blocks Engine adapter passed")
