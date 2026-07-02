import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PNG } from "pngjs"

import { comparePngFiles, visualCompareCaptureReadiness, visualCompareCompactCaptureDiagnostics, visualCompareErrorDetail, visualCompareNavigationPolicy, visualCompareOfflineRequestAllowed, visualCompareRegionElementOverlaps, visualCompareSelectorDeltas, type VisualCompareCaptureDiagnostics } from "../packages/runtime-playground/src/browser-visual-compare.js"

// Build an opaque solid-color PNG. `fill` is [r,g,b].
function solidPng(width: number, height: number, fill: [number, number, number]): PNG {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) {
    const offset = i << 2
    png.data[offset] = fill[0]
    png.data[offset + 1] = fill[1]
    png.data[offset + 2] = fill[2]
    png.data[offset + 3] = 255
  }
  return png
}

function paintRect(png: PNG, x0: number, y0: number, x1: number, y1: number, fill: [number, number, number]): void {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (png.width * y + x) << 2
      png.data[offset] = fill[0]
      png.data[offset + 1] = fill[1]
      png.data[offset + 2] = fill[2]
      png.data[offset + 3] = 255
    }
  }
}

// 1. The capture-failure detail is ALWAYS non-empty and actionable. A crashed/closed
//    renderer target throws an Error whose `.message` is empty, which previously
//    surfaced as an opaque empty `capture-failed` diagnostic. Every shape must yield a
//    descriptive, non-empty string.
{
  assert.equal(visualCompareErrorDetail(new Error("boom")), "boom")
  const emptyError = new Error("")
  emptyError.name = "TargetClosedError"
  assert.equal(visualCompareErrorDetail(emptyError), "TargetClosedError (no message)")
  const namelessEmpty = new Error("")
  // Anonymous empty errors still report a non-empty fallback rather than "".
  assert.ok(visualCompareErrorDetail(namelessEmpty).trim().length > 0, "empty Error must yield non-empty detail")
  assert.equal(visualCompareErrorDetail(undefined), "unknown error (undefined)")
  assert.equal(visualCompareErrorDetail(null), "unknown error (null)")
  assert.equal(visualCompareErrorDetail("plain string failure"), "plain string failure")
  assert.ok(visualCompareErrorDetail("").trim().length > 0, "empty string must yield non-empty detail")
  assert.ok(visualCompareErrorDetail({ weird: true }).trim().length > 0, "object must yield non-empty detail")
}

// 2. URL capture navigation is bounded below the overall visual-compare wall. The
//    default 120s capture window must never be handed directly to `page.goto`; a bad
//    candidate route should fail with navigation diagnostics while leaving wall time for
//    failure summary artifacts.
{
  const policy = visualCompareNavigationPolicy(120_000)
  assert.equal(policy.attempts, 2)
  assert.equal(policy.navigationBudgetMs, 60_000)
  assert.equal(policy.perAttemptTimeoutMs, 30_000)
  assert.ok(policy.perAttemptTimeoutMs < 120_000, "page.goto timeout must stay below the visual-compare wall timeout")

  const shortPolicy = visualCompareNavigationPolicy(12_000)
  assert.equal(shortPolicy.attempts, 2)
  assert.equal(shortPolicy.navigationBudgetMs, 10_000)
  assert.equal(shortPolicy.perAttemptTimeoutMs, 5_000)
}

// 3. Offline isolation must allow loopback runtime handoffs, not only the originally
//    advertised preview origin. WP Codebox local previews can hand the browser from one
//    loopback port to another; blocking same-runtime CSS/images on the final port makes
//    visual-compare capture unstyled WordPress pages.
{
  assert.equal(visualCompareOfflineRequestAllowed("http://127.0.0.1:56816/wp-content/theme.css", "http://127.0.0.1:42573"), true)
  assert.equal(visualCompareOfflineRequestAllowed("http://localhost:56816/wp-content/theme.css", "http://127.0.0.1:42573"), true)
  assert.equal(visualCompareOfflineRequestAllowed("data:image/svg+xml;base64,AA==", "http://127.0.0.1:42573"), true)
  assert.equal(visualCompareOfflineRequestAllowed("https://fonts.example.invalid/font.woff2", "http://127.0.0.1:42573"), false)
}

// Count pixels in a diff PNG whose RGB is nonzero — the exact predicate the region
// detector uses (`visualCompareDiffPixel`). pixelmatch renders even unchanged pixels as
// a dimmed grayscale of the original, so for a real (or solid) page this is typically the
// whole canvas, which is precisely why the flood fill walks every pixel and why bounding
// its stack matters.
function countDiffPixels(png: PNG): number {
  let count = 0
  for (let i = 0; i < png.width * png.height; i += 1) {
    const offset = i << 2
    if (png.data[offset] > 0 || png.data[offset + 1] > 0 || png.data[offset + 2] > 0) {
      count += 1
    }
  }
  return count
}

// 4. Mismatch-region attribution ranks DOM elements by how much of the hotspot they
//    cover and carries the element path/styles needed for actionable visual repairs.
{
  const overlaps = visualCompareRegionElementOverlaps({ x: 10, y: 20, width: 100, height: 50, pixels: 5000 }, [
    {
      path: "div.wrapper",
      tag: "div",
      text: "Wrapper",
      attributes: { class: "wrapper" },
      boundingBox: { x: 0, y: 0, width: 400, height: 300 },
      styles: { display: "block", position: "static", width: "400px", height: "300px", color: "rgb(1, 2, 3)", "background-color": "rgb(255, 255, 255)" },
    },
    {
      path: "button.cta",
      tag: "button",
      text: "Buy now",
      attributes: { class: "cta" },
      boundingBox: { x: 20, y: 25, width: 80, height: 30 },
      styles: { display: "inline-block", position: "static", width: "80px", height: "30px", color: "rgb(9, 9, 9)", "background-color": "rgb(200, 0, 0)", "font-size": "16px" },
    },
  ], 2)

  assert.equal(overlaps.length, 2)
  assert.equal(overlaps[0]?.path, "div.wrapper")
  assert.equal(overlaps[0]?.overlap.area, 5000)
  assert.equal(overlaps[0]?.overlap.regionCoverage, 1)
  assert.equal(overlaps[1]?.path, "button.cta")
  assert.equal(overlaps[1]?.overlap.area, 2400)
  assert.equal(overlaps[1]?.className, "cta")
  assert.equal(overlaps[1]?.styles["background-color"], "rgb(200, 0, 0)")
}

// 5. The bounded flood-fill region detection runs the real comparePngFiles aggregation
// 5. Requested single-match selectors produce paired deltas even when source and
//    candidate DOM paths differ after a structural move.
{
  const selectorDeltas = visualCompareSelectorDeltas(
    [{ selector: ".cta", matched: 1, captured: 1, paths: ["main > a.cta"] }],
    [{ selector: ".cta", matched: 1, captured: 1, paths: ["main > div.actions > a.cta"] }],
    [{ path: "main > a.cta", tag: "a", text: "Start", attributes: { class: "cta" }, boundingBox: { x: 20, y: 40, width: 120, height: 32 }, styles: { display: "inline-flex", gap: "4px", color: "rgb(1, 1, 1)", "font-size": "16px" } }],
    [{ path: "main > div.actions > a.cta", tag: "a", text: "Start", attributes: { class: "cta" }, boundingBox: { x: 20, y: 52, width: 132, height: 32 }, styles: { display: "inline-flex", gap: "12px", color: "rgb(2, 2, 2)", "font-size": "18px" } }],
    [".cta"],
  )

  assert.equal(selectorDeltas.length, 1)
  assert.equal(selectorDeltas[0]?.selector, ".cta")
  assert.equal(selectorDeltas[0]?.sourcePath, "main > a.cta")
  assert.equal(selectorDeltas[0]?.candidatePath, "main > div.actions > a.cta")
  assert.equal(selectorDeltas[0]?.boundingBox.delta.y, 12)
  assert.equal(selectorDeltas[0]?.boundingBox.delta.width, 12)
  assert.equal(selectorDeltas[0]?.boundingBox.severity, "error")
  assert.equal(selectorDeltas[0]?.styles.find((style) => style.property === "gap")?.category, "layout")
  assert.equal(selectorDeltas[0]?.styles.find((style) => style.property === "font-size")?.category, "typography")
  assert.equal(selectorDeltas[0]?.styles.find((style) => style.property === "color")?.category, "paint")
}

// 6. Capture diagnostics are normalized into compact readiness/noise signals without
//    changing diff policy. Asset problems and dynamic content lower confidence; clean
//    settled pages stay high-confidence.
{
  const clean = visualCompareCaptureReadiness({
    assets: {
      stylesheets: { total: 2, loaded: 2, pending: 0, errored: 0 },
      images: { total: 1, loaded: 1, loading: 0, failed: 0 },
      fonts: { status: "loaded", total: 1, loaded: 1, loading: 0, error: 0 },
    },
    dynamicContent: { fixed: 0, sticky: 0, video: 0, canvas: 0, iframe: 0, animated: 0, focusedElement: false },
  })
  assert.equal(clean.status, "ready")
  assert.equal(clean.confidence, "high")
  assert.deepEqual(clean.reasons, [])

  const noisy = visualCompareCaptureReadiness({
    assets: {
      stylesheets: { total: 3, loaded: 1, pending: 1, errored: 1 },
      images: { total: 4, loaded: 2, loading: 1, failed: 1 },
      fonts: { status: "loading", total: 2, loaded: 1, loading: 1, error: 0 },
    },
    dynamicContent: { fixed: 2, sticky: 1, video: 1, canvas: 1, iframe: 1, animated: 2, focusedElement: true, focusedElementTag: "input" },
  })
  assert.equal(noisy.status, "warning")
  assert.equal(noisy.confidence, "low")
  assert.ok(noisy.reasons.some((reason) => reason.includes("stylesheet")))
  assert.ok(noisy.reasons.some((reason) => reason.includes("dynamic/noisy")))

  const diagnostic: VisualCompareCaptureDiagnostics = {
    schema: "wp-codebox/visual-compare-capture-diagnostics/v1",
    readiness: noisy,
    assets: {
      stylesheets: { total: 3, loaded: 1, pending: 1, errored: 1 },
      images: { total: 4, loaded: 2, loading: 1, failed: 1 },
      fonts: { status: "loading", total: 2, loaded: 1, loading: 1, error: 0 },
    },
    environment: {
      url: "http://example.test/page",
      title: "Example",
      userAgent: "test-agent",
      viewport: { width: 390, height: 844 },
      devicePixelRatio: 2,
      colorScheme: "light",
      reducedMotion: false,
      timezone: "UTC",
    },
    dynamicContent: { fixed: 2, sticky: 1, video: 1, canvas: 1, iframe: 1, animated: 2, focusedElement: true, focusedElementTag: "input" },
  }
  const compact = visualCompareCompactCaptureDiagnostics({ source: diagnostic })
  assert.equal(compact.source?.readiness, "warning")
  assert.equal(compact.source?.assets.stylesheets.pending, 1)
  assert.equal(compact.source?.dynamicContent.focusedElementTag, "input")
  assert.equal(compact.source?.environment.url, "http://example.test/page")
  assert.equal("title" in (compact.source?.environment ?? {}), false)
}

// 7. The bounded flood-fill region detection runs the real comparePngFiles aggregation
//    over a large, tall, high-mismatch canvas — the exact shape that previously OOM'd
//    old-space by pushing ~4× the diff-pixel count as [x,y] tuple arrays and marking
//    visited only at pop time. The rewrite (flat numeric index stack, mark-at-push) must
//    complete AND recover every diff pixel exactly: the union of region pixel counts must
//    equal the number of nonzero diff pixels in the written diff, with bounded region
//    count and in-canvas geometry.
const dir = await mkdtemp(join(tmpdir(), "visual-compare-capture-"))
try {
  const sourcePath = join(dir, "source.png")
  const candidatePath = join(dir, "candidate.png")
  const diffPath = join(dir, "diff.png")
  const options = { threshold: 0.1, includeAA: false, maxRegions: 8 }

  {
    const white: [number, number, number] = [255, 255, 255]
    const red: [number, number, number] = [255, 0, 0]
    // 600 wide × 4000 tall = 2.4M px. Paint a large 600×3000 changed band (75% of px).
    const width = 600
    const height = 4000
    const source = solidPng(width, height, white)
    const candidate = solidPng(width, height, white)
    paintRect(candidate, 0, 0, width, 3000, red)
    await writeFile(sourcePath, PNG.sync.write(source))
    await writeFile(candidatePath, PNG.sync.write(candidate))

    const result = await comparePngFiles(sourcePath, candidatePath, diffPath, options)
    assert.equal(result.dimensionMismatch, false)
    // pixelmatch's CHANGED-pixel count is exactly the painted band.
    assert.equal(result.mismatchPixels, width * 3000)
    assert.ok(Math.abs(result.mismatchRatio - 0.75) < 0.001, `expected ~0.75 mismatch ratio, got ${result.mismatchRatio}`)
    assert.ok(result.regions.length > 0, "a large mismatch must produce at least one region")
    assert.ok(result.regions.length <= options.maxRegions, "region count must be bounded by maxRegions")

    // The recovered regions must account for exactly the changed pixels reported by
    // pixelmatch. Unchanged grayscale context in the diff image is nonzero too, but
    // it must not become one huge false hotspot.
    const diffPng = PNG.sync.read(await readFile(diffPath))
    const nonzeroDiffPixels = countDiffPixels(diffPng)
    const totalRegionPixels = result.regions.reduce((sum, region) => sum + region.pixels, 0)
    assert.equal(totalRegionPixels, result.overlapMismatchPixels, "recovered regions must account for every changed pixel exactly")
    assert.ok(totalRegionPixels < nonzeroDiffPixels, "unchanged grayscale diff context must not be counted as hotspot pixels")

    // Region geometry stays within the canvas.
    for (const region of result.regions) {
      assert.ok(region.x >= 0 && region.y >= 0, "region origin must be in-canvas")
      assert.ok(region.x + region.width <= width, "region must not exceed canvas width")
      assert.ok(region.y + region.height <= height, "region must not exceed canvas height")
    }
  }

  console.log("browser visual compare capture-reliability (error detail + bounded region detection) passed")
} finally {
  await rm(dir, { recursive: true, force: true })
}
