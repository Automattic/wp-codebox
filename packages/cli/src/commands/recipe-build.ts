import { readFile, writeFile } from "node:fs/promises"
import { buildWordPressPhpunitRecipe, type WorkspaceRecipe, type WorkspaceRecipeMount } from "@chubes4/wp-codebox-core"

interface RecipeBuildOptions {
  recipeType: "phpunit"
  optionsPath: string
  outputPath?: string
}

interface WordPressPhpunitBuilderOptions {
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
  multisite?: boolean
}

export async function runRecipeBuildCommand(args: string[]): Promise<number> {
  const options = parseRecipeBuildOptions(args)
  const builderOptions = JSON.parse(await readFile(options.optionsPath, "utf8")) as WordPressPhpunitBuilderOptions
  const recipe = buildRecipe(options.recipeType, builderOptions)
  const json = `${JSON.stringify(recipe, null, 2)}\n`

  if (options.outputPath) {
    await writeFile(options.outputPath, json)
  } else {
    process.stdout.write(json)
  }

  return 0
}

function buildRecipe(recipeType: RecipeBuildOptions["recipeType"], options: WordPressPhpunitBuilderOptions): WorkspaceRecipe {
  switch (recipeType) {
    case "phpunit":
      return buildWordPressPhpunitRecipe({
        wordpressVersion: stringOrUndefined(options.wordpressVersion),
        mounts: Array.isArray(options.mounts) ? options.mounts : [],
        pluginSlug: requiredString(options.pluginSlug, "pluginSlug"),
        selectedTestFile: stringOrUndefined(options.selectedTestFile),
        changedTestFiles: Array.isArray(options.changedTestFiles) ? options.changedTestFiles : [],
        env: plainObject(options.env),
        wpConfigDefines: plainObject(options.wpConfigDefines),
        autoloadFile: stringOrUndefined(options.autoloadFile),
        testsDir: stringOrUndefined(options.testsDir),
        dependencyMounts: Array.isArray(options.dependencyMounts) ? options.dependencyMounts : [],
        multisite: Boolean(options.multisite),
      })
  }
}

function parseRecipeBuildOptions(args: string[]): RecipeBuildOptions {
  const recipeType = args.shift()
  if (recipeType !== "phpunit") {
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
    throw new Error("recipe build phpunit requires --options <path>")
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

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
