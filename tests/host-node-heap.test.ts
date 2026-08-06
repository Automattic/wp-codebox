import assert from "node:assert/strict"
import { HostNodeHeapPreflightError, assertHostNodeHeapRequirement, classifyRuntimeMemoryFailure, hostNodeHeapReplayArgs, preflightHostNodeHeap } from "../packages/cli/src/host-node-heap.js"
import { validateWorkspaceRecipeJsonSchema } from "../packages/runtime-core/src/index.js"

const requirement = { minimumMiB: 12288, maximumMiB: 16384 }
const preflight = preflightHostNodeHeap(requirement, 4096 * 1024 * 1024)
assert.deepEqual(preflight, {
  status: "insufficient",
  effectiveMiB: 4096,
  minimumMiB: 12288,
  maximumMiB: 16384,
  replayOption: "--host-node-heap-mb=12288",
})
assert.match(new HostNodeHeapPreflightError(preflight!).message, /--host-node-heap-mb=12288/)

assert.deepEqual(hostNodeHeapReplayArgs(["recipe-run", "--recipe", "memory.json", "--host-node-heap-mb=12288"], 12288).slice(0, 2), ["--max-old-space-size=12288", process.argv[1]])
assert.doesNotMatch(hostNodeHeapReplayArgs(["recipe-run", "--host-node-heap-mb=12288"], 12288).join(" "), /--host-node-heap-mb/)
assert.doesNotMatch(hostNodeHeapReplayArgs(["recipe-run", "--host-node-heap-mb", "12288"], 12288).join(" "), /12288$/)
assert.throws(() => assertHostNodeHeapRequirement({ minimumMiB: 16384, maximumMiB: 12288 }), /must not exceed/)

assert.equal(classifyRuntimeMemoryFailure(new Error("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory")), "host-v8-oom")
assert.equal(classifyRuntimeMemoryFailure(new Error("RuntimeError: WebAssembly.Memory(): out of memory at php.wasm")), "php-wasm-oom")
assert.equal(classifyRuntimeMemoryFailure(new Error("PHP Fatal error")), undefined)

assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { hostNodeHeap: requirement },
  workflow: { steps: [{ command: "wordpress.phpunit" }] },
}).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { hostNodeHeap: { minimumMiB: 12288 } },
  workflow: { steps: [{ command: "wordpress.phpunit" }] },
}).valid, false)

console.log("host node heap contract ok")
