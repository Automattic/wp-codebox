import assert from "node:assert/strict"
import { createRuntime } from "../packages/runtime-core/src/index.js"
import { createPlaygroundRuntimeBackend, type PlaygroundCliModule } from "../packages/runtime-playground/src/index.js"

const commandTimeoutMs = 25
let runCalls = 0
let runtimeDisposed = false
let timedRunCompleted = false
let resolveRunEntered!: () => void
let resolveTimedRun!: () => void
let resolveTimedRunSettled!: () => void
const runEntered = new Promise<void>((resolve) => {
  resolveRunEntered = resolve
})
const timedRun = new Promise<{ text: string; exitCode: number }>((resolve) => {
  resolveTimedRun = () => resolve({ text: "", exitCode: 0 })
})
const timedRunSettled = new Promise<void>((resolve) => {
  resolveTimedRunSettled = resolve
})

const fakeCliModule: PlaygroundCliModule = {
  runCLI: async () => ({
    serverUrl: "http://127.0.0.1:9400",
    playground: {
      run: async () => {
        runCalls += 1
        if (runCalls === 1) {
          return { text: "warm", exitCode: 0 }
        }

        resolveRunEntered()
        try {
          return await timedRun
        } finally {
          timedRunCompleted = true
          resolveTimedRunSettled()
        }
      },
    },
    async [Symbol.asyncDispose]() {
      runtimeDisposed = true
      resolveTimedRun()
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

try {
  // Keep runtime startup outside the deliberately tiny in-flight command budget.
  await runtime.execute({
    command: "wordpress.run-php",
    args: ["code=echo 'warm';"],
  })

  const startedAt = Date.now()
  const execution = runtime.execute({
    command: "wordpress.run-php",
    args: ["code=echo 'never';"],
    timeoutMs: commandTimeoutMs,
  })

  const enteredBeforeSettlement = await Promise.race([
    runEntered.then(() => true),
    execution.then(() => false, () => false),
  ])
  assert.equal(enteredBeforeSettlement, true, "the timed command must enter Playground run() before settling")

  await assert.rejects(
    () => execution,
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Runtime command wordpress\.run-php exceeded timeoutMs=25/)
      return true
    },
  )

  const elapsedMs = Date.now() - startedAt
  assert.ok(elapsedMs >= commandTimeoutMs, `timeout fired early after ${elapsedMs}ms`)
  assert.ok(elapsedMs < 1_000, `timeout was not bounded: ${elapsedMs}ms`)
  assert.equal(timedRunCompleted, false, "timeout must cancel execution without waiting for the backend run to settle")

  const observation = await runtime.observe({ type: "command-result" })
  const commandResult = observation.data as { exitCode?: number; stderr?: string }
  assert.equal(commandResult.exitCode, 1)
  assert.match(commandResult.stderr ?? "", /timeoutMs=25/)
} finally {
  await runtime.destroy()
}

await timedRunSettled
assert.equal(timedRunCompleted, true)
assert.equal(runtimeDisposed, true, "runtime teardown must terminate the in-flight fake backend run")

console.log("playground command timeout smoke passed")
