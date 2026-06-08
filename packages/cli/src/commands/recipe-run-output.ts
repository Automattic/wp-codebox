import { setTimeout as delay } from "node:timers/promises"
import type { RuntimeRunRecord } from "@automattic/wp-codebox-core"
import { serializeError } from "../output.js"
import type { RunOutput } from "../runtime-command-wrappers.js"
import { RecipePhaseError } from "./recipe-run-phases.js"
import type { RecipeInterruptionController, RecipeRunCommandOutput, RecipeRunDeclaredArtifact, RecipeRunProbe } from "./recipe-run-types.js"

export class RecipeRunTimeoutError extends Error {
  readonly code = "recipe-run-timeout"
  readonly activeOperation: string
  readonly elapsedMs: number
  readonly timeoutMs: number

  constructor(activeOperation: string, elapsedMs: number, timeoutMs: number) {
    super(`Recipe run timed out after ${elapsedMs}ms while waiting for ${activeOperation}`)
    this.name = "RecipeRunTimeoutError"
    this.activeOperation = activeOperation
    this.elapsedMs = elapsedMs
    this.timeoutMs = timeoutMs
  }
}

export class RecipeRuntimeCreateError extends Error {
  readonly code = "recipe-runtime-create-failed"

  constructor(message: string, readonly context: Record<string, unknown>, cause: unknown) {
    super(message, { cause })
    this.name = "RecipeRuntimeCreateError"
  }
}

export class RecipeProbeFailureError extends Error {
  readonly code = "recipe-probe-failed"

  constructor(readonly probes: RecipeRunProbe[]) {
    const failed = probes.filter((probe) => probe.status === "failed" && !probe.allowFailure)
    super(`${failed.length} recipe probe${failed.length === 1 ? "" : "s"} failed: ${failed.map((probe) => probe.name).join(", ")}`)
    this.name = "RecipeProbeFailureError"
  }
}

export class RecipeDeclaredArtifactFailureError extends Error {
  readonly code = "recipe-artifact-collection-failed"

  constructor(readonly declaredArtifacts: RecipeRunDeclaredArtifact[]) {
    const failed = declaredArtifacts.filter((artifact) => artifact.required && artifact.status !== "collected")
    super(`${failed.length} required recipe artifact${failed.length === 1 ? "" : "s"} failed collection: ${failed.map((artifact) => artifact.name).join(", ")}`)
    this.name = "RecipeDeclaredArtifactFailureError"
  }
}

export function exitAfterPlaygroundCliBootFailure(output: RecipeRunCommandOutput): void {
  if (output.schema === "wp-codebox/recipe-run/v1" && hasSerializedErrorCode(output.error, "wp-codebox-playground-cli-exited")) {
    process.exit(output.success ? 0 : 1)
  }
}

function hasSerializedErrorCode(error: RunOutput["error"] | undefined, code: string): boolean {
  if (!error) {
    return false
  }

  if (error.code === code) {
    return true
  }

  const cause = error.cause
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) {
    return false
  }

  return hasSerializedErrorCode(cause as RunOutput["error"], code)
}

export function exitAfterRecipeRunTimeout(output: RecipeRunCommandOutput): void {
  if (output.schema === "wp-codebox/recipe-run/v1" && output.error?.code === "recipe-run-timeout") {
    process.exit(output.success ? 0 : 1)
  }
}

export function printJsonFailureDiagnostic(output: { success: boolean; error?: { message?: string }; logs?: string[] }): void {
  if (output.success) {
    return
  }

  const message = output.error?.message?.trim()
  if (message) {
    console.error(message)
  }

  for (const log of output.logs ?? []) {
    const trimmed = log.trim()
    if (trimmed) {
      console.error(trimmed)
    }
  }
}

export function remainingRecipeTimeoutMs(startedAtMs: number, timeoutMs: number): number {
  return Math.max(1, timeoutMs - (Date.now() - startedAtMs))
}

export async function watchRecipeOperation<T>(operation: string, promise: Promise<T>, startedAtMs: number, timeoutMs: number, configuredTimeoutMs = timeoutMs): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  promise.catch(() => undefined)

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new RecipeRunTimeoutError(operation, Date.now() - startedAtMs, configuredTimeoutMs))
        }, timeoutMs)
        timeout.unref()
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function bestEffortTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  promise.catch(() => undefined)
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => undefined),
  ])
}

export function serializeRecipeRunError(error: unknown): RunOutput["error"] {
  if (error instanceof RecipePhaseError && (error.cause instanceof RecipeProbeFailureError || error.cause instanceof RecipeDeclaredArtifactFailureError)) {
    return {
      ...serializeError(error),
      code: error.cause.code,
      cause: serializeError(error.cause),
    }
  }

  const serialized = serializeError(error)
  if (error instanceof RecipeRunTimeoutError) {
    return {
      ...serialized,
      activeOperation: error.activeOperation,
      elapsedMs: error.elapsedMs,
      timeoutMs: error.timeoutMs,
    }
  }

  return serialized
}

export function recipeRunFailureStatus(error: unknown, interruption?: RecipeInterruptionController): RuntimeRunRecord["status"] {
  if (interruption?.metadata) {
    return "cancelled"
  }

  if (error instanceof RecipeRunTimeoutError) {
    return "timed_out"
  }

  return "failed"
}

export function isRecipeRunTimeoutError(error: unknown): boolean {
  return error instanceof RecipeRunTimeoutError
}
