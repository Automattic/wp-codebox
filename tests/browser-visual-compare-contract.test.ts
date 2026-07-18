import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { PNG } from "pngjs"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { runVisualCompareCommand } from "../packages/runtime-playground/dist/browser-visual-compare.js"
import { withTempDir } from "../scripts/test-kit.js"

const visualCompare = commandRegistry.find((definition) => definition.id === "wordpress.visual-compare")
assert.ok(visualCompare, "wordpress.visual-compare is registered")

const acceptedArgs = visualCompare.acceptedArgs
const maxElements = acceptedArgs.find((arg) => arg.name === "max-explanation-elements")
const maxCandidates = acceptedArgs.find((arg) => arg.name === "max-explanation-candidates")
const selector = acceptedArgs.find((arg) => arg.name === "explain-selector")
assert.deepEqual(maxElements && { format: maxElements.format }, { format: "positive integer" })
assert.deepEqual(maxCandidates && { format: maxCandidates.format }, { format: "positive integer" })
assert.deepEqual(selector && { repeatable: selector.repeatable, format: selector.format }, { repeatable: true, format: "CSS selector" })
const matrixDescription = acceptedArgs.find((arg) => arg.name === "matrix-json")?.description ?? ""
for (const field of ["maxExplanationElements", "maxExplanationCandidates", "explainSelectors", "max-explanation-elements", "max-explanation-candidates", "explain-selector"]) {
  assert.match(matrixDescription, new RegExp(field))
}

async function writePng(path: string): Promise<void> {
  const png = new PNG({ width: 1, height: 1 })
  png.data.set([255, 255, 255, 255])
  await writeFile(path, PNG.sync.write(png))
}

async function visualCompareRun(artifactRoot: string, args: string[]) {
  return runVisualCompareCommand({
    artifactRoot,
    server: {
      serverUrl: "http://127.0.0.1:1",
      playground: { run: async () => ({ text: "" }) },
      async [Symbol.asyncDispose]() {},
    },
    spec: { command: "wordpress.visual-compare", args },
  })
}

const expectedOptions = (maxExplanationElements: number, maxExplanationCandidates: number, explainSelectors?: string[]) => ({
  waitFor: "domcontentloaded",
  durationMs: 0,
  timeoutMs: 120_000,
  fullPage: true,
  maxFullPageHeight: 20_000,
  threshold: 0.1,
  includeAA: false,
  maxRegions: 8,
  maxExplanationElements,
  maxExplanationCandidates,
  ...(explainSelectors ? { explainSelectors } : {}),
})

await withTempDir("wp-codebox-visual-compare-contract-", async (artifactRoot) => {
  const sourceScreenshot = join(artifactRoot, "source.png")
  const candidateScreenshot = join(artifactRoot, "candidate.png")
  await Promise.all([writePng(sourceScreenshot), writePng(candidateScreenshot)])

  const defaults = JSON.parse((await visualCompareRun(artifactRoot, [`source-screenshot=${sourceScreenshot}`, `candidate-screenshot=${candidateScreenshot}`])).output)
  assert.deepEqual(defaults.options, expectedOptions(25, 160))

  const pair = JSON.parse((await visualCompareRun(artifactRoot, [
    `source-screenshot=${sourceScreenshot}`,
    `candidate-screenshot=${candidateScreenshot}`,
    "max-explanation-elements=40",
    "max-explanation-candidates=240",
    "explain-selector=main",
    "explain-selector=body",
  ])).output)
  assert.deepEqual(pair.options, expectedOptions(40, 240, ["main", "body"]))
  assert.equal(pair.schema, "wp-codebox/visual-compare/v1")
  assert.equal(pair.command, "wordpress.visual-compare")
  assert.equal(pair.status, "identical")
  assert.deepEqual(pair.files, {
    sourceScreenshot: "files/browser/visual-compare/source.png",
    candidateScreenshot: "files/browser/visual-compare/candidate.png",
    diffScreenshot: "files/browser/visual-compare/diff.png",
    visualDiff: "files/browser/visual-compare/visual-diff.json",
    blocksEngineVisualParity: "files/browser/visual-compare/blocks-engine-visual-parity-report.json",
    summary: "files/browser/visual-compare/summary.json",
  })
  assert.deepEqual(pair.comparison, {
    source: { width: 1, height: 1 },
    candidate: { width: 1, height: 1 },
    diff: { width: 1, height: 1 },
    mismatchPixels: 0,
    totalPixels: 1,
    mismatchRatio: 0,
    overlapMismatchPixels: 0,
    overlapPixels: 1,
    overlapMismatchRatio: 0,
    dimensionMismatch: false,
    dimensionDeltaPixels: 0,
    dimensionDeltaRatio: 0,
    regions: [],
  })
  for (const hash of Object.values(pair.hashes) as Array<{ algorithm: string; value: string }>) {
    assert.equal(hash.algorithm, "sha256")
    assert.match(hash.value, /^[a-f0-9]{64}$/)
  }
  const persistedPair = JSON.parse(await readFile(join(artifactRoot, pair.files.summary), "utf8"))
  assert.deepEqual(persistedPair.options, pair.options)
  assert.deepEqual(persistedPair.files, pair.files)

  for (const [arg, message] of [["max-explanation-elements=0", "max-explanation-elements"], ["max-explanation-candidates=0", "max-explanation-candidates"], ["max-explanation-elements=1.5", "max-explanation-elements"], ["max-explanation-candidates=160px", "max-explanation-candidates"]]) {
    await assert.rejects(visualCompareRun(artifactRoot, [`source-screenshot=${sourceScreenshot}`, `candidate-screenshot=${candidateScreenshot}`, arg]), new RegExp(`${message} must be a positive integer`))
  }

  const matrix = JSON.parse((await visualCompareRun(artifactRoot, [
    "explain-selector=main",
    "explain-selector=body",
    `matrix-json=${JSON.stringify({ comparisons: [{ name: "camel-case", sourceScreenshot, candidateScreenshot, maxExplanationElements: 50, maxExplanationCandidates: 300, explainSelectors: ["body", "article"] }, { name: "kebab-case", "source-screenshot": sourceScreenshot, "candidate-screenshot": candidateScreenshot, "max-explanation-elements": 60, "max-explanation-candidates": 320, "explain-selector": "article" }] })}`,
  ])).output)
  assert.equal(matrix.schema, "wp-codebox/visual-compare-matrix/v1")
  assert.equal(matrix.command, "wordpress.visual-compare")
  assert.equal(matrix.complete, true)
  assert.deepEqual(matrix.metrics, { expectedComparisons: 2, comparisons: 2, missing: 0, failed: 0, identical: 2, different: 0, maxMismatchRatio: 0, meanMismatchRatio: 0, maxOverlapMismatchRatio: 0, meanOverlapMismatchRatio: 0, maxMismatchPixels: 0, meanMismatchPixels: 0 })
  assert.deepEqual(matrix.comparisons[0].options, expectedOptions(50, 300, ["main", "body", "article"]))
  assert.deepEqual(matrix.comparisons[1].options, expectedOptions(60, 320, ["main", "body", "article"]))
  const persistedMatrix = JSON.parse(await readFile(join(artifactRoot, matrix.files.summary), "utf8"))
  assert.deepEqual(persistedMatrix.comparisons.map((comparison: { options: unknown }) => comparison.options), matrix.comparisons.map((comparison: { options: unknown }) => comparison.options))

  for (const [field, value] of [["maxExplanationElements", "1.5"], ["maxExplanationCandidates", 0]]) {
    await assert.rejects(
      visualCompareRun(artifactRoot, [`matrix-json=${JSON.stringify({ comparisons: [{ sourceScreenshot, candidateScreenshot, [field]: value }] })}`]),
      new RegExp(`${field === "maxExplanationElements" ? "max-explanation-elements" : "max-explanation-candidates"} must be a positive integer`),
    )
  }
})

console.log("browser visual compare contract passed")
