import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-wordpress-500-diagnostics-smoke")
const pluginDir = join(workspace, "fatal-fixture")
const recipePath = join(workspace, "recipe.json")
const actionRecipePath = join(workspace, "action-recipe.json")
const artifactsRoot = join(workspace, "artifacts")
const actionArtifactsRoot = join(workspace, "action-artifacts")

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

add_action( 'template_redirect', static function (): void {
    if ( isset( $_GET['wp_codebox_browser_status'] ) ) {
        status_header( 500 );
        header( 'Content-Type: text/html; charset=utf-8' );
        echo '<!doctype html><title>Fixture 500</title><main>status body https://example.test/callback?token=super-secret-token&safe=visible password=super-secret-password</main>';
        exit;
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
        args: ["url=/?wp_codebox_browser_fatal=1&token=super-secret-token"],
      },
    ],
  },
  artifacts: {
    directory: artifactsRoot,
  },
}, null, 2)}\n`)

await writeFile(actionRecipePath, `${JSON.stringify({
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
        command: "wordpress.browser-actions",
        args: [
          "url=/",
          `steps-json=${JSON.stringify([{ kind: "navigate", url: "/?wp_codebox_browser_status=1&token=super-secret-token&safe=visible" }])}`,
          "capture=steps,network,html",
        ],
      },
    ],
  },
  artifacts: {
    directory: actionArtifactsRoot,
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
  document5xxResponses: Array<{ url: string; status: number; responseTextPreview?: string; responseTextSha256?: string; responseTextTruncated?: boolean }>
  diagnostics: Array<{ classification: string; message: string; file?: string; line?: number; status?: number; requestUri?: string }>
  summary: { artifact?: string; document5xxResponses: number; diagnostics: number; fatalErrors: number; classifications: string[] }
}
assert.equal(diagnostics.schema, "wp-codebox/browser-wordpress-diagnostics/v1")
assert.equal(diagnostics.status, "captured")
assert.equal(diagnostics.document5xxResponses[0]?.status, 500)
assert.equal(diagnostics.document5xxResponses[0]?.url.includes("token=[redacted]"), true)
assert.equal(typeof diagnostics.document5xxResponses[0]?.responseTextSha256, "string")
assert.equal(diagnostics.document5xxResponses[0]?.responseTextTruncated, false)
assert.equal(diagnostics.summary.artifact, "files/browser/wordpress-diagnostics.json")
assert.equal(diagnostics.summary.document5xxResponses, 1)
assert.equal(diagnostics.summary.diagnostics, 2)
assert.equal(diagnostics.summary.fatalErrors, 1)
assert.deepEqual(diagnostics.summary.classifications, ["http-5xx-status", "php-fatal"])
const fatalDiagnostic = diagnostics.diagnostics.find((diagnostic) => diagnostic.classification === "php-fatal")
const statusDiagnostic = diagnostics.diagnostics.find((diagnostic) => diagnostic.classification === "http-5xx-status")
assert.match(fatalDiagnostic?.message ?? "", /wp_codebox_missing_browser_diagnostics_fixture_function/)
assert.match(fatalDiagnostic?.file ?? "", /fatal-fixture\.php$/)
assert.ok((fatalDiagnostic?.line ?? 0) > 0, "fatal diagnostic should include a line number")
assert.equal(statusDiagnostic?.status, 500)
assert.equal(statusDiagnostic?.requestUri?.includes("token=[redacted]"), true)
assert.doesNotMatch(JSON.stringify(diagnostics), /super-secret-token|super-secret-password/, "diagnostics artifact must not expose fixture secrets")

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  files: { wordpressDiagnostics?: string }
  summary: { wordpressDiagnostics?: { artifact?: string; document5xxResponses: number; fatalErrors: number; classifications: string[] } }
  wordpressDiagnostics?: { artifact?: string; document5xxResponses: number; fatalErrors: number; classifications: string[] }
}
assert.equal(summary.files.wordpressDiagnostics, "files/browser/wordpress-diagnostics.json")
assert.equal(summary.summary.wordpressDiagnostics?.artifact, "files/browser/wordpress-diagnostics.json")
assert.equal(summary.summary.wordpressDiagnostics?.document5xxResponses, 1)
assert.equal(summary.summary.wordpressDiagnostics?.fatalErrors, 1)
assert.deepEqual(summary.summary.wordpressDiagnostics?.classifications, ["http-5xx-status", "php-fatal"])

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ wordpressDiagnostics?: { artifact?: string; fatalErrors: number } }> } }
assert.equal(review.browser?.probes?.[0]?.wordpressDiagnostics?.artifact, "files/browser/wordpress-diagnostics.json")
assert.equal(review.browser?.probes?.[0]?.wordpressDiagnostics?.fatalErrors, 1)

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/wordpress-diagnostics.json" && file.kind === "browser-wordpress-diagnostics"))

const actionOutput = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  actionRecipePath,
  "--json",
], 0)

assert.equal(actionOutput.success, true, actionOutput.error?.message ?? "browser-actions recipe-run failed")
assert.ok(actionOutput.artifacts?.directory, "browser-actions recipe-run should return an artifact directory")

const actionArtifactDirectory = actionOutput.artifacts.directory
const actionDiagnosticsPath = join(actionArtifactDirectory, "files", "browser", "wordpress-diagnostics.json")
const actionSummaryPath = join(actionArtifactDirectory, "files", "browser", "action-summary.json")

assert.equal(existsSync(actionDiagnosticsPath), true, "browser-actions should capture wordpress-diagnostics.json for document 5xx")
const actionDiagnostics = JSON.parse(await readFile(actionDiagnosticsPath, "utf8")) as typeof diagnostics
assert.equal(actionDiagnostics.status, "captured")
assert.equal(actionDiagnostics.document5xxResponses[0]?.status, 500)
assert.equal(actionDiagnostics.document5xxResponses[0]?.url.includes("token=[redacted]"), true)
assert.match(actionDiagnostics.document5xxResponses[0]?.responseTextPreview ?? "", /status body/)
assert.match(actionDiagnostics.document5xxResponses[0]?.responseTextPreview ?? "", /token=\[redacted\]/)
assert.match(actionDiagnostics.document5xxResponses[0]?.responseTextPreview ?? "", /password=\[redacted\]/)
assert.equal(typeof actionDiagnostics.document5xxResponses[0]?.responseTextSha256, "string")
assert.equal(actionDiagnostics.summary.document5xxResponses, 1)
assert.equal(actionDiagnostics.summary.fatalErrors, 0)
assert.deepEqual(actionDiagnostics.summary.classifications, ["http-5xx-status", "http-response-code-5xx"])
assert.equal(actionDiagnostics.diagnostics.some((diagnostic) => diagnostic.classification === "http-5xx-status" && diagnostic.status === 500), true)
assert.equal(actionDiagnostics.diagnostics.some((diagnostic) => diagnostic.classification === "http-response-code-5xx" && diagnostic.status === 500), true)
assert.doesNotMatch(JSON.stringify(actionDiagnostics), /super-secret-token|super-secret-password/, "browser-actions diagnostics must not expose fixture secrets")

const actionSummary = JSON.parse(await readFile(actionSummaryPath, "utf8")) as {
  files: { wordpressDiagnostics?: string }
  summary: { wordpressDiagnostics?: { artifact?: string; document5xxResponses: number; fatalErrors: number; classifications: string[] } }
}
assert.equal(actionSummary.files.wordpressDiagnostics, "files/browser/wordpress-diagnostics.json")
assert.equal(actionSummary.summary.wordpressDiagnostics?.document5xxResponses, 1)
assert.deepEqual(actionSummary.summary.wordpressDiagnostics?.classifications, ["http-5xx-status", "http-response-code-5xx"])

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
