import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-visual-compare-smoke")
const pluginDir = join(workspace, "visual-compare-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "visual-compare-fixture.php"), `<?php
/**
 * Plugin Name: Visual Compare Fixture
 */
add_action( 'template_redirect', function () {
    if ( ! isset( $_GET['wp_codebox_visual_compare_fixture'] ) ) {
        return;
    }

    $variant = isset( $_GET['variant'] ) ? sanitize_key( $_GET['variant'] ) : 'source';
    $color   = 'candidate' === $variant ? '#2563eb' : '#dc2626';
    nocache_headers();
    echo '<!doctype html><html><head><style>body{margin:0}.marker{height:1px}.card{width:220px;height:120px;background:' . esc_attr( $color ) . ';color:white;font:24px sans-serif;display:grid;place-items:center}</style></head><body><div class="marker">one</div><div class="marker">two</div><div class="marker">three</div><main class="card">' . esc_html( $variant ) . '</main></body></html>';
    exit;
} );
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extra_plugins: [
      {
        source: "./visual-compare-fixture",
        pluginFile: "visual-compare-fixture/visual-compare-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.visual-compare",
        args: [
          "source-url=/?wp_codebox_visual_compare_fixture=1&variant=source",
          "candidate-url=/?wp_codebox_visual_compare_fixture=1&variant=candidate",
          "source-label=source-fixture",
          "candidate-label=candidate-fixture",
          "viewport=320x240",
          "full-page=false",
          "wait-for=load",
          "threshold=0.1",
          "max-explanation-candidates=2",
          "explain-selector=main.card",
          "explain-selector=.missing-selector",
        ],
      },
    ],
  },
  artifacts: {
    directory: artifactsRoot,
  },
}, null, 2)}\n`)

const output = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  recipePath,
  "--json",
])

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

const artifactDirectory = output.artifacts.directory
const sourcePath = join(artifactDirectory, "files", "browser", "visual-compare", "source.png")
const candidatePath = join(artifactDirectory, "files", "browser", "visual-compare", "candidate.png")
const diffPath = join(artifactDirectory, "files", "browser", "visual-compare", "diff.png")
const summaryPath = join(artifactDirectory, "files", "browser", "visual-compare", "visual-diff.json")
const explanationPath = join(artifactDirectory, "files", "browser", "visual-compare", "visual-explanation.json")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")
const baselineRecipePath = join(workspace, "baseline-recipe.json")

assert.equal(existsSync(sourcePath), true, "source screenshot should be captured")
assert.equal(existsSync(candidatePath), true, "candidate screenshot should be captured")
assert.equal(existsSync(diffPath), true, "diff screenshot should be captured")
assert.equal(existsSync(summaryPath), true, "visual diff summary should be captured")
assert.equal(existsSync(explanationPath), true, "visual explanation should be captured for URL targets")

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  schema: string
  status: string
  files: Record<string, string>
  limitations: string[]
  comparison: { mismatchPixels: number; mismatchRatio: number; dimensionMismatch: boolean; regions: unknown[] }
}
assert.equal(summary.schema, "wp-codebox/visual-compare/v1")
assert.equal(summary.status, "different")
assert.equal(summary.files.sourceScreenshot, "files/browser/visual-compare/source.png")
assert.equal(summary.files.candidateScreenshot, "files/browser/visual-compare/candidate.png")
assert.equal(summary.files.diffScreenshot, "files/browser/visual-compare/diff.png")
assert.equal(summary.files.visualDiff, "files/browser/visual-compare/visual-diff.json")
assert.equal(summary.files.visualExplanation, "files/browser/visual-compare/visual-explanation.json")
assert.ok(summary.comparison.mismatchPixels > 0, "comparison should report mismatched pixels")
assert.ok(summary.comparison.mismatchRatio > 0, "comparison should report mismatch ratio")
assert.equal(summary.comparison.dimensionMismatch, false, "fixture screenshots should share dimensions")
assert.ok(summary.comparison.regions.length > 0, "comparison should report mismatch regions")
assert.ok(summary.limitations.some((limitation) => limitation.includes("heuristic evidence")), "summary should document visual explanation limitations")

const explanation = JSON.parse(await readFile(explanationPath, "utf8")) as {
  schema: string
  source: { label: string; capturedElements: number }
  candidate: { label: string; capturedElements: number }
  summary: { changedElements: number }
  changes: Array<{ path: string; changes: { text?: unknown; styles?: Record<string, unknown> } }>
  selectors?: Array<{ selector: string; source: { matched: number; captured: number; paths: string[] }; candidate: { matched: number; captured: number; paths: string[] } }>
  missingSelectors?: Array<{ selector: string; sourceMatched: boolean; candidateMatched: boolean }>
  mismatchRegions: unknown[]
  limitations: string[]
}
assert.equal(explanation.schema, "wp-codebox/visual-explanation/v1")
assert.equal(explanation.source.label, "source-fixture")
assert.equal(explanation.candidate.label, "candidate-fixture")
assert.ok(explanation.source.capturedElements > 0, "explanation should include source DOM context")
assert.ok(explanation.candidate.capturedElements > 0, "explanation should include candidate DOM context")
assert.ok(explanation.summary.changedElements > 0, "explanation should report changed elements")
assert.ok(explanation.changes.some((change) => change.path.includes("main") && change.changes.text), "explanation should report text changes")
assert.ok(explanation.changes.some((change) => change.changes.styles?.["background-color"]), "explanation should report computed style changes")
const focusedSelector = explanation.selectors?.find((selector) => selector.selector === "main.card")
assert.ok(focusedSelector, "explanation should include selector match diagnostics")
assert.equal(focusedSelector.source.matched, 1, "source selector should match the focused element")
assert.equal(focusedSelector.candidate.matched, 1, "candidate selector should match the focused element")
assert.ok(focusedSelector.source.paths.some((path) => path.includes("main")), "focused source selector should force the target path into the snapshot")
assert.ok(focusedSelector.candidate.paths.some((path) => path.includes("main")), "focused candidate selector should force the target path into the snapshot")
assert.ok(explanation.missingSelectors?.some((selector) => selector.selector === ".missing-selector" && selector.sourceMatched === false && selector.candidateMatched === false), "missing selectors should be machine-readable")
assert.ok(explanation.mismatchRegions.length > 0, "explanation should include mismatch regions")
assert.ok(explanation.limitations.length > 0, "explanation should include limitations")

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/source.png" && file.kind === "browser-visual-source-screenshot"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/candidate.png" && file.kind === "browser-visual-candidate-screenshot"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/diff.png" && file.kind === "browser-visual-diff-screenshot"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/visual-diff.json" && file.kind === "browser-visual-diff"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/visual-explanation.json" && file.kind === "browser-visual-explanation"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ visualCompare?: { status?: string; mismatchPixels?: number; explanation?: string } }> } }
assert.equal(review.browser?.probes?.[0]?.visualCompare?.status, "different", "review summary should expose visual compare status")
assert.ok((review.browser?.probes?.[0]?.visualCompare?.mismatchPixels ?? 0) > 0, "review summary should expose visual compare mismatch count")
assert.equal(review.browser?.probes?.[0]?.visualCompare?.explanation, "files/browser/visual-compare/visual-explanation.json", "review summary should expose visual explanation artifact")

await writeFile(baselineRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      {
        command: "wordpress.visual-compare",
        args: [
          `source-screenshot=${sourcePath}`,
          `candidate-screenshot=${candidatePath}`,
          `baseline-visual-diff=${summaryPath}`,
          "source-label=source-fixture",
          "candidate-label=candidate-fixture",
          "threshold=0.1",
        ],
      },
    ],
  },
  artifacts: {
    directory: artifactsRoot,
  },
}, null, 2)}\n`)

const baselineOutput = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  baselineRecipePath,
  "--json",
])

assert.equal(baselineOutput.success, true, baselineOutput.error?.message ?? "baseline recipe-run failed")
assert.ok(baselineOutput.artifacts?.directory, "baseline recipe-run should return an artifact directory")

const baselineSummaryPath = join(baselineOutput.artifacts.directory, "files", "browser", "visual-compare", "visual-diff.json")
const baselineSummary = JSON.parse(await readFile(baselineSummaryPath, "utf8")) as {
  baseline?: {
    ref: string
    selectedIndex: number
    match: string
    availableComparisons: number
    delta: {
      status?: { changed: boolean }
      mismatchPixels?: { baseline: number; current: number; absoluteDelta: number }
      mismatchRatio?: { baseline: number; current: number; absoluteDelta: number }
      dimensionMismatch?: { changed: boolean }
    }
  }
}
assert.equal(baselineSummary.baseline?.ref, summaryPath, "summary should record the requested baseline ref")
assert.equal(baselineSummary.baseline?.selectedIndex, 0, "summary should identify the selected baseline comparison")
assert.equal(baselineSummary.baseline?.match, "labels", "summary should match previous evidence by labels")
assert.equal(baselineSummary.baseline?.availableComparisons, 1, "summary should report available comparisons in the baseline artifact")
assert.equal(baselineSummary.baseline?.delta.status?.changed, false, "same screenshots should not change status relative to baseline")
assert.equal(baselineSummary.baseline?.delta.mismatchPixels?.absoluteDelta, 0, "same screenshots should not change mismatch pixels relative to baseline")
assert.equal(baselineSummary.baseline?.delta.mismatchRatio?.absoluteDelta, 0, "same screenshots should not change mismatch ratio relative to baseline")
assert.equal(baselineSummary.baseline?.delta.dimensionMismatch?.changed, false, "same screenshots should not change dimension mismatch status relative to baseline")

const missingInputRecipePath = join(workspace, "missing-input-recipe.json")
const missingInputArtifactsRoot = join(workspace, "missing-input-artifacts")
const missingCandidatePath = join(workspace, "missing-candidate-after-interruption.png")
await writeFile(missingInputRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      {
        command: "wordpress.visual-compare",
        args: [
          `source-screenshot=${sourcePath}`,
          `candidate-screenshot=${missingCandidatePath}`,
          "source-label=source-after-browser-actions",
          "candidate-label=candidate-after-browser-actions",
          "threshold=0.1",
        ],
      },
    ],
  },
  artifacts: {
    directory: missingInputArtifactsRoot,
  },
}, null, 2)}\n`)

const missingInputOutput = await runCliAllowFailure([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  missingInputRecipePath,
  "--json",
])

assert.equal(missingInputOutput.success, false, "missing visual compare input should fail the recipe")
assert.ok(missingInputOutput.artifacts?.directory, "missing visual compare input should still return artifacts")
assert.ok(missingInputOutput.error?.message?.includes("wordpress.visual-compare missing expected screenshot input"), "missing input failure should be reported as a structured visual compare failure")
assert.equal(missingInputOutput.error?.message?.includes("ENOENT"), false, "missing input failure should not surface bare filesystem ENOENT as the primary signal")

const missingInputSummaryPath = join(missingInputOutput.artifacts.directory, "files", "browser", "visual-compare", "visual-diff.json")
const missingInputReviewPath = join(missingInputOutput.artifacts.directory, "files", "review.json")
const missingInputSourcePath = join(missingInputOutput.artifacts.directory, "files", "browser", "visual-compare", "source.png")
assert.equal(existsSync(missingInputSummaryPath), true, "missing input visual summary should be captured")
assert.equal(existsSync(missingInputSourcePath), true, "available source screenshot should be preserved")

const missingInputSummary = JSON.parse(await readFile(missingInputSummaryPath, "utf8")) as {
  schema: string
  status: string
  partial: boolean
  stage: string
  files: { sourceScreenshot?: string | string[]; candidateScreenshot?: string | string[]; visualDiff?: string }
  diagnostic?: { type: string; message: string; missingInputs?: Array<{ role: string; path: string }> }
}
assert.equal(missingInputSummary.schema, "wp-codebox/visual-compare/v1")
assert.equal(missingInputSummary.status, "missing")
assert.equal(missingInputSummary.partial, true)
assert.equal(missingInputSummary.stage, "missing-input")
assert.equal(missingInputSummary.files.sourceScreenshot, "files/browser/visual-compare/source.png")
assert.deepEqual(missingInputSummary.files.candidateScreenshot, [])
assert.equal(missingInputSummary.diagnostic?.type, "missing-input")
assert.deepEqual(missingInputSummary.diagnostic?.missingInputs?.map((input) => input.role), ["candidateScreenshot"])

const missingInputReview = JSON.parse(await readFile(missingInputReviewPath, "utf8")) as { browser?: { probes?: Array<{ visualCompare?: { status?: string; explanation?: string } }> } }
assert.equal(missingInputReview.browser?.probes?.[0]?.visualCompare?.status, "missing", "review summary should expose missing visual compare status")
assert.equal(missingInputReview.browser?.probes?.[0]?.visualCompare?.explanation, "files/browser/visual-compare/visual-diff.json", "review summary should point to missing-input visual summary")

console.log("Browser visual compare smoke passed")

async function runCli(args: string[]): Promise<{ success?: boolean; artifacts?: { directory?: string }; error?: { message?: string } }> {
  const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const code = await new Promise<number | null>((resolveCode) => child.on("close", resolveCode))
  if (code !== 0) {
    throw new Error(`CLI exited with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  return JSON.parse(stdout)
}

async function runCliAllowFailure(args: string[]): Promise<{ success?: boolean; artifacts?: { directory?: string }; error?: { message?: string } }> {
  const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const code = await new Promise<number | null>((resolveCode) => child.on("close", resolveCode))
  if (code === 0) {
    throw new Error(`CLI unexpectedly exited with 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  return JSON.parse(stdout)
}
