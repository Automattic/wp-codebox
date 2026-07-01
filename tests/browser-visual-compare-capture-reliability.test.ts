import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PNG } from "pngjs"

import { comparePngFiles, visualCompareErrorDetail, visualCompareNavigationPolicy } from "../packages/runtime-playground/src/browser-visual-compare.js"

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

// 3. The bounded flood-fill region detection runs the real comparePngFiles aggregation
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

    // The recovered regions must account for exactly the nonzero diff pixels — proving
    // the rewritten flood fill counts every reachable diff pixel and double-counts none.
    const diffPng = PNG.sync.read(await readFile(diffPath))
    const nonzeroDiffPixels = countDiffPixels(diffPng)
    const totalRegionPixels = result.regions.reduce((sum, region) => sum + region.pixels, 0)
    assert.equal(totalRegionPixels, nonzeroDiffPixels, "recovered regions must account for every diff pixel exactly")

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
