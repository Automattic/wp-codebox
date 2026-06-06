import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-interruption-"))

try {
  const source = join(workspace, "source")
  const artifacts = join(workspace, "artifacts")
  const recipePath = join(workspace, "recipe.json")
  await mkdir(join(source, "src"), { recursive: true })
  await writeFile(join(source, "src", "index.php"), "<?php\n")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    inputs: {
      workspaces: [
        {
          target: "/workspace",
          mode: "readwrite",
          seed: { type: "directory", source },
        },
      ],
    },
    workflow: {
      steps: [
        {
          command: "wordpress.run-php",
          args: ["code=<?php sleep(120); echo 'unreachable';"],
        },
      ],
    },
    artifacts: {
      directory: artifacts,
      verify: true,
      workspacePolicy: { strict: false, writableRoots: ["."], gitBacked: false },
    },
  }, null, 2)}\n`)

  const child = spawn(process.execPath, [
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--artifacts",
    artifacts,
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

  await waitForPointerCommand(artifacts, "workflow.steps[0]:wordpress.run-php", 60_000)
  child.kill("SIGTERM")

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }))
  })

  assert.equal(exit.signal, "SIGTERM", `Interrupted recipe should preserve SIGTERM propagation; stderr: ${stderr}`)
  assert.ok(stdout.trim(), `Interrupted recipe should emit JSON output before propagating SIGTERM; stderr: ${stderr}`)

  const output = JSON.parse(stdout)
  assert.equal(output.schema, "wp-codebox/recipe-run/v1")
  assert.equal(output.success, false)
  assert.equal(output.error?.code, "recipe-interrupted")
  assert.equal(output.interruption?.signal, "SIGTERM")
  assert.equal(output.interruption?.artifactsFinalized, true)
  assert.ok(output.artifacts?.directory, "Interrupted recipe should report artifact directory")

  const latestRuntime = JSON.parse(await readFile(join(artifacts, "latest-runtime.json"), "utf8"))
  const topLevelManifest = JSON.parse(await readFile(join(artifacts, "manifest.json"), "utf8"))
  assert.equal(latestRuntime.schema, "wp-codebox/recipe-run-artifact-pointer/v1")
  assert.equal(topLevelManifest.schema, "wp-codebox/recipe-run-artifact-pointer/v1")
  assert.equal(latestRuntime.runtimeId, output.runtime.id)
  assert.equal(latestRuntime.commandStatus, "failed")
  assert.equal(latestRuntime.failure.code, "recipe-interrupted")
  assert.equal(latestRuntime.paths.runtimeManifest, `${output.runtime.id}/manifest.json`)
  assert.equal(latestRuntime.paths.commandLog, `${output.runtime.id}/logs/commands.log`)
  assert.equal(latestRuntime.paths.runtimeLog, `${output.runtime.id}/logs/runtime.log`)
  assert.equal(latestRuntime.paths.eventLog, `${output.runtime.id}/events.jsonl`)
  assert.equal(latestRuntime.paths.runtimeMetadata, `${output.runtime.id}/metadata.json`)
  assert.equal(latestRuntime.paths.browserArtifacts, `${output.runtime.id}/files/browser`)

  const manifest = JSON.parse(await readFile(join(output.artifacts.directory, "manifest.json"), "utf8"))
  assertManifestFile(manifest, "files/runtime-evidence/run-attestation.json", "run-attestation")
  assertManifestFile(manifest, "files/runtime-evidence/artifact-bundle-verification.json", "artifact-bundle-verification")
  assertManifestFile(manifest, "files/runtime-evidence/workspace-policy.json", "workspace-policy-result")

  const disconnectSource = join(workspace, "disconnect-source")
  const disconnectArtifacts = join(workspace, "disconnect-artifacts")
  const disconnectRecipePath = join(workspace, "disconnect-recipe.json")
  await mkdir(join(disconnectSource, "src"), { recursive: true })
  await writeFile(join(disconnectSource, "src", "index.php"), "<?php\n")
  await writeFile(disconnectRecipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    inputs: {
      workspaces: [
        {
          target: "/workspace",
          mode: "readwrite",
          seed: { type: "directory", source: disconnectSource },
        },
      ],
    },
    workflow: {
      steps: [
        {
          command: "wordpress.run-php",
          args: ["code=<?php sleep(120); echo 'unreachable';"],
        },
      ],
    },
    artifacts: {
      directory: disconnectArtifacts,
      verify: true,
      workspacePolicy: { strict: false, writableRoots: ["."], gitBacked: false },
    },
  }, null, 2)}\n`)

  const disconnectChild = spawn(process.execPath, [
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    disconnectRecipePath,
    "--artifacts",
    disconnectArtifacts,
    "--json",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  })

  let disconnectStdout = ""
  let disconnectStderr = ""
  disconnectChild.stdout.on("data", (chunk) => {
    disconnectStdout += chunk.toString()
  })
  disconnectChild.stderr.on("data", (chunk) => {
    disconnectStderr += chunk.toString()
  })

  await waitForPointerCommand(disconnectArtifacts, "workflow.steps[0]:wordpress.run-php", 60_000)
  disconnectChild.stdin.end()

  const disconnectExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    disconnectChild.once("close", (code, signal) => resolveExit({ code, signal }))
  })

  assert.equal(disconnectExit.code, 1, `Parent-disconnected recipe should exit with a failure code; stderr: ${disconnectStderr}`)
  assert.equal(disconnectExit.signal, null, `Parent-disconnected recipe should not propagate a signal; stderr: ${disconnectStderr}`)
  assert.ok(disconnectStdout.trim(), `Parent-disconnected recipe should emit JSON output; stderr: ${disconnectStderr}`)

  const disconnectOutput = JSON.parse(disconnectStdout)
  assert.equal(disconnectOutput.schema, "wp-codebox/recipe-run/v1")
  assert.equal(disconnectOutput.success, false)
  assert.equal(disconnectOutput.error?.code, "recipe-interrupted")
  assert.equal(disconnectOutput.interruption?.signal, "SIGHUP")
  assert.equal(disconnectOutput.interruption?.reason, "stdio-closed")
  assert.equal(disconnectOutput.interruption?.artifactsFinalized, true)
  assert.equal(disconnectOutput.run?.status, "cancelled")
  assert.ok(disconnectOutput.artifacts?.directory, "Parent-disconnected recipe should report artifact directory")

  const disconnectLatestRuntime = JSON.parse(await readFile(join(disconnectArtifacts, "latest-runtime.json"), "utf8"))
  assert.equal(disconnectLatestRuntime.schema, "wp-codebox/recipe-run-artifact-pointer/v1")
  assert.equal(disconnectLatestRuntime.commandStatus, "failed")
  assert.equal(disconnectLatestRuntime.failure.code, "recipe-interrupted")
  assert.equal(disconnectLatestRuntime.paths.runtimeManifest, `${disconnectOutput.runtime.id}/manifest.json`)

  console.log("Recipe interruption artifact smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function waitForPointerCommand(directory: string, command: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pointer = JSON.parse(await readFile(join(directory, "latest-runtime.json"), "utf8"))
      if (pointer.currentCommand === command && pointer.commandStatus === "running") {
        return
      }
    } catch {
      // The pointer is created early, but not necessarily before runtime startup begins.
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for artifact pointer command ${command} in ${directory}`)
}

function assertManifestFile(manifest: { files: Array<{ path: string; kind: string }> }, path: string, kind: string): void {
  assert.ok(manifest.files.some((file) => file.path === path && file.kind === kind), `Expected manifest entry ${kind} at ${path}`)
}
