import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-wordpress-500-diagnostics-smoke")
const pluginDir = join(workspace, "fatal-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "fatal-fixture.php"), `<?php
/**
 * Plugin Name: Browser WordPress 500 Diagnostics Fixture
 */

add_action( 'init', static function (): void {
    if ( isset( $_GET['wp_codebox_browser_fatal'] ) ) {
        status_header( 500 );
        wp_codebox_missing_browser_diagnostics_fixture_function();
    }
} );
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extra_plugins: [
      {
        source: "./fatal-fixture",
        plugin_file: "fatal-fixture/fatal-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.capture-html",
        args: ["url=/?wp_codebox_browser_fatal=1"],
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
], 0)

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

const artifactDirectory = output.artifacts.directory
const diagnosticsPath = join(artifactDirectory, "files", "browser", "wordpress-diagnostics.json")
const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
const reviewPath = join(artifactDirectory, "files", "review.json")
const manifestPath = join(artifactDirectory, "manifest.json")

assert.equal(existsSync(diagnosticsPath), true, "wordpress-diagnostics.json should be captured for document 5xx")

const diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8")) as {
  schema: string
  status: string
  document5xxResponses: Array<{ status: number }>
  diagnostics: Array<{ classification: string; message: string; file: string; line: number }>
  summary: { artifact?: string; document5xxResponses: number; diagnostics: number; fatalErrors: number; classifications: string[] }
}
assert.equal(diagnostics.schema, "wp-codebox/browser-wordpress-diagnostics/v1")
assert.equal(diagnostics.status, "captured")
assert.equal(diagnostics.document5xxResponses[0]?.status, 500)
assert.equal(diagnostics.summary.artifact, "files/browser/wordpress-diagnostics.json")
assert.equal(diagnostics.summary.document5xxResponses, 1)
assert.equal(diagnostics.summary.diagnostics, 1)
assert.equal(diagnostics.summary.fatalErrors, 1)
assert.deepEqual(diagnostics.summary.classifications, ["php-fatal"])
assert.equal(diagnostics.diagnostics[0]?.classification, "php-fatal")
assert.match(diagnostics.diagnostics[0]?.message ?? "", /wp_codebox_missing_browser_diagnostics_fixture_function/)
assert.match(diagnostics.diagnostics[0]?.file ?? "", /fatal-fixture\.php$/)
assert.ok((diagnostics.diagnostics[0]?.line ?? 0) > 0, "diagnostic should include a line number")

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  files: { wordpressDiagnostics?: string }
  summary: { wordpressDiagnostics?: { artifact?: string; document5xxResponses: number; fatalErrors: number; classifications: string[] } }
  wordpressDiagnostics?: { artifact?: string; document5xxResponses: number; fatalErrors: number; classifications: string[] }
}
assert.equal(summary.files.wordpressDiagnostics, "files/browser/wordpress-diagnostics.json")
assert.equal(summary.summary.wordpressDiagnostics?.artifact, "files/browser/wordpress-diagnostics.json")
assert.equal(summary.summary.wordpressDiagnostics?.document5xxResponses, 1)
assert.equal(summary.summary.wordpressDiagnostics?.fatalErrors, 1)
assert.deepEqual(summary.summary.wordpressDiagnostics?.classifications, ["php-fatal"])

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ wordpressDiagnostics?: { artifact?: string; fatalErrors: number } }> } }
assert.equal(review.browser?.probes?.[0]?.wordpressDiagnostics?.artifact, "files/browser/wordpress-diagnostics.json")
assert.equal(review.browser?.probes?.[0]?.wordpressDiagnostics?.fatalErrors, 1)

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/wordpress-diagnostics.json" && file.kind === "browser-wordpress-diagnostics"))

console.log(`Browser WordPress 500 diagnostics smoke passed: ${artifactDirectory}`)

async function runCli(args: string[], expectedExitCode: number): Promise<any> {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)))
  assert.equal(exitCode, expectedExitCode, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  return JSON.parse(stdout)
}
