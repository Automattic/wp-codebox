import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-visual-compare-matrix-smoke")
const pluginDir = join(workspace, "visual-compare-matrix-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "visual-compare-matrix-fixture.php"), `<?php
/**
 * Plugin Name: Visual Compare Matrix Fixture
 */
add_action( 'template_redirect', function () {
    if ( ! isset( $_GET['wp_codebox_visual_compare_matrix_fixture'] ) ) {
        return;
    }

    $page    = isset( $_GET['page'] ) ? sanitize_key( $_GET['page'] ) : 'one';
    $variant = isset( $_GET['variant'] ) ? sanitize_key( $_GET['variant'] ) : 'source';
    $color   = 'candidate' === $variant ? '#2563eb' : '#dc2626';
    nocache_headers();
    echo '<!doctype html><html><head><style>body{margin:0}.card{width:220px;height:120px;background:' . esc_attr( $color ) . ';color:white;font:24px sans-serif;display:grid;place-items:center}</style></head><body><main class="card">' . esc_html( $page . '-' . $variant ) . '</main></body></html>';
    exit;
} );
`)

const matrix = {
  comparisons: [
    {
      name: "first",
      sourceUrl: "/?wp_codebox_visual_compare_matrix_fixture=1&page=one&variant=source",
      candidateUrl: "/?wp_codebox_visual_compare_matrix_fixture=1&page=one&variant=candidate",
      sourceLabel: "first-source",
      candidateLabel: "first-candidate",
    },
    {
      name: "second",
      sourceUrl: "/?wp_codebox_visual_compare_matrix_fixture=1&page=two&variant=source",
      candidateUrl: "/?wp_codebox_visual_compare_matrix_fixture=1&page=two&variant=candidate",
      sourceLabel: "second-source",
      candidateLabel: "second-candidate",
    },
  ],
  viewports: [
    { name: "small", viewport: "320x240" },
    { name: "wide", viewport: "480x240" },
  ],
}

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extra_plugins: [
      {
        source: "./visual-compare-matrix-fixture",
        plugin_file: "visual-compare-matrix-fixture/visual-compare-matrix-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.visual-compare",
        args: [
          `matrix-json=${JSON.stringify(matrix)}`,
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
const matrixSummaryPath = join(artifactDirectory, "files", "browser", "visual-compare", "matrix-summary.json")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(matrixSummaryPath), true, "matrix summary should be captured")

const summary = JSON.parse(await readFile(matrixSummaryPath, "utf8")) as {
  schema: string
  status: string
  metrics: { comparisons: number; different: number; maxMismatchPixels: number; meanMismatchRatio: number }
  comparisons: Array<{ name: string; status: string; files: Record<string, string>; comparison: { mismatchPixels: number } }>
}
assert.equal(summary.schema, "wp-codebox/visual-compare-matrix/v1")
assert.equal(summary.status, "different")
assert.equal(summary.metrics.comparisons, 4)
assert.equal(summary.metrics.different, 4)
assert.ok(summary.metrics.maxMismatchPixels > 0, "aggregate should expose max mismatch pixels")
assert.ok(summary.metrics.meanMismatchRatio > 0, "aggregate should expose mean mismatch ratio")
assert.deepEqual(summary.comparisons.map((comparison) => comparison.name), ["first-small", "first-wide", "second-small", "second-wide"])

for (const comparison of summary.comparisons) {
  assert.equal(comparison.status, "different")
  assert.ok(comparison.comparison.mismatchPixels > 0, "per-comparison mismatch pixels should be preserved")
  assert.equal(existsSync(join(artifactDirectory, comparison.files.sourceScreenshot)), true, `${comparison.name} source screenshot should exist`)
  assert.equal(existsSync(join(artifactDirectory, comparison.files.candidateScreenshot)), true, `${comparison.name} candidate screenshot should exist`)
  assert.equal(existsSync(join(artifactDirectory, comparison.files.diffScreenshot)), true, `${comparison.name} diff screenshot should exist`)
  assert.equal(existsSync(join(artifactDirectory, comparison.files.visualDiff)), true, `${comparison.name} visual diff should exist`)
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/matrix-summary.json" && file.kind === "browser-summary"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/first-small/source.png" && file.kind === "browser-visual-source-screenshot"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/visual-compare/second-wide/diff.png" && file.kind === "browser-visual-diff-screenshot"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ visualCompare?: { status?: string; mismatchPixels?: number; explanation?: string } }> } }
assert.equal(review.browser?.probes?.[0]?.visualCompare?.status, "different", "review summary should expose matrix visual compare status")
assert.ok((review.browser?.probes?.[0]?.visualCompare?.mismatchPixels ?? 0) > 0, "review summary should expose matrix max mismatch count")
assert.equal(review.browser?.probes?.[0]?.visualCompare?.explanation, "files/browser/visual-compare/matrix-summary.json", "review summary should expose aggregate artifact")

console.log("Browser visual compare matrix smoke passed")

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
