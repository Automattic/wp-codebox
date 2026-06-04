import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-browser-probe-liveness-"))

try {
  const terminal = await runRecipe("terminal", [
    "url=/",
    "fail-fast=true",
    "script=__wpCodeboxProbeFail('terminal smoke failure', { reason: 'smoke' });",
  ], 30_000)
  assert.equal(terminal.exit.code, 1, `terminal failure should fail recipe-run; stdout: ${terminal.stdout}; stderr: ${terminal.stderr}`)
  assert.ok(terminal.elapsedMs < 20_000, `terminal failure should fail before the recipe timeout; elapsed=${terminal.elapsedMs}`)
  assert.match(terminal.output.error?.message ?? "", /terminal smoke failure/)
  assert.equal(terminal.summary.summary.progress.status, "failed")
  assert.equal(terminal.summary.summary.progress.terminalFailure.message, "terminal smoke failure")

  const stall = await runRecipe("stall", [
    "url=/",
    "wait-for=duration",
    "duration=5s",
    "stall-timeout=1s",
  ], 30_000)
  assert.equal(stall.exit.code, 1, `idle stall should fail recipe-run; stdout: ${stall.stdout}; stderr: ${stall.stderr}`)
  assert.ok(stall.elapsedMs < 20_000, `idle stall should fail before the recipe timeout; elapsed=${stall.elapsedMs}`)
  assert.match(stall.output.error?.message ?? "", /stalled/i)
  assert.equal(stall.summary.summary.progress.status, "stalled")
  assert.equal(stall.summary.summary.progress.stallTimeoutMs, 1000)

  console.log("Recipe browser probe liveness smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function runRecipe(name: string, args: string[], watchdogMs: number): Promise<{
  exit: { code: number | null; signal: NodeJS.Signals | null }
  output: Record<string, any>
  summary: Record<string, any>
  stdout: string
  stderr: string
  elapsedMs: number
}> {
  const artifacts = join(workspace, `${name}-artifacts`)
  const recipePath = join(workspace, `${name}.json`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    workflow: {
      steps: [{ command: "wordpress.browser-probe", args }],
    },
    artifacts: {
      directory: artifacts,
      verify: false,
      workspacePolicy: { strict: false, writableRoots: ["."], gitBacked: false },
    },
  }, null, 2)}\n`)

  const startedAt = Date.now()
  const child = spawn(process.execPath, [
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--artifacts",
    artifacts,
    "--timeout",
    "20s",
    "--json",
  ], {
    cwd: root,
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

  const watchdog = setTimeout(() => {
    child.kill("SIGKILL")
  }, watchdogMs)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }))
  })
  const elapsedMs = Date.now() - startedAt
  clearTimeout(watchdog)
  assert.notEqual(exit.signal, "SIGKILL", `${name} recipe-run hung; stdout: ${stdout}; stderr: ${stderr}`)

  const output = JSON.parse(stdout)
  assert.equal(output.schema, "wp-codebox/recipe-run/v1")
  assert.equal(output.success, false)
  assert.ok(output.artifacts?.directory, `${name} recipe-run should report artifact directory`)

  const summary = JSON.parse(await readFile(join(output.artifacts.directory, "files", "browser", "summary.json"), "utf8"))
  assert.equal(summary.schema, "wp-codebox/browser-probe/v1")
  return { exit, output, summary, stdout, stderr, elapsedMs }
}
