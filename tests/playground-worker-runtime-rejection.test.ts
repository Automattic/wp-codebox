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
parentPort?.on("message", (message) => {
  if (message !== "wp-codebox-trigger-runtime-rejection") return
  const error = new WebAssembly.RuntimeError("null function or function signature mismatch")
  error.stack = "RuntimeError: null function or function signature mismatch\\n    at php.wasm.zif_mysqli_poll (wasm://wasm/php.wasm-05996276:wasm-function[12986]:0x9949a8)"
  Promise.reject(error)
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
  const exitCode = await Promise.race([
    new Promise<number>((resolveExit) => {
      worker.once("message", (message: { command?: unknown; phpPort?: { close?: () => void } }) => {
        if (message?.command !== "worker-script-initialized") return
        message.phpPort?.close?.()
        worker.postMessage("wp-codebox-trigger-runtime-rejection")
      })
      worker.once("error", (error) => {
        workerError = error
      })
      worker.once("exit", resolveExit)
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Playground ${version} worker remained alive after an unhandled runtime rejection`)), 3_000).unref()
    }),
  ]).finally(() => worker.terminate())

  assert.notEqual(exitCode, 0, `Playground ${version} worker must exit nonzero after an unhandled runtime rejection`)
  assert.ok(workerError, `Playground ${version} worker must propagate its unhandled runtime rejection`)
  assert.match(workerError.message, /null function or function signature mismatch/)
}

console.log("playground worker runtime rejection terminalization ok")
