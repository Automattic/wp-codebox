import assert from "node:assert/strict"
import { watch } from "node:fs"
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
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
assert.equal(await isProcessRunning(grandchildPid), false)

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
const samplerReadyPath = join(root, "memory-sampler-ready")
const samplerReleasePath = join(root, "memory-sampler-release")
let recordMemorySample: (() => void) | undefined
const memorySampleRecorded = new Promise<void>((resolve) => {
  recordMemorySample = resolve
})
const withArtifactsPromise = executeHostCommand(
  {
    command: process.execPath,
    args: ["-e", `const { existsSync, watch, writeFileSync } = require("node:fs"); const readyPath = ${JSON.stringify(samplerReadyPath)}; const releasePath = ${JSON.stringify(samplerReleasePath)}; const finish = () => { if (existsSync(releasePath)) process.exit(0) }; process.stdout.write("out"); process.stderr.write("err"); writeFileSync(readyPath, "ready"); const watcher = watch(${JSON.stringify(root)}, finish); finish();`],
    cwd: allowed,
    artifactsDirectory,
    memorySampleIntervalMs: 20,
    timeoutMs: 2_000,
    onMemorySample: () => recordMemorySample?.(),
  },
  {}
)
await waitForFile(samplerReadyPath)
await Promise.race([
  memorySampleRecorded,
  withArtifactsPromise.then(
    () => Promise.reject(new Error("host command exited before recording a memory sample")),
    (error: unknown) => Promise.reject(error),
  ),
])
await writeFile(samplerReleasePath, "release")
const withArtifacts = await withArtifactsPromise
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

async function waitForFile(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== basename(path)) {
        return
      }
      watcher.close()
      resolve()
    })
    watcher.once("error", reject)
    void access(path).then(() => {
      watcher.close()
      resolve()
    }).catch(() => undefined)
  })
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  if (process.platform !== "linux") {
    return true
  }

  // A timeout-killed descendant can remain as a zombie briefly while its new
  // parent reaps it. It is already terminated and cannot execute further.
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
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
