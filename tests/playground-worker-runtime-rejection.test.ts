import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-playground-worker-rejection-"))
const preloadPath = join(root, "reject-on-command.mjs")

await writeFile(preloadPath, `
import { parentPort } from "node:worker_threads"
import { runInNewContext } from "node:vm"
parentPort?.on("message", (message) => {
  if (message === "wp-codebox-trigger-non-wasm-rejection") {
    Promise.reject(new Error("ordinary worker rejection"))
    setTimeout(() => parentPort?.postMessage("wp-codebox-worker-survived"), 25)
  }
  if (message === "wp-codebox-trigger-php-wasm-rejection") {
    const error = runInNewContext('new WebAssembly.RuntimeError("null function or function signature mismatch")')
    error.stack = "RuntimeError: null function or function signature mismatch\\n    at php.wasm.zif_mysqli_poll (wasm://wasm/php.wasm-05996276:wasm-function[12986]:0x9949a8)"
    Promise.reject(error)
  }
})
`, "utf8")

try {
  for (const version of ["v1", "v2"]) {
    await assertWorkerTerminates(version)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

async function assertWorkerTerminates(version: string): Promise<void> {
  const workerPath = resolve(`node_modules/@wp-playground/cli/worker-thread-${version}.js`)
  const worker = new Worker(pathToFileURL(workerPath), {
    execArgv: ["--import", pathToFileURL(preloadPath).href],
  })

  let workerError: Error | undefined
  let initialized = false
  let survivedOrdinaryRejection = false
  const exitCode = await Promise.race([
    new Promise<number>((resolveExit) => {
      worker.once("message", (message: { command?: unknown; phpPort?: { close?: () => void } }) => {
        if (message?.command !== "worker-script-initialized") return
        initialized = true
        message.phpPort?.close?.()
        worker.postMessage("wp-codebox-trigger-non-wasm-rejection")
      })
      worker.on("message", (message: unknown) => {
        if (message !== "wp-codebox-worker-survived") return
        survivedOrdinaryRejection = true
        worker.postMessage("wp-codebox-trigger-php-wasm-rejection")
      })
      worker.once("error", (error) => {
        workerError = error
      })
      worker.once("exit", resolveExit)
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Playground ${version} worker remained alive after a fatal PHP-WASM rejection`)), 3_000).unref()
    }),
  ]).finally(() => worker.terminate())

  assert.ok(initialized, `Playground ${version} worker must initialize before the rejection checks`)
  assert.ok(survivedOrdinaryRejection, `Playground ${version} worker must preserve ordinary unhandled rejection behavior`)
  assert.notEqual(exitCode, 0, `Playground ${version} worker must exit nonzero after a fatal PHP-WASM rejection`)
  assert.ok(workerError, `Playground ${version} worker must propagate its fatal PHP-WASM rejection`)
  assert.match(workerError.message, /null function or function signature mismatch/)
}

console.log("playground PHP-WASM worker rejection terminalization ok")
