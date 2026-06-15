import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-redirect-chain-diagnostics-smoke")
const pluginDir = join(workspace, "redirect-loop-fixture")
const recipePath = join(workspace, "recipe.json")
const actionRecipePath = join(workspace, "action-recipe.json")
const artifactsRoot = join(workspace, "artifacts")
const actionArtifactsRoot = join(workspace, "action-artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "redirect-loop-fixture.php"), `<?php
/**
 * Plugin Name: Browser Redirect Loop Diagnostics Fixture
 */

add_action( 'template_redirect', static function (): void {
    if ( isset( $_GET['wp_codebox_redirect_loop'] ) ) {
        wp_safe_redirect( home_url( '/?wp_codebox_redirect_loop=1&token=super-secret-token&safe=visible' ), 302 );
        exit;
    }
} );
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extra_plugins: [
      {
        source: "./redirect-loop-fixture",
        plugin_file: "redirect-loop-fixture/redirect-loop-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-probe",
        args: ["url=/?wp_codebox_redirect_loop=1&token=super-secret-token&safe=visible", "capture=network,errors,html"],
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
        source: "./redirect-loop-fixture",
        plugin_file: "redirect-loop-fixture/redirect-loop-fixture.php",
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
          `steps-json=${JSON.stringify([{ kind: "navigate", url: "/?wp_codebox_redirect_loop=1&token=super-secret-token&safe=visible" }])}`,
          "capture=steps,network,errors,html",
        ],
      },
    ],
  },
  artifacts: {
    directory: actionArtifactsRoot,
  },
}, null, 2)}\n`)

const run = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  recipePath,
  "--json",
])

assert.notEqual(run.exitCode, 0, "redirect-loop recipe should fail navigation")
assert.equal(run.output.success, false, "recipe-run should report navigation failure")
assert.match(run.output.error?.message ?? "", /ERR_TOO_MANY_REDIRECTS|redirect/i)
assert.ok(run.output.artifacts?.directory, "failed recipe-run should return an artifact directory")

const artifactDirectory = run.output.artifacts.directory
const diagnosticsPath = join(artifactDirectory, "files", "browser", "redirect-diagnostics.json")
const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
const reviewPath = join(artifactDirectory, "files", "review.json")
const manifestPath = join(artifactDirectory, "manifest.json")

assert.equal(existsSync(diagnosticsPath), true, "redirect-diagnostics.json should be captured for document redirect loops")

const diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8")) as {
  schema: string
  status: string
  classification: string
  reason: string
  chain: Array<{ url: string; status?: number; host?: string; path?: string; queryKeys: string[]; redactedQueryKeys: string[] }>
  summary: {
    artifact?: string
    classification: string
    documentEvents: number
    redirectResponses: number
    repeatedUrls: Array<{ url: string; count: number }>
    repeatedHosts: Array<{ host: string; count: number }>
    repeatedPaths: Array<{ path: string; count: number }>
    firstUrl?: string
    lastUrl?: string
    finalAttemptedUrl?: string
    sanitizedQueryKeys: string[]
    redactedQueryKeys: string[]
  }
}

assert.equal(diagnostics.schema, "wp-codebox/browser-redirect-diagnostics/v1")
assert.equal(diagnostics.status, "captured")
assert.equal(diagnostics.classification, "redirect-loop")
assert.match(diagnostics.reason, /ERR_TOO_MANY_REDIRECTS|repeated/i)
assert.ok(diagnostics.chain.length >= 2, "diagnostic chain should include repeated document navigation events")
assert.ok(diagnostics.summary.redirectResponses >= 1, "summary should count document redirect responses")
assert.ok(diagnostics.summary.repeatedUrls.some((entry) => entry.count >= 2), "summary should report repeated sanitized URLs")
assert.ok(diagnostics.summary.repeatedHosts.some((entry) => entry.count >= 2), "summary should report repeated hosts")
assert.ok(diagnostics.summary.repeatedPaths.some((entry) => entry.path === "/" && entry.count >= 2), "summary should report repeated paths")
assert.equal(diagnostics.summary.artifact, "files/browser/redirect-diagnostics.json")
assert.ok(diagnostics.summary.firstUrl?.includes("token=[redacted]"), "summary should redact query values")
assert.ok(diagnostics.summary.lastUrl?.includes("token=[redacted]"), "summary should redact query values")
assert.ok(diagnostics.summary.finalAttemptedUrl?.includes("token=[redacted]"), "summary should redact final attempted query values")
assert.deepEqual(diagnostics.summary.sanitizedQueryKeys, ["safe", "token", "wp_codebox_redirect_loop"])
assert.deepEqual(diagnostics.summary.redactedQueryKeys, ["token"])
assert.doesNotMatch(JSON.stringify(diagnostics), /super-secret-token/, "diagnostics artifact must not expose sensitive query values")

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  files: { redirectDiagnostics?: string }
  summary: { redirectDiagnostics?: { artifact?: string; classification: string; redirectResponses: number } }
  redirectDiagnostics?: { artifact?: string; classification: string }
}
assert.equal(summary.files.redirectDiagnostics, "files/browser/redirect-diagnostics.json")
assert.equal(summary.redirectDiagnostics?.artifact, "files/browser/redirect-diagnostics.json")
assert.equal(summary.redirectDiagnostics?.classification, "redirect-loop")
assert.equal(summary.summary.redirectDiagnostics?.artifact, "files/browser/redirect-diagnostics.json")
assert.equal(summary.summary.redirectDiagnostics?.classification, "redirect-loop")
assert.ok(summary.summary.redirectDiagnostics?.redirectResponses ?? 0 >= 1)

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ redirectDiagnostics?: { artifact?: string; classification: string } }> } }
assert.equal(review.browser?.probes?.[0]?.redirectDiagnostics?.artifact, "files/browser/redirect-diagnostics.json")
assert.equal(review.browser?.probes?.[0]?.redirectDiagnostics?.classification, "redirect-loop")

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/redirect-diagnostics.json" && file.kind === "browser-redirect-diagnostics"))

const actionRun = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  actionRecipePath,
  "--json",
])

assert.notEqual(actionRun.exitCode, 0, "redirect-loop browser-actions recipe should fail navigation")
assert.equal(actionRun.output.success, false, "browser-actions recipe-run should report navigation failure")
assert.match(actionRun.output.error?.message ?? "", /ERR_TOO_MANY_REDIRECTS|redirect/i)
assert.ok(actionRun.output.artifacts?.directory, "failed browser-actions recipe-run should return an artifact directory")

const actionArtifactDirectory = actionRun.output.artifacts.directory
const actionDiagnosticsPath = join(actionArtifactDirectory, "files", "browser", "redirect-diagnostics.json")
const actionSummaryPath = join(actionArtifactDirectory, "files", "browser", "action-summary.json")
const actionReviewPath = join(actionArtifactDirectory, "files", "review.json")
const actionManifestPath = join(actionArtifactDirectory, "manifest.json")

assert.equal(existsSync(actionDiagnosticsPath), true, "browser-actions should capture redirect-diagnostics.json")
assert.doesNotMatch(await readFile(actionDiagnosticsPath, "utf8"), /super-secret-token/, "browser-actions diagnostics must not expose sensitive query values")

const actionSummary = JSON.parse(await readFile(actionSummaryPath, "utf8")) as {
  files: { redirectDiagnostics?: string }
  redirectDiagnostics?: { artifact?: string; classification: string }
  summary: { redirectDiagnostics?: { artifact?: string; classification: string; redirectResponses: number } }
}
assert.equal(actionSummary.files.redirectDiagnostics, "files/browser/redirect-diagnostics.json")
assert.equal(actionSummary.redirectDiagnostics?.artifact, "files/browser/redirect-diagnostics.json")
assert.equal(actionSummary.redirectDiagnostics?.classification, "redirect-loop")
assert.equal(actionSummary.summary.redirectDiagnostics?.artifact, "files/browser/redirect-diagnostics.json")
assert.equal(actionSummary.summary.redirectDiagnostics?.classification, "redirect-loop")
assert.ok(actionSummary.summary.redirectDiagnostics?.redirectResponses ?? 0 >= 1)

const actionReview = JSON.parse(await readFile(actionReviewPath, "utf8")) as { browser?: { probes?: Array<{ redirectDiagnostics?: { artifact?: string; classification: string } }> } }
assert.equal(actionReview.browser?.probes?.[0]?.redirectDiagnostics?.artifact, "files/browser/redirect-diagnostics.json")
assert.equal(actionReview.browser?.probes?.[0]?.redirectDiagnostics?.classification, "redirect-loop")

const actionManifest = JSON.parse(await readFile(actionManifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(actionManifest.files.some((file) => file.path === "files/browser/redirect-diagnostics.json" && file.kind === "browser-redirect-diagnostics"))

console.log(`Browser redirect-chain diagnostics smoke passed: probe=${artifactDirectory} actions=${actionArtifactDirectory}`)

async function runCli(args: string[]): Promise<{ exitCode: number | null; output: any; stdout: string; stderr: string }> {
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
  assert.ok(stdout.trim().length > 0, `CLI should emit JSON to stdout\nSTDERR:\n${stderr}`)
  return { exitCode, output: JSON.parse(stdout), stdout, stderr }
}
