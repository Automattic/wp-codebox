import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "../packages/runtime-core/src/index.js"
import { createPlaygroundRuntimeBackend } from "../packages/runtime-playground/src/index.js"
import { terminalizeOnPhpWasmRuntimeRejection } from "../packages/runtime-playground/src/playground-command-errors.js"
import type { PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import { executeRecipeWorkflowStep, recipeStepFailure } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-runtime-rejection-"))
const secret = "sk-abcdefghijklmnopqrstuvwxyz"
const phpWasmFailure = new WebAssembly.RuntimeError(`null function or function signature mismatch ${secret}`)
phpWasmFailure.stack = `RuntimeError: ${phpWasmFailure.message}\n    at php.wasm.zif_mysqli_poll (wasm://wasm/php.wasm-05996276:wasm-function[12986]:0x9949a8)`

const cliModule: PlaygroundCliModule = {
  runCLI: async () => ({
    serverUrl: "http://127.0.0.1:9403",
    playground: {
      run: async () => {
        queueMicrotask(() => process.emit("unhandledRejection", phpWasmFailure, Promise.resolve()))
        return await new Promise<never>(() => undefined)
      },
      readFileAsText: async () => "",
    },
    [Symbol.asyncDispose]: async () => undefined,
  }),
}

const runtime = await createRuntime({
  backend: "wordpress-playground",
  artifactsDirectory: root,
  environment: { kind: "wordpress", name: "phpunit-runtime-rejection", version: "7.0", phpVersion: "8.3", blueprint: { steps: [] } },
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.phpunit"], secrets: "none", approvals: "never" },
}, createPlaygroundRuntimeBackend({ cliModule }))

const workflowStep = {
  phase: "steps" as const,
  index: 0,
  step: { command: "wordpress.phpunit", args: ["plugin-slug=demo"] },
}
const startedAt = Date.now()

try {
  let rejectOperation: (reason: Error) => void = () => undefined
  const operation = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject
  })
  const racedFailure = terminalizeOnPhpWasmRuntimeRejection(
    () => operation,
    () => rejectOperation(new Error("generic abort won the race")),
  ).then(
    () => assert.fail("PHPUnit runtime rejection unexpectedly completed"),
    (reason: unknown) => reason,
  )
  process.emit("unhandledRejection", phpWasmFailure, Promise.resolve())
  const rejection = await racedFailure
  assert.equal((rejection as Error & { code?: string }).code, "wp-codebox-php-wasm-runtime-rejection")

  const error = await Promise.race([
    executeRecipeWorkflowStep(runtime, workflowStep, root, undefined, root).then(
      () => assert.fail("PHPUnit step unexpectedly completed"),
      (reason: unknown) => reason,
    ),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("PHPUnit runtime rejection did not terminalize within 5s")), 5_000)),
  ])
  const failure = recipeStepFailure(workflowStep, error, startedAt)
  const serialized = JSON.stringify(failure)

  assert.equal(failure.schema, "wp-codebox/recipe-step-failure/v1")
  assert.equal(failure.classification, "error")
  assert.match(failure.error.message, /Recipe workflow steps\[0\] failed/)
  assert.match(serialized, /wp-codebox-php-wasm-runtime-rejection/)
  assert.match(serialized, /infrastructure-failure/)
  assert.match(serialized, /php-wasm/)
  assert.match(serialized, /null function or function signature mismatch/)
  assert.match(serialized, /\[redacted\]/)
  assert.doesNotMatch(serialized, new RegExp(secret))
  assert.doesNotMatch(serialized, /recipe-run-timeout/)
} finally {
  await runtime.destroy()
  await rm(root, { recursive: true, force: true })
}

console.log("phpunit runtime rejection terminalization ok")
