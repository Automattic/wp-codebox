import { readFile, writeFile } from "node:fs/promises"
import { buildGenericAbilityRuntimeRunRecipe, buildRuntimePackageRunRecipe, buildWordPressBenchRecipe, buildWordPressPhpunitRecipe, compileRecipeTemplate, type GenericAbilityRuntimeRunOptions, type RecipeTemplateInput, type RuntimePackageRunRecipeOptions, type WorkspaceRecipe, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeMount, type WorkspaceRecipeStep } from "@automattic/wp-codebox-core"

interface RecipeBuildOptions {
  recipeType: "phpunit" | "bench" | "template" | "generic-ability-runtime-run" | "runtime-package-run"
  optionsPath: string
  outputPath?: string
}

interface WordPressPhpunitBuilderOptions {
  blueprint?: unknown
  wordpressVersion?: string
  mounts?: WorkspaceRecipeMount[]
  pluginSource?: string
  pluginSlug: string
  cwd?: string
  selectedTestFile?: string
  changedTestFiles?: string[]
  env?: Record<string, unknown>
  wpConfigDefines?: Record<string, unknown>
  autoloadFile?: string
  testsDir?: string
  dependencyMounts?: string[]
  bootstrapFiles?: string[]
  phpunitArgs?: string[]
  bootstrapMode?: string
  projectBootstrap?: string
  multisite?: boolean
  prepareSteps?: WorkspaceRecipeStep[]
}

interface WordPressBenchBuilderOptions {
  blueprint?: unknown
  wordpressVersion?: string
  mounts?: WorkspaceRecipeMount[]
  extra_plugins?: WorkspaceRecipeExtraPlugin[]
  componentId?: string
  pluginSlug: string
  iterations?: number
  warmupIterations?: number
  dependencySlugs?: string[]
  env?: Record<string, unknown>
  wpConfigDefines?: Record<string, unknown>
  bootstrapFiles?: string[]
  workloads?: unknown[]
  scenarioIds?: string[]
  lifecycle?: Record<string, unknown>
  resetPolicy?: Record<string, unknown>
}

export async function runRecipeBuildCommand(args: string[]): Promise<number> {
  const options = parseRecipeBuildOptions(args)
  const builderOptions = JSON.parse(await readFile(options.optionsPath, "utf8")) as WordPressPhpunitBuilderOptions | WordPressBenchBuilderOptions | RecipeTemplateInput | GenericAbilityRuntimeRunOptions | RuntimePackageRunRecipeOptions
  const recipe = buildRecipe(options.recipeType, builderOptions)
  const json = `${JSON.stringify(recipe, null, 2)}\n`

  if (options.outputPath) {
    await writeFile(options.outputPath, json)
  } else {
    process.stdout.write(json)
  }

  return 0
}

function buildRecipe(recipeType: RecipeBuildOptions["recipeType"], options: WordPressPhpunitBuilderOptions | WordPressBenchBuilderOptions | RecipeTemplateInput | GenericAbilityRuntimeRunOptions | RuntimePackageRunRecipeOptions): WorkspaceRecipe {
  switch (recipeType) {
    case "phpunit": {
      const phpunitOptions = options as WordPressPhpunitBuilderOptions
      return buildWordPressPhpunitRecipe({
        blueprint: phpunitOptions.blueprint,
        wordpressVersion: stringOrUndefined(phpunitOptions.wordpressVersion),
        mounts: Array.isArray(phpunitOptions.mounts) ? phpunitOptions.mounts : [],
        pluginSource: stringOrUndefined(phpunitOptions.pluginSource),
        pluginSlug: requiredString(phpunitOptions.pluginSlug, "pluginSlug"),
        cwd: stringOrUndefined(phpunitOptions.cwd),
        selectedTestFile: stringOrUndefined(phpunitOptions.selectedTestFile),
        changedTestFiles: Array.isArray(phpunitOptions.changedTestFiles) ? phpunitOptions.changedTestFiles : [],
        env: plainObject(phpunitOptions.env),
        wpConfigDefines: plainObject(phpunitOptions.wpConfigDefines),
        autoloadFile: stringOrUndefined(phpunitOptions.autoloadFile),
        testsDir: stringOrUndefined(phpunitOptions.testsDir),
        dependencyMounts: Array.isArray(phpunitOptions.dependencyMounts) ? phpunitOptions.dependencyMounts : [],
        bootstrapFiles: Array.isArray(phpunitOptions.bootstrapFiles) ? phpunitOptions.bootstrapFiles : [],
        phpunitArgs: Array.isArray(phpunitOptions.phpunitArgs) ? phpunitOptions.phpunitArgs : [],
        bootstrapMode: stringOrUndefined(phpunitOptions.bootstrapMode),
        projectBootstrap: stringOrUndefined(phpunitOptions.projectBootstrap),
        multisite: Boolean(phpunitOptions.multisite),
        prepareSteps: Array.isArray(phpunitOptions.prepareSteps) ? phpunitOptions.prepareSteps : [],
      })
    }
    case "bench": {
      const benchOptions = options as WordPressBenchBuilderOptions
      return buildWordPressBenchRecipe({
        blueprint: benchOptions.blueprint,
        wordpressVersion: stringOrUndefined(benchOptions.wordpressVersion),
        mounts: Array.isArray(benchOptions.mounts) ? benchOptions.mounts : [],
        extra_plugins: Array.isArray(benchOptions.extra_plugins) ? benchOptions.extra_plugins : [],
        componentId: stringOrUndefined(benchOptions.componentId),
        pluginSlug: requiredString(benchOptions.pluginSlug, "pluginSlug"),
        iterations: integerOrUndefined(benchOptions.iterations),
        warmupIterations: integerOrUndefined(benchOptions.warmupIterations),
        dependencySlugs: Array.isArray(benchOptions.dependencySlugs) ? benchOptions.dependencySlugs : [],
        env: plainObject(benchOptions.env),
        wpConfigDefines: plainObject(benchOptions.wpConfigDefines),
        bootstrapFiles: Array.isArray(benchOptions.bootstrapFiles) ? benchOptions.bootstrapFiles : [],
        workloads: Array.isArray(benchOptions.workloads) ? benchOptions.workloads : [],
        scenarioIds: Array.isArray(benchOptions.scenarioIds) ? benchOptions.scenarioIds : [],
        lifecycle: plainObject(benchOptions.lifecycle),
        resetPolicy: plainObject(benchOptions.resetPolicy),
      })
    }
    case "template": {
      const compiled = compileRecipeTemplate(options as RecipeTemplateInput)
      if (compiled.blockers.length > 0) {
        throw new Error(`Recipe template has blockers: ${compiled.blockers.map((blocker) => `${blocker.path} ${blocker.message}`).join("; ")}`)
      }
      return compiled.recipe
    }
    case "generic-ability-runtime-run":
      return buildGenericAbilityRuntimeRunRecipe(options as GenericAbilityRuntimeRunOptions)
    case "runtime-package-run":
      return buildRuntimePackageRunRecipe(options as RuntimePackageRunRecipeOptions)
  }
}

function parseRecipeBuildOptions(args: string[]): RecipeBuildOptions {
  const recipeType = args.shift()
  if (recipeType !== "phpunit" && recipeType !== "bench" && recipeType !== "template" && recipeType !== "generic-ability-runtime-run" && recipeType !== "runtime-package-run") {
    throw new Error(`Unknown recipe build type: ${recipeType ?? ""}`)
  }

  let optionsPath = ""
  let outputPath: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case "--options":
        optionsPath = args[++index] ?? ""
        break
      case "--output":
        outputPath = args[++index] ?? ""
        break
      default:
        throw new Error(`Unknown recipe build option: ${arg}`)
    }
  }

  if (!optionsPath) {
    throw new Error(`recipe build ${recipeType} requires --options <path>`)
  }

  return { recipeType, optionsPath, outputPath }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Recipe build option ${name} must be a non-empty string`)
  }
  return value
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function integerOrUndefined(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
