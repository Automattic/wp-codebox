import assert from "node:assert/strict"
import { mkdir, readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { classifyHostCommandFailure, executeHostCommand, executeManagedHostCommand, hostCommandEnv, ManagedHostCommandError, resolveAllowedHostCommandCwd } from "../packages/runtime-core/src/index.js"
import { assertJsonFile, assertTextFile, withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-host-command-executor-", async (root) => {
const allowed = join(root, "allowed")
const sibling = join(root, "allowed-sibling")
const child = join(allowed, "child")
await mkdir(child, { recursive: true })
await mkdir(sibling, { recursive: true })

assert.equal(await resolveAllowedHostCommandCwd({ cwd: allowed }, child), await realpath(child))
await assert.rejects(() => resolveAllowedHostCommandCwd({ cwd: allowed }, sibling), /outside allowed roots/)

const env = hostCommandEnv({ env: { FIXED: "yes" }, inheritedEnv: ["PATH"], allowedInputEnv: ["INPUT_OK"] }, { INPUT_OK: "allowed" })
assert.equal(env.FIXED, "yes")
assert.equal(env.INPUT_OK, "allowed")
assert.equal(env.PATH, process.env.PATH ?? "")
assert.throws(() => hostCommandEnv({ allowedInputEnv: ["INPUT_OK"] }, { INPUT_DENIED: "no" }), /env is not allowed/)

const truncated = await executeHostCommand(
  {
    command: process.execPath,
    args: ["-e", "process.stdout.write('abcdef')"],
    cwd: allowed,
    maxOutputBytes: 3,
  },
  {}
)
assert.equal(truncated.stdout, "abc")
assert.equal(truncated.outputTruncated, true)
assert.equal(truncated.failureClassification, "none")
assert.equal(truncated.commandSummary, `${process.execPath} -e process.stdout.write('abcdef')`)

const timedOut = await executeHostCommand(
  {
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    cwd: allowed,
  },
  { timeoutMs: 25 }
)
assert.equal(timedOut.timedOut, true)
assert.notEqual(timedOut.signal, "")
assert.equal(timedOut.failureClassification, "timeout")

const grandchildPidFile = join(root, "grandchild.pid")
const processTreeTimedOut = await executeHostCommand(
  {
    command: process.execPath,
    args: ["-e", `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid)); setInterval(() => {}, 1000);`],
    cwd: allowed,
    terminationGraceMs: 25,
  },
  { timeoutMs: 2_000 }
)
assert.equal(processTreeTimedOut.failureClassification, "timeout")
const grandchildPid = Number.parseInt(await readFile(grandchildPidFile, "utf8"), 10)
await sleep(150)
assert.equal(isProcessRunning(grandchildPid), false)

const nonZero = await executeHostCommand(
  {
    command: process.execPath,
    args: ["-e", "process.exit(9)"],
    cwd: allowed,
  },
  {}
)
assert.equal(nonZero.exitCode, 9)
assert.equal(nonZero.failureClassification, "non_zero_exit")

const artifactsDirectory = join(root, "artifacts")
const withArtifacts = await executeHostCommand(
  {
    command: process.execPath,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); setTimeout(() => {}, 75)"],
    cwd: allowed,
    artifactsDirectory,
    memorySampleIntervalMs: 20,
  },
  {}
)
assert.equal(withArtifacts.stdout, "out")
assert.equal(withArtifacts.stderr, "err")
assert.ok(withArtifacts.artifacts?.stdout?.path.endsWith("stdout.log"))
assert.ok(withArtifacts.artifacts?.stderr?.path.endsWith("stderr.log"))
assert.ok(withArtifacts.artifacts?.summary?.path.endsWith("command-summary.json"))
await assertTextFile(withArtifacts.artifacts!.stdout!.path, "out")
await assertTextFile(withArtifacts.artifacts!.stderr!.path, "err")
const artifactSummary = await assertJsonFile<{ schema: string, failureClassification: string, memorySamples: unknown[] }>(withArtifacts.artifacts!.summary!.path)
assert.equal(artifactSummary.schema, "wp-codebox/host-command-summary/v1")
assert.equal(artifactSummary.failureClassification, "none")
assert.ok(Array.isArray(artifactSummary.memorySamples))
assert.ok(withArtifacts.memorySamples.length > 0)
assert.ok(withArtifacts.peakRssBytes > 0)

assert.equal(classifyHostCommandFailure(0, null, false), "none")
assert.equal(classifyHostCommandFailure(2, null, false), "non_zero_exit")
assert.equal(classifyHostCommandFailure(null, "SIGTERM", false), "signal")
assert.equal(classifyHostCommandFailure(null, "SIGTERM", true), "timeout")

const managed = await executeManagedHostCommand({
  command: process.execPath,
  args: ["-e", "process.stdout.write('visible-secret-value')"],
  cwd: allowed,
  label: "managed success",
  redact: [(value, field) => field === "stdout" ? value.replace("secret-value", "custom-redacted") : value],
})
assert.equal(managed.exitCode, 0)
assert.equal(managed.diagnostic.label, "managed success")
assert.equal(managed.diagnostic.stdout, "visible-custom-redacted")

await assert.rejects(
  () => executeManagedHostCommand({
    command: process.execPath,
    args: ["-e", "process.stderr.write('password=hunter2'); process.exit(7)"],
    cwd: allowed,
    label: "managed failure",
  }),
  (error) => {
    assert.ok(error instanceof ManagedHostCommandError)
    assert.equal(error.diagnostic.exitCode, 7)
    assert.equal(error.diagnostic.stderr, "password=[redacted]")
    return true
  }
)

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

await assert.rejects(
  () => executeManagedHostCommand({
    command: "wp-codebox-command-that-does-not-exist",
    cwd: allowed,
    label: "managed spawn failure",
  }),
  (error) => {
    assert.ok(error instanceof ManagedHostCommandError)
    assert.equal(error.diagnostic.exitCode, -1)
    assert.equal(error.diagnostic.command, "wp-codebox-command-that-does-not-exist")
    assert.match(error.diagnostic.stderr, /spawn wp-codebox-command-that-does-not-exist/)
    return true
  }
)
})
