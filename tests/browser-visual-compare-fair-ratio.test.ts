import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PNG } from "pngjs"

import { comparePngFiles } from "../packages/runtime-playground/src/browser-visual-compare.js"

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

// Paint an opaque rectangle into an existing PNG.
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

const options = { threshold: 0.1, includeAA: false, maxRegions: 8 }

const dir = await mkdtemp(join(tmpdir(), "visual-compare-fair-"))
try {
  const sourcePath = join(dir, "source.png")
  const candidatePath = join(dir, "candidate.png")
  const diffPath = join(dir, "diff.png")

  // 1. Identical content + identical dimensions: every ratio is exactly 0 and there
  //    is no dimension delta.
  {
    const navy: [number, number, number] = [12, 18, 48]
    await writeFile(sourcePath, PNG.sync.write(solidPng(200, 300, navy)))
    await writeFile(candidatePath, PNG.sync.write(solidPng(200, 300, navy)))
    const result = await comparePngFiles(sourcePath, candidatePath, diffPath, options)
    assert.equal(result.dimensionMismatch, false)
    assert.equal(result.mismatchPixels, 0)
    assert.equal(result.mismatchRatio, 0)
    assert.equal(result.overlapMismatchPixels, 0)
    assert.equal(result.overlapMismatchRatio, 0)
    assert.equal(result.overlapPixels, 200 * 300)
    assert.equal(result.dimensionDeltaPixels, 0)
    assert.equal(result.dimensionDeltaRatio, 0)
  }

  // 2. THE dimension-fairness proof. The overlap region is pixel-identical, but the
  //    source canvas is much larger (1380x7248) than the candidate (1280x5017) —
  //    the exact baseline shape from the SSI 15-saas gate. The RAW ratio is dominated
  //    by the canvas-size band and is large; the FAIR (overlap) ratio is exactly 0
  //    because where both renders overlap they are identical.
  {
    const navy: [number, number, number] = [12, 18, 48]
    const source = solidPng(1380, 7248, navy)
    const candidate = solidPng(1280, 5017, navy)
    await writeFile(sourcePath, PNG.sync.write(source))
    await writeFile(candidatePath, PNG.sync.write(candidate))
    const result = await comparePngFiles(sourcePath, candidatePath, diffPath, options)

    assert.equal(result.dimensionMismatch, true)
    // Overlap is min(width) x min(height) and is pixel-perfect.
    assert.equal(result.overlapPixels, 1280 * 5017)
    assert.equal(result.overlapMismatchPixels, 0)
    assert.equal(result.overlapMismatchRatio, 0)
    // The union canvas is max(width) x max(height).
    assert.equal(result.totalPixels, 1380 * 7248)
    // Raw ratio is dimension-dominated: the whole non-overlap band counts as a diff.
    const expectedDimensionDeltaPixels = 1380 * 7248 - 1280 * 5017
    assert.equal(result.dimensionDeltaPixels, expectedDimensionDeltaPixels)
    assert.equal(result.mismatchPixels, expectedDimensionDeltaPixels)
    assert.ok(result.mismatchRatio > 0.35, `raw ratio should be dimension-dominated, got ${result.mismatchRatio}`)
    // The fair signal must be ~0 even though the raw signal is huge — this is the
    // entire point of the trustworthy ratio.
    assert.ok(result.overlapMismatchRatio < 0.0001, `fair ratio should be ~0, got ${result.overlapMismatchRatio}`)
    assert.ok(result.mismatchRatio - result.overlapMismatchRatio > 0.35, "raw and fair ratios must diverge under a dimension mismatch")
  }

  // 3. A real visual difference inside the overlap is reflected by the fair ratio,
  //    and for equal dimensions the fair ratio equals the raw ratio.
  {
    const white: [number, number, number] = [255, 255, 255]
    const red: [number, number, number] = [255, 0, 0]
    const source = solidPng(100, 100, white)
    const candidate = solidPng(100, 100, white)
    // 20x100 = 2000 px of 10000 differ (20%).
    paintRect(candidate, 0, 0, 20, 100, red)
    await writeFile(sourcePath, PNG.sync.write(source))
    await writeFile(candidatePath, PNG.sync.write(candidate))
    const result = await comparePngFiles(sourcePath, candidatePath, diffPath, options)
    assert.equal(result.dimensionMismatch, false)
    assert.equal(result.overlapPixels, 10000)
    assert.equal(result.mismatchPixels, result.overlapMismatchPixels)
    assert.equal(result.mismatchRatio, result.overlapMismatchRatio)
    assert.ok(Math.abs(result.overlapMismatchRatio - 0.2) < 0.01, `fair ratio should track the painted diff (~0.2), got ${result.overlapMismatchRatio}`)
  }

  // 4. Real diff inside the overlap AND a dimension mismatch: the fair ratio isolates
  //    the genuine in-overlap difference and is unpolluted by the size band.
  {
    const white: [number, number, number] = [255, 255, 255]
    const red: [number, number, number] = [255, 0, 0]
    const source = solidPng(100, 100, white)
    const candidate = solidPng(80, 200, white)
    // Diff a 8x100 band inside the 80x100 overlap = 800 / 8000 = 10%.
    paintRect(candidate, 0, 0, 8, 100, red)
    await writeFile(sourcePath, PNG.sync.write(source))
    await writeFile(candidatePath, PNG.sync.write(candidate))
    const result = await comparePngFiles(sourcePath, candidatePath, diffPath, options)
    assert.equal(result.dimensionMismatch, true)
    assert.equal(result.overlapPixels, 80 * 100)
    assert.ok(Math.abs(result.overlapMismatchRatio - 0.1) < 0.01, `fair ratio should isolate in-overlap diff (~0.1), got ${result.overlapMismatchRatio}`)
    // Raw ratio is inflated by the size band well beyond the real 10% difference.
    assert.ok(result.mismatchRatio > result.overlapMismatchRatio, "raw ratio should exceed fair ratio under dimension mismatch")
  }

  console.log("browser visual compare fair-ratio (dimension fairness) passed")
} finally {
  await rm(dir, { recursive: true, force: true })
}
