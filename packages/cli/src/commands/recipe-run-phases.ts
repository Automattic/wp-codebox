import type { RunOutput } from "../runtime-command-wrappers.js"
import type { RecipePhaseEvidence, RecipePhaseName } from "./recipe-run-types.js"

export class RecipePhaseError extends Error {
  readonly code = "recipe-phase-failed"

  constructor(readonly phase: RecipePhaseName, readonly phaseData: Record<string, unknown> | undefined, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`Recipe phase ${phase} failed: ${message}`, { cause })
    this.name = "RecipePhaseError"
  }
}

export class RecipePhaseTracker {
  private phases: RecipePhaseEvidence[] = []

  constructor(private readonly serializeRecipeRunError: (error: unknown) => RunOutput["error"], private readonly isTimeoutError: (error: unknown) => boolean) {}

  list(): RecipePhaseEvidence[] {
    return this.phases
  }

  complete(name: RecipePhaseName, data?: Record<string, unknown>): void {
    const now = new Date().toISOString()
    this.phases.push({
      schema: "wp-codebox/recipe-phase-evidence/v1",
      name,
      status: "completed",
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      ...(data ? { data } : {}),
    })
  }

  fail(name: RecipePhaseName, error: unknown, data?: Record<string, unknown>): void {
    const now = new Date().toISOString()
    this.phases.push({
      schema: "wp-codebox/recipe-phase-evidence/v1",
      name,
      status: "failed",
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      ...(data ? { data } : {}),
      error: this.serializeRecipeRunError(error),
    })
  }

  async run<T>(name: RecipePhaseName, data: Record<string, unknown> | undefined, callback: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now()
    const startedAt = new Date().toISOString()
    try {
      const result = await callback()
      this.phases.push({
        schema: "wp-codebox/recipe-phase-evidence/v1",
        name,
        status: "completed",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ...(data ? { data } : {}),
      })
      return result
    } catch (error) {
      const phaseError = error instanceof RecipePhaseError || this.isTimeoutError(error) ? error : new RecipePhaseError(name, data, error)
      this.phases.push({
        schema: "wp-codebox/recipe-phase-evidence/v1",
        name,
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ...(data ? { data } : {}),
        error: this.serializeRecipeRunError(error),
      })
      throw phaseError
    }
  }
}
