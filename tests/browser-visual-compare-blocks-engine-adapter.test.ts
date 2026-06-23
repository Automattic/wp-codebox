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
