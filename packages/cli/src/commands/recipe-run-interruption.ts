import { fstatSync } from "node:fs"
import type { RunOutput } from "../runtime-command-wrappers.js"
import type { RecipeInterruptionController, RecipeInterruptionMetadata, RecipeInterruptionReason, RecipeInterruptionSignal, RecipeRunCommandOutput } from "./recipe-run-types.js"

export class RecipeInterruptedError extends Error {
  readonly code = "recipe-interrupted"

  constructor(readonly signal: RecipeInterruptionSignal, readonly reason: RecipeInterruptionReason, readonly receivedAt: string) {
    super(recipeInterruptionMessage({ signal, reason }))
    this.name = "RecipeInterruptedError"
  }
}

export function createRecipeInterruptionController(): RecipeInterruptionController {
  let metadata: RecipeInterruptionMetadata | undefined
  let rejectInterrupted: ((error: RecipeInterruptedError) => void) | undefined
  let installed = false
  let parentWatcher: NodeJS.Timeout | undefined
  let stdinWatcherInstalled = false
  let stdioErrorWatcherInstalled = false
  const initialParentPid = process.ppid
  const signals: RecipeInterruptionSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  const interrupt = (signal: RecipeInterruptionSignal, reason: RecipeInterruptionReason): void => {
    if (!metadata) {
      metadata = { signal, reason, receivedAt: new Date().toISOString(), artifactsFinalized: false }
    }
    rejectInterrupted?.(new RecipeInterruptedError(metadata.signal, metadata.reason, metadata.receivedAt))
  }
  const handler = (signal: RecipeInterruptionSignal): void => {
    interrupt(signal, "signal")
  }
  const parentDisconnectHandler = (): void => {
    interrupt("SIGHUP", "parent-disconnect")
  }
  const stdinClosedHandler = (): void => {
    interrupt("SIGHUP", "stdio-closed")
  }
  const stdioErrorHandler = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
      interrupt("SIGHUP", "stdio-closed")
    }
  }

  const controller: RecipeInterruptionController = {
    get metadata() {
      return metadata
    },
    install() {
      if (installed) {
        return
      }
      for (const signal of signals) {
        process.on(signal, handler)
      }
      if (initialParentPid > 1) {
        parentWatcher = setInterval(() => {
          if (process.ppid === 1 || process.ppid !== initialParentPid) {
            parentDisconnectHandler()
          }
        }, 1_000)
        parentWatcher.unref()
      }
      if (!process.stdin.isTTY && process.stdin.readable && stdinCanSignalParentDisconnect()) {
        process.stdin.on("end", stdinClosedHandler)
        process.stdin.on("close", stdinClosedHandler)
        process.stdin.resume()
        stdinWatcherInstalled = true
      }
      process.stdout.on("error", stdioErrorHandler)
      process.stderr.on("error", stdioErrorHandler)
      stdioErrorWatcherInstalled = true
      installed = true
    },
    dispose() {
      if (!installed) {
        return
      }
      for (const signal of signals) {
        process.off(signal, handler)
      }
      if (parentWatcher) {
        clearInterval(parentWatcher)
        parentWatcher = undefined
      }
      if (stdinWatcherInstalled) {
        process.stdin.off("end", stdinClosedHandler)
        process.stdin.off("close", stdinClosedHandler)
        process.stdin.pause()
        stdinWatcherInstalled = false
      }
      if (stdioErrorWatcherInstalled) {
        process.stdout.off("error", stdioErrorHandler)
        process.stderr.off("error", stdioErrorHandler)
        stdioErrorWatcherInstalled = false
      }
      installed = false
    },
    async interruptible<T>(promise: Promise<T>): Promise<T> {
      if (metadata) {
        throw new RecipeInterruptedError(metadata.signal, metadata.reason, metadata.receivedAt)
      }

      let settled = false
      try {
        return await Promise.race([
          promise.finally(() => {
            settled = true
          }),
          new Promise<T>((_resolve, reject) => {
            rejectInterrupted = (error) => {
              if (!settled) {
                reject(error)
              }
            }
          }),
        ])
      } finally {
        rejectInterrupted = undefined
      }
    },
    throwIfInterrupted() {
      if (metadata) {
        throw new RecipeInterruptedError(metadata.signal, metadata.reason, metadata.receivedAt)
      }
    },
    propagateIfInterrupted() {
      if (!metadata || metadata.reason !== "signal") {
        return
      }
      controller.dispose()
      process.kill(process.pid, metadata.signal)
    },
  }

  return controller
}

function stdinCanSignalParentDisconnect(): boolean {
  if (process.env.WP_CODEBOX_RECIPE_RUN_STDIN_DISCONNECT !== "1") {
    return false
  }

  try {
    const stats = fstatSync(0)
    return stats.isFIFO() || stats.isSocket()
  } catch {
    return false
  }
}

export function markRecipeArtifactsFinalized(interruption: RecipeInterruptionController | undefined, artifactsFinalized: boolean): void {
  if (interruption?.metadata) {
    interruption.metadata.artifactsFinalized = artifactsFinalized
  }
}

export function interruptedRecipeOutput<T extends RecipeRunCommandOutput>(output: T, interruption: RecipeInterruptionController | undefined): T {
  if (!interruption?.metadata || output.schema !== "wp-codebox/recipe-run/v1") {
    return output
  }

  return {
    ...output,
    success: false,
    interruption: interruption.metadata,
    error: recipeInterruptionSerializedError(interruption.metadata),
  } as T
}

export function recipeInterruptionSerializedError(metadata: RecipeInterruptionMetadata): RunOutput["error"] {
  return {
    name: "RecipeInterruptedError",
    message: recipeInterruptionMessage(metadata),
    code: "recipe-interrupted",
  }
}

function recipeInterruptionMessage(metadata: Pick<RecipeInterruptionMetadata, "signal" | "reason">): string {
  if (metadata.reason === "parent-disconnect") {
    return "Recipe run interrupted after parent process disconnected"
  }
  if (metadata.reason === "stdio-closed") {
    return "Recipe run interrupted after stdio closed"
  }
  return `Recipe run interrupted by ${metadata.signal}`
}
