import assert from "node:assert/strict"
import { createRuntime } from "../packages/runtime-core/src/index.js"
import { createPlaygroundRuntimeBackend, type PlaygroundCliModule } from "../packages/runtime-playground/src/index.js"

let runCalled = false

const fakeCliModule: PlaygroundCliModule = {
  runCLI: async () => ({
    serverUrl: "http://127.0.0.1:9400",
    playground: {
      run: async () => {
        runCalled = true
        return await new Promise<never>(() => undefined)
      },
    },
    async [Symbol.asyncDispose]() {
      return undefined
    },
  }),
}

const runtime = await createRuntime({
  backend: "wordpress-playground",
  environment: { kind: "wordpress", name: "timeout-smoke", version: "7.0", blueprint: { steps: [] } },
  policy: {
    network: "deny",
    filesystem: "sandbox",
    commands: ["wordpress.run-php"],
    secrets: "none",
    approvals: "never",
  },
}, createPlaygroundRuntimeBackend({ cliModule: fakeCliModule }))

await assert.rejects(
  () => runtime.execute({
    command: "wordpress.run-php",
    args: ["code=echo 'never';"],
    timeoutMs: 25,
  }),
  (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Runtime command wordpress\.run-php exceeded timeoutMs=25/)
    return true
  },
)

assert.equal(runCalled, true)

const observation = await runtime.observe({ type: "command-result" })
const commandResult = observation.data as { exitCode?: number; stderr?: string }
assert.equal(commandResult.exitCode, 1)
assert.match(commandResult.stderr ?? "", /timeoutMs=25/)

await runtime.destroy()

console.log("playground command timeout smoke passed")
