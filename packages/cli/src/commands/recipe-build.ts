import { readFile, writeFile } from "node:fs/promises"
import { buildWordPressBenchRecipe, buildWordPressPhpunitRecipe, type WorkspaceRecipe, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeMount } from "@automattic/wp-codebox-core"

interface RecipeBuildOptions {
  recipeType: "phpunit" | "bench"
  optionsPath: string
  outputPath?: string
}

interface WordPressPhpunitBuilderOptions {
  blueprint?: unknown
  wordpressVersion?: string
  mounts?: WorkspaceRecipeMount[]
  pluginSlug: string
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
}

interface WordPressBenchBuilderOptions {
  blueprint?: unknown
  wordpressVersion?: string
  mounts?: WorkspaceRecipeMount[]
  extraPlugins?: WorkspaceRecipeExtraPlugin[]
  componentId?: string
  pluginSlug: string
  iterations?: number
  warmupIterations?: number
  dependencySlugs?: string[]
  env?: Record<string, unknown>
  wpConfigDefines?: Record<string, unknown>
  bootstrapFiles?: string[]
  workloads?: unknown[]
}

export async function runRecipeBuildCommand(args: string[]): Promise<number> {
  const options = parseRecipeBuildOptions(args)
  const builderOptions = JSON.parse(await readFile(options.optionsPath, "utf8")) as WordPressPhpunitBuilderOptions | WordPressBenchBuilderOptions
  const recipe = buildRecipe(options.recipeType, builderOptions)
  const json = `${JSON.stringify(recipe, null, 2)}\n`

  if (options.outputPath) {
    await writeFile(options.outputPath, json)
  } else {
    process.stdout.write(json)
  }

  return 0
}

function buildRecipe(recipeType: RecipeBuildOptions["recipeType"], options: WordPressPhpunitBuilderOptions | WordPressBenchBuilderOptions): WorkspaceRecipe {
  switch (recipeType) {
    case "phpunit":
      return buildWordPressPhpunitRecipe({
        blueprint: options.blueprint,
        wordpressVersion: stringOrUndefined(options.wordpressVersion),
        mounts: Array.isArray(options.mounts) ? options.mounts : [],
        pluginSlug: requiredString(options.pluginSlug, "pluginSlug"),
        selectedTestFile: stringOrUndefined((options as WordPressPhpunitBuilderOptions).selectedTestFile),
        changedTestFiles: Array.isArray((options as WordPressPhpunitBuilderOptions).changedTestFiles) ? (options as WordPressPhpunitBuilderOptions).changedTestFiles : [],
        env: plainObject(options.env),
        wpConfigDefines: plainObject(options.wpConfigDefines),
        autoloadFile: stringOrUndefined((options as WordPressPhpunitBuilderOptions).autoloadFile),
        testsDir: stringOrUndefined((options as WordPressPhpunitBuilderOptions).testsDir),
        dependencyMounts: Array.isArray((options as WordPressPhpunitBuilderOptions).dependencyMounts) ? (options as WordPressPhpunitBuilderOptions).dependencyMounts : [],
        bootstrapFiles: Array.isArray((options as WordPressPhpunitBuilderOptions).bootstrapFiles) ? (options as WordPressPhpunitBuilderOptions).bootstrapFiles : [],
        phpunitArgs: Array.isArray((options as WordPressPhpunitBuilderOptions).phpunitArgs) ? (options as WordPressPhpunitBuilderOptions).phpunitArgs : [],
        bootstrapMode: stringOrUndefined((options as WordPressPhpunitBuilderOptions).bootstrapMode),
        projectBootstrap: stringOrUndefined((options as WordPressPhpunitBuilderOptions).projectBootstrap),
        multisite: Boolean((options as WordPressPhpunitBuilderOptions).multisite),
      })
    case "bench":
      return buildWordPressBenchRecipe({
        blueprint: options.blueprint,
        wordpressVersion: stringOrUndefined(options.wordpressVersion),
        mounts: Array.isArray(options.mounts) ? options.mounts : [],
        extraPlugins: Array.isArray((options as WordPressBenchBuilderOptions).extraPlugins) ? (options as WordPressBenchBuilderOptions).extraPlugins : [],
        componentId: stringOrUndefined((options as WordPressBenchBuilderOptions).componentId),
        pluginSlug: requiredString(options.pluginSlug, "pluginSlug"),
        iterations: integerOrUndefined((options as WordPressBenchBuilderOptions).iterations),
        warmupIterations: integerOrUndefined((options as WordPressBenchBuilderOptions).warmupIterations),
        dependencySlugs: Array.isArray((options as WordPressBenchBuilderOptions).dependencySlugs) ? (options as WordPressBenchBuilderOptions).dependencySlugs : [],
        env: plainObject(options.env),
        wpConfigDefines: plainObject(options.wpConfigDefines),
        bootstrapFiles: Array.isArray((options as WordPressBenchBuilderOptions).bootstrapFiles) ? (options as WordPressBenchBuilderOptions).bootstrapFiles : [],
        workloads: Array.isArray((options as WordPressBenchBuilderOptions).workloads) ? (options as WordPressBenchBuilderOptions).workloads : [],
      })
  }
}

function parseRecipeBuildOptions(args: string[]): RecipeBuildOptions {
  const recipeType = args.shift()
  if (recipeType !== "phpunit" && recipeType !== "bench") {
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
