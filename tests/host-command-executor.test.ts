import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeHostCommand, hostCommandEnv, resolveAllowedHostCommandCwd } from "../packages/runtime-core/src/index.js"

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
