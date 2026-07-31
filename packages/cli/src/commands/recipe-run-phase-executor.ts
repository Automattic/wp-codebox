import type { RecipeRunContext } from "./recipe-run-context.js"
import type { RecipeInterruptionController } from "./recipe-run-types.js"
import { isRecipeRunTimeoutError, remainingRecipeTimeoutMs, serializeRecipeRunError, watchRecipeOperation } from "./recipe-run-output.js"
import { RecipePhaseTracker } from "./recipe-run-phases.js"

export interface RecipeRunPhaseExecutorOptions {
  context: RecipeRunContext
  timeoutMs: number
  interruption?: RecipeInterruptionController
  destroyActiveRuntime: () => Promise<void>
}

export class RecipeRunPhaseExecutor {
  readonly tracker = new RecipePhaseTracker(serializeRecipeRunError, isRecipeRunTimeoutError)

  constructor(private readonly options: RecipeRunPhaseExecutorOptions) {}

  async operation<T>(operation: string, promiseOrFactory: Promise<T> | (() => Promise<T>), timeoutMs?: number): Promise<T> {
    const { artifactPointer, startedAtMs } = this.options.context
    const timeout = recipeOperationTimeout(startedAtMs, this.options.timeoutMs, timeoutMs)
    await artifactPointer.update({ command: operation, commandStatus: "running", phases: this.tracker.list() })
    try {
      const promise = typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory
      const guarded = watchRecipeOperation(operation, promise, startedAtMs, timeout.timeoutMs, timeout.configuredTimeoutMs)
      const result = await (this.options.interruption ? this.options.interruption.interruptible(guarded) : guarded)
      await artifactPointer.update({ command: operation, commandStatus: "completed", phases: this.tracker.list() })
      return result
    } catch (error) {
      if (isRecipeRunTimeoutError(error) || this.options.interruption?.metadata) {
        await this.options.destroyActiveRuntime()
      }
      await artifactPointer.update({ command: operation, commandStatus: "failed", failure: serializeRecipeRunError(error), phases: this.tracker.list() })
      throw error
    }
  }
}

export function recipeOperationTimeout(startedAtMs: number, recipeTimeoutMs: number, stepTimeoutMs?: number): { timeoutMs: number; configuredTimeoutMs: number } {
  const remainingTimeoutMs = remainingRecipeTimeoutMs(startedAtMs, recipeTimeoutMs)
  if (stepTimeoutMs === undefined || stepTimeoutMs >= remainingTimeoutMs) {
    return { timeoutMs: remainingTimeoutMs, configuredTimeoutMs: recipeTimeoutMs }
  }
  return { timeoutMs: stepTimeoutMs, configuredTimeoutMs: stepTimeoutMs }
}
