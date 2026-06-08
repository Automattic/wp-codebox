import { dirname, resolve } from "node:path"
import { RuntimeRunRegistry, createRuntimeRunId, defaultRunRegistryDirectory, type RuntimeRunRecord, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { loadWorkspaceRecipe } from "../recipe-validation.js"
import { RecipeArtifactPointerTracker } from "./recipe-run-artifact-pointers.js"
import type { RecipeRunOptions } from "./recipe-run-types.js"

export interface RecipeRunContext {
  recipePath: string
  recipeDirectory: string
  recipe: WorkspaceRecipe
  configuredArtifactsDirectory: string | undefined
  runRegistry: RuntimeRunRegistry
  runRecord: RuntimeRunRecord
  artifactPointer: RecipeArtifactPointerTracker
  startedAtMs: number
}

export async function createRecipeRunContext(options: RecipeRunOptions): Promise<RecipeRunContext> {
  const recipePath = resolve(options.recipePath)
  const recipeDirectory = dirname(recipePath)
  const recipe = await loadWorkspaceRecipe(recipePath)
  const configuredArtifactsDirectory = options.artifactsDirectory ?? recipe.artifacts?.directory
  const runRegistry = new RuntimeRunRegistry(options.runRegistryDirectory ?? defaultRunRegistryDirectory(configuredArtifactsDirectory))
  const startedAtMs = Date.now()
  const runRecord = await runRegistry.create({
    runId: createRuntimeRunId(),
    status: "queued",
    metadata: {
      kind: "recipe-run",
      recipePath,
      artifactsDirectory: configuredArtifactsDirectory,
    },
    replay: {
      command: ["wp-codebox", "recipe-run", "--recipe", recipePath],
      recipePath,
    },
  })
  const artifactPointer = new RecipeArtifactPointerTracker(resolve(configuredArtifactsDirectory ?? "artifacts"), runRecord.runId, recipePath, new Date(startedAtMs).toISOString())

  return {
    recipePath,
    recipeDirectory,
    recipe,
    configuredArtifactsDirectory,
    runRegistry,
    runRecord,
    artifactPointer,
    startedAtMs,
  }
}
