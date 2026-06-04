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
    echo '<style>.wp-codebox-hidden-fixture{display:none}</style>';
    echo '<div id="probe-target" data-state="ready">Probe Target Ready</div>';
    echo '<div id="probe-hidden" class="wp-codebox-hidden-fixture">Hidden Fixture</div>';
    echo '<ul id="probe-list"><li>One</li><li>Two</li></ul>';
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
  "assert=no-console-errors",
  "assert=no-page-errors",
  "assert=no-errors",
])

assert.equal(passing.success, true, passing.error?.message ?? "passing assertions should succeed")
const passingSummary = await readSummary(passing)
assert.equal(passingSummary.assertions.total, 10)
assert.equal(passingSummary.assertions.failed, 0)
assert.equal(passingSummary.summary.assertions.total, 10)
assert.equal(passingSummary.summary.assertions.failed, 0)
assert.equal(commandOutput(passing).summary.assertions.total, 10, "command JSON should include assertion totals")

const advisory = await runRecipe("advisory", [
  "url=/",
  "wait-for=load",
  "capture=html",
  "assert=exists:#probe-target",
  "assert=advisory:exists:#probe-missing",
])

assert.equal(advisory.success, true, advisory.error?.message ?? "advisory assertion failures should not fail")
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
  "assert=exists:#probe-missing",
])

assert.equal(failing.success, false, "fatal assertion failure should fail recipe-run")
const failingSummary = await readSummary(failing)
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
  const artifactDirectory = output.artifacts?.directory
  assert.equal(typeof artifactDirectory, "string", "recipe-run should return artifact directory")
  const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
  assert.equal(existsSync(summaryPath), true, "summary.json should be captured")
  return JSON.parse(await readFile(summaryPath, "utf8"))
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
  return output
}
