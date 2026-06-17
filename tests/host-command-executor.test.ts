import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeHostCommand, executeManagedHostCommand, hostCommandEnv, ManagedHostCommandError, resolveAllowedHostCommandCwd } from "../packages/runtime-core/src/index.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-host-command-executor-"))
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
