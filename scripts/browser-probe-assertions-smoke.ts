import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-probe-assertions-smoke")
const pluginDir = join(workspace, "browser-assertion-fixture")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "browser-assertion-fixture.php"), `<?php
/**
 * Plugin Name: Browser Assertion Fixture
 */
add_action('wp_footer', function () {
    $large_text = str_repeat('Large Frame Body ', 700);
    $frame_srcdoc = esc_attr('<!doctype html><html><body><div id="frame-target" data-frame-state="ready">Frame Target Ready</div><div id="large-frame-body">' . $large_text . 'Needle Text</div><ul id="frame-list"><li>Alpha</li><li>Beta</li></ul></body></html>');
    echo '<style>.wp-codebox-hidden-fixture{display:none}</style>';
    echo '<div id="probe-target" data-state="ready">Probe Target Ready</div>';
    echo '<div id="probe-hidden" class="wp-codebox-hidden-fixture">Hidden Fixture</div>';
    echo '<ul id="probe-list"><li>One</li><li>Two</li></ul>';
    echo '<iframe id="probe-frame" title="Probe Frame" srcdoc="' . $frame_srcdoc . '"></iframe>';
});
`)

const passing = await runRecipe("passing", [
  "url=/",
  "wait-for=load",
  "capture=html",
  "assert=exists:#probe-target",
  "assert=not-exists:#probe-missing",
  "assert=visible:#probe-target",
  "assert=hidden:#probe-hidden",
  "assert=count:#probe-list li>=2",
  "assert=text:#probe-target contains Target Ready",
  "assert=attr:#probe-target[data-state]=ready",
  "assert=frame:#probe-frame|exists:#frame-target",
  "assert=frame:#probe-frame|text:#frame-target contains Frame Target Ready",
  "assert=frame-url:about:srcdoc|text:#large-frame-body contains Needle Text",
  "assert=frame:#probe-frame|count:#frame-list li=2",
  "assert=frame:#probe-frame|attr:#frame-target[data-frame-state]=ready",
  "assert=no-console-errors",
  "assert=no-page-errors",
  "assert=no-errors",
  "assert=request-count-by-type:document>=1",
  "assert=total-transfer-size>=0",
  "assert=metric:browser_resource_count>=0",
])

assert.equal(passing.success, true, passing.error?.message ?? "passing assertions should succeed")
const passingSummary = await readSummary(passing)
const passingCheckpoints = await readCheckpointNames(passing)
assert.equal(passingSummary.assertions.total, 18)
assert.equal(passingSummary.assertions.failed, 0)
assert.equal(passingSummary.summary.assertions.total, 18)
assert.equal(passingSummary.summary.assertions.failed, 0)
assert.equal(passingCheckpoints.includes("after-assertions"), true, "browser-probe should capture a deterministic checkpoint after assertions complete")
const passingFrameAssertion = passingSummary.assertions.results.find((result: { assertion?: string }) => result.assertion === "frame:#probe-frame|exists:#frame-target")
assert.equal(passingFrameAssertion.status, "pass")
assert.equal(passingFrameAssertion.frameSelector, "#probe-frame")
assert.equal(typeof passingFrameAssertion.frameUrl, "string")
assert.deepEqual(passingFrameAssertion.frameTarget, { kind: "selector", value: "#probe-frame", status: "resolved", url: passingFrameAssertion.frameUrl })
const passingFrameUrlAssertion = passingSummary.assertions.results.find((result: { assertion?: string }) => result.assertion === "frame-url:about:srcdoc|text:#large-frame-body contains Needle Text")
assert.equal(passingFrameUrlAssertion.status, "pass")
assert.equal(passingFrameUrlAssertion.frameTarget.kind, "url")
assert.equal(passingFrameUrlAssertion.frameTarget.value, "about:srcdoc")
assert.equal(typeof passingFrameUrlAssertion.frameUrl, "string")
assert.equal(passingFrameUrlAssertion.observed.type, "string")
assert.equal(passingFrameUrlAssertion.observed.truncated, true)
assert.equal(passingFrameUrlAssertion.observed.preview.length <= 512, true)
assert.equal(commandOutput(passing).summary.assertions.results.find((result: { assertion?: string }) => result.assertion === passingFrameUrlAssertion.assertion).observed.truncated, true, "command stdout should include compact frame assertion evidence")
const passingRequestBudget = passingSummary.assertions.results.find((result: { assertion?: string }) => result.assertion === "request-count-by-type:document>=1")
assert.equal(passingRequestBudget.status, "pass")
assert.equal(passingRequestBudget.expectedBudget, 1)
assert.equal(typeof passingRequestBudget.observed, "number")
assert.deepEqual(passingRequestBudget.supportingArtifacts, ["files/browser/network.jsonl"])
const passingMetricBudget = passingSummary.assertions.results.find((result: { assertion?: string }) => result.assertion === "metric:browser_resource_count>=0")
assert.equal(passingMetricBudget.status, "pass")
assert.equal(passingMetricBudget.expectedBudget, 0)
assert.equal(typeof passingMetricBudget.observed, "number")
assert.deepEqual(passingMetricBudget.supportingArtifacts, ["files/browser/performance.json", "files/browser/memory.json"])
assert.equal(commandOutput(passing).summary.assertions.total, 18, "command JSON should include assertion totals")
assert.equal(commandOutput(passing).summary.assertions.results.map((result: unknown) => JSON.stringify(result)).join("\n").includes("Large Frame Body ".repeat(100)), false, "command stdout should not include unbounded large frame text")

const advisory = await runRecipe("advisory", [
  "url=/",
  "wait-for=load",
  "capture=html",
  "assert=exists:#probe-target",
  "assert=advisory:exists:#probe-missing",
])

assert.equal(advisory.success, true, advisory.error?.message ?? "advisory assertion failures should not fail")
assert.equal(advisory.__exitCode, 0, "advisory assertion failures should keep command exit zero")
const advisorySummary = await readSummary(advisory)
assert.equal(advisorySummary.assertions.total, 2)
assert.equal(advisorySummary.assertions.failed, 1)
assert.equal(advisorySummary.assertions.advisoryFailed, 1)
assert.equal(advisorySummary.assertions.fatalFailed, 0)

const failing = await runRecipe("failing", [
  "url=/",
  "wait-for=load",
  "capture=html",
  "assert=exists:#probe-target",
  "assert=request-count-by-type:document<0",
])

assert.equal(failing.success, false, "fatal assertion failure should fail recipe-run")
assert.notEqual(failing.__exitCode, 0, "fatal assertion failures should make command execution fail")
const failingSummary = await readSummary(failing)
const failingBudget = failingSummary.assertions.results.find((result: { assertion?: string }) => result.assertion === "request-count-by-type:document<0")
assert.equal(failingBudget.status, "fail")
assert.equal(typeof failingBudget.observed, "number")
assert.equal(failingBudget.expectedBudget, 0)
assert.equal(failingSummary.assertions.total, 2)
assert.equal(failingSummary.assertions.failed, 1)
assert.equal(failingSummary.assertions.fatalFailed, 1)
assert.equal(failingSummary.summary.assertions.fatalFailed, 1)
assert.match(failing.error?.message ?? "", /assertion failed|browser-probe failed/)

console.log("Browser probe assertion smoke passed")

async function runRecipe(name: string, args: string[]): Promise<any> {
  const recipePath = join(workspace, `${name}.recipe.json`)
  const artifactsRoot = join(workspace, `${name}-artifacts`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      extraPlugins: [
        {
          source: "./browser-assertion-fixture",
          pluginFile: "browser-assertion-fixture/browser-assertion-fixture.php",
          activate: true,
        },
      ],
    },
    workflow: {
      steps: [
        {
          command: "wordpress.browser-probe",
          args,
        },
      ],
    },
    artifacts: {
      directory: artifactsRoot,
    },
  }, null, 2)}\n`)

  return runCli([
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--json",
  ])
}

async function readSummary(output: any): Promise<any> {
  const artifactDirectory = artifactDirectoryFromOutput(output)
  const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
  assert.equal(existsSync(summaryPath), true, "summary.json should be captured")
  return JSON.parse(await readFile(summaryPath, "utf8"))
}

async function readCheckpointNames(output: any): Promise<string[]> {
  const artifactDirectory = artifactDirectoryFromOutput(output)
  const checkpointPath = join(artifactDirectory, "files", "browser", "checkpoints.jsonl")
  assert.equal(existsSync(checkpointPath), true, "checkpoints.jsonl should be captured")
  return (await readFile(checkpointPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).name)
}

function artifactDirectoryFromOutput(output: any): string {
  const artifactDirectory = output.artifacts?.directory ?? output.run?.artifactRefs?.find((ref: { kind?: string }) => ref.kind === "artifact-bundle")?.directory
  assert.equal(typeof artifactDirectory, "string", "recipe-run should return artifact bundle directory")
  return artifactDirectory
}

function commandOutput(output: any): any {
  const execution = output.executions?.find((item: { command?: string }) => item.command === "wordpress.browser-probe")
  assert.equal(typeof execution?.stdout, "string", "recipe-run should include browser-probe command stdout")
  return JSON.parse(execution.stdout)
}

async function runCli(args: string[]): Promise<any> {
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
  assert.ok(stdout.trim().length > 0, `CLI should emit JSON. Exit ${exitCode}\nSTDERR:\n${stderr}`)
  const output = JSON.parse(stdout)
  if (output.success !== false) {
    assert.equal(exitCode, 0, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  return { ...output, __exitCode: exitCode }
}
