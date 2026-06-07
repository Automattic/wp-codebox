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
    echo '<!doctype html><html><head><style>body{margin:0}.card{width:220px;height:120px;background:' . esc_attr( $color ) . ';color:white;font:24px sans-serif;display:grid;place-items:center}</style></head><body><main class="card">' . esc_html( $variant ) . '</main></body></html>';
    exit;
} );
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
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
