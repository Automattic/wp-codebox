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
  ], 60_000)
  assert.equal(terminal.exit.code, 1, `terminal failure should fail recipe-run; stdout: ${terminal.stdout}; stderr: ${terminal.stderr}`)
  assert.ok(terminal.elapsedMs < 60_000, `terminal failure should fail before the watchdog; elapsed=${terminal.elapsedMs}`)
  assert.match(terminal.output.error?.message ?? "", /terminal smoke failure/)
  assert.equal(terminal.summary.summary.progress.status, "failed")
  assert.equal(terminal.summary.summary.progress.terminalFailure.message, "terminal smoke failure")

  const stall = await runRecipe("stall", [
    "url=/",
    "wait-for=duration",
    "duration=5s",
    "stall-timeout=1s",
  ], 60_000)
  assert.equal(stall.exit.code, 1, `idle stall should fail recipe-run; stdout: ${stall.stdout}; stderr: ${stall.stderr}`)
  assert.ok(stall.elapsedMs < 60_000, `idle stall should fail before the watchdog; elapsed=${stall.elapsedMs}`)
  assert.match(stall.output.error?.message ?? "", /stalled/i)
  assert.equal(stall.summary.summary.progress.status, "stalled")
  assert.equal(stall.summary.summary.progress.stallTimeoutMs, 1000)

  const scriptTimeout = await runRecipe("script-timeout", [
    "url=/",
    "script=await new Promise(() => undefined);",
    "timeout=3s",
  ], 60_000)
  assert.equal(scriptTimeout.exit.code, 1, `long script should fail recipe-run; stdout: ${scriptTimeout.stdout}; stderr: ${scriptTimeout.stderr}`)
  assert.ok(scriptTimeout.elapsedMs < 60_000, `long script should fail before the watchdog; elapsed=${scriptTimeout.elapsedMs}`)
  assert.match(scriptTimeout.output.error?.message ?? "", /exceeded 3000ms|wall/i)
  const normalizedScriptTimeoutSummary = scriptTimeout.summary.summary ?? scriptTimeout.summary
  assert.equal(scriptTimeout.summary.wallTimeoutMs ?? normalizedScriptTimeoutSummary.liveness?.wallTimeoutMs, 3000)
  assert.equal(normalizedScriptTimeoutSummary.progress.status, "failed")
  await assertReplayableBlueprintAfter(scriptTimeout.output.artifacts?.directory)

  console.log("Recipe browser probe liveness smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function assertReplayableBlueprintAfter(artifactDirectory: string | undefined): Promise<void> {
  assert.ok(artifactDirectory, "browser command timeout should produce artifact directory")
  const manifest = JSON.parse(await readFile(join(artifactDirectory, "manifest.json"), "utf8"))
  const blueprintAfterManifestFile = manifest.files.find((file: { path?: string }) => file.path === "blueprint.after.json")
  assert.equal(blueprintAfterManifestFile?.viewer?.replay?.status, "replayable-runtime-state")
  assert.ok(manifest.files.some((file: { path?: string; kind?: string }) => file.path === "files/blueprint.after.partial.json" && file.kind === "blueprint-after-diagnostic"))
  const blueprintAfter = JSON.parse(await readFile(join(artifactDirectory, "blueprint.after.json"), "utf8"))
  assert.equal(blueprintAfter.steps?.[0]?.step, "runPHP")
  assert.match(blueprintAfter.steps?.[0]?.code ?? "", /wp-codebox\/wordpress-runtime-snapshot\/v1/)
  const blueprintAfterNotes = JSON.parse(await readFile(join(artifactDirectory, "blueprint.after-notes.json"), "utf8"))
  assert.equal(blueprintAfterNotes.replayStatus, "replayable-runtime-state")
  assert.equal(blueprintAfterNotes.source?.diagnosticBlueprint, "files/blueprint.after.partial.json")
  const partialBlueprintAfter = JSON.parse(await readFile(join(artifactDirectory, "files", "blueprint.after.partial.json"), "utf8"))
  assert.ok(Array.isArray(partialBlueprintAfter.steps), "diagnostic partial blueprint should remain readable")
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
    "45s",
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
  const artifactDirectory = output.artifacts?.directory
  const embeddedArtifact = findBrowserArtifact(output, "probe")
  assert.ok(artifactDirectory || embeddedArtifact, `${name} recipe-run should report a browser artifact; stdout: ${stdout}; stderr: ${stderr}`)

  const summary = artifactDirectory
    ? JSON.parse(await readFile(join(artifactDirectory, "files", "browser", "summary.json"), "utf8"))
    : { schema: "wp-codebox/browser-probe/v1", ...embeddedArtifact, ...(embeddedArtifact?.summary ?? {}) }
  assert.equal(summary.schema, "wp-codebox/browser-probe/v1")
  return { exit, output, summary, stdout, stderr, elapsedMs }
}

function findBrowserArtifact(value: unknown, artifactType: string): Record<string, any> | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }
  if ((value as Record<string, unknown>).artifactType === artifactType) {
    return value as Record<string, any>
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findBrowserArtifact(item, artifactType)
        if (found) return found
      }
    } else {
      const found = findBrowserArtifact(child, artifactType)
      if (found) return found
    }
  }
  return undefined
}
