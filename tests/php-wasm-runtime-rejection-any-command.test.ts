/**
 * A php.wasm trap is a property of the runtime, not of the command that
 * happened to be running. The terminalizer was originally wired only to
 * `wordpress.phpunit` (851f0aa), which left every other command able to hang
 * forever on the identical fault: a trap raised during `wordpress.run-php`
 * wedged a recipe-run for its whole budget and reported only a timeout.
 *
 * This pins the generalization — a non-PHPUnit command must terminalize too.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "../packages/runtime-core/src/index.js"
import { createPlaygroundRuntimeBackend } from "../packages/runtime-playground/src/index.js"
import type { PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import { executeRecipeWorkflowStep, recipeStepFailure } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-php-wasm-rejection-any-command-"))

// The fault observed in the field: mysqli async polling traps inside the
// PHP-WASM build and the rejection surfaces out of band on the process, while
// the command's own promise never settles.
const phpWasmFailure = new WebAssembly.RuntimeError("null function or function signature mismatch")
phpWasmFailure.stack = [
  `RuntimeError: ${phpWasmFailure.message}`,
  "    at php.wasm._php_stream_write_filtered (wasm://wasm/php.wasm-05996276:wasm-function[3039]:0x26c31e)",
  "    at php.wasm.mysqlnd_stream_array_from_fd_set (wasm://wasm/php.wasm-05996276:wasm-function[8606]:0x69ad75)",
  "    at php.wasm.zif_mysqli_poll (wasm://wasm/php.wasm-05996276:wasm-function[12986]:0x9949a8)",
].join("\n")

const cliModule: PlaygroundCliModule = {
  runCLI: async () => ({
    serverUrl: "http://127.0.0.1:9404",
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
  environment: { kind: "wordpress", name: "php-wasm-rejection-any-command", version: "7.0", phpVersion: "8.3", blueprint: { steps: [] } },
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.run-php"], secrets: "none", approvals: "never" },
}, createPlaygroundRuntimeBackend({ cliModule }))

const workflowStep = {
  phase: "steps" as const,
  index: 0,
  step: { command: "wordpress.run-php", args: ["code=<?php mysqli_poll();"] },
}
const startedAt = Date.now()

try {
  const error = await Promise.race([
    executeRecipeWorkflowStep(runtime, workflowStep, root, undefined, root).then(
      () => assert.fail("wordpress.run-php unexpectedly completed after a php.wasm trap"),
      (reason: unknown) => reason,
    ),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("php.wasm runtime rejection did not terminalize a non-PHPUnit command within 500ms")), 500)),
  ])
  const failure = recipeStepFailure(workflowStep, error, startedAt)
  const serialized = JSON.stringify(failure)

  assert.equal(failure.schema, "wp-codebox/recipe-step-failure/v1")
  assert.equal(failure.classification, "error")
  // The whole point: a trapped runtime must not be paid for at budget rates.
  assert.ok(failure.durationMs < 500, `expected immediate terminal failure, received ${failure.durationMs}ms`)
  assert.match(serialized, /wp-codebox-php-wasm-runtime-rejection/)
  assert.match(serialized, /infrastructure-failure/)
  assert.match(serialized, /php-wasm/)
  assert.match(serialized, /null function or function signature mismatch/)
  // The failure must name the trap, not the clock.
  assert.doesNotMatch(serialized, /recipe-run-timeout/)
} finally {
  await runtime.destroy()
  await rm(root, { recursive: true, force: true })
}

console.log("php.wasm runtime rejection terminalizes non-phpunit commands ok")
