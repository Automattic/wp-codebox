import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseCommandJson, parseCommandOptions, runFuzzSuite, wordpressWorkloadRunRecipe, type FuzzSuiteContract, type WordPressWorkloadRunRecipeOptions } from "@automattic/wp-codebox-core"
import { captureStdout } from "../output.js"
import { runRecipeRunCommand } from "./recipe-run.js"

const FUZZ_SUITE_RESULT_SCHEMA = "wp-codebox/fuzz-suite-result/v1"
const WORDPRESS_WORKLOAD_RUN_RESULT_SCHEMA = "wp-codebox/wordpress-workload-run-result/v1"

interface PublicRuntimeCommandOptions {
  input: Record<string, unknown>
  json: boolean
  dryRun: boolean
  artifactsDirectory?: string
  runRegistryDirectory?: string
  timeout?: string
}

export async function runFuzzSuiteCommand(args: string[]): Promise<number> {
  if (isHelp(args)) {
    printFuzzSuiteHelp()
    return 0
  }

  const options = await parsePublicRuntimeCommandOptions(args)
  const result = await runFuzzSuite(options.input as unknown as FuzzSuiteContract, {
    metadata: {
      public_cli_command: "run-fuzz-suite",
      dry_run: options.dryRun || undefined,
    },
  })
  const { schema: _schema, ...resultFields } = result
  writeJson({ schema: FUZZ_SUITE_RESULT_SCHEMA, ...resultFields })
  return 0
}

export async function runWordPressWorkloadCommand(args: string[]): Promise<number> {
  if (isHelp(args)) {
    printWordPressWorkloadHelp()
    return 0
  }

  const options = await parsePublicRuntimeCommandOptions(args)
  const recipe = wordpressWorkloadRunRecipe(workloadRecipeOptions(options.input)) as unknown as Record<string, unknown>
  delete recipe.metadata
  const tempDir = await mkdtemp(join(tmpdir(), "wp-codebox-workload-cli-"))
  try {
    const recipePath = join(tempDir, "recipe.json")
    await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8")
    const recipeArgs = ["--recipe", recipePath, "--json"]
    if (options.dryRun) recipeArgs.push("--dry-run")
    if (options.artifactsDirectory) recipeArgs.push("--artifacts", options.artifactsDirectory)
    if (options.runRegistryDirectory) recipeArgs.push("--run-registry", options.runRegistryDirectory)
    if (options.timeout) recipeArgs.push("--timeout", options.timeout)
    const { result: exitCode, logs } = await captureStdout(() => runRecipeRunCommand(recipeArgs))
    for (const log of logs) {
      process.stdout.write(`${log}\n`)
    }
    return logs.length > 0 ? 0 : exitCode
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function parsePublicRuntimeCommandOptions(args: string[]): Promise<PublicRuntimeCommandOptions> {
  const { options, positionals } = parseCommandOptions(args, new Set(["--json", "--dry-run"]))
  if (positionals.length > 0) {
    throw new Error(`Invalid argument: ${positionals[0]}`)
  }

  for (const name of options.keys()) {
    if (!["--input-file", "--input-json", "--format", "--json", "--dry-run", "--artifacts", "--run-registry", "--timeout"].includes(name)) {
      throw new Error(`Unknown option: ${name}`)
    }
  }

  const input = await readInput(options)
  return {
    input,
    json: options.get("--json") === true || options.get("--format") === "json",
    dryRun: options.get("--dry-run") === true,
    artifactsDirectory: stringOption(options, "--artifacts"),
    runRegistryDirectory: stringOption(options, "--run-registry"),
    timeout: stringOption(options, "--timeout"),
  }
}

async function readInput(options: Map<string, string | true>): Promise<Record<string, unknown>> {
  const inputFile = stringOption(options, "--input-file")
  const inputJson = stringOption(options, "--input-json")
  if (inputFile && inputJson) {
    throw new Error("Use either --input-file or --input-json, not both")
  }
  if (inputFile) {
    const parsed = parseCommandJson(await readFile(resolve(inputFile), "utf8"), "--input-file")
    return objectInput(parsed, "--input-file")
  }
  if (inputJson) {
    return objectInput(parseCommandJson(inputJson, "--input-json"), "--input-json")
  }
  throw new Error("Missing required option: --input-file")
}

function workloadRecipeOptions(input: Record<string, unknown>): WordPressWorkloadRunRecipeOptions {
  const steps = arrayOption(input.steps)
  return {
    wordpressVersion: stringValue(input.wordpressVersion ?? input.wordpress_version ?? input.wp),
    blueprint: input.blueprint,
    preview: objectOption(input.preview) as WordPressWorkloadRunRecipeOptions["preview"],
    mounts: arrayOption(input.mounts) as WordPressWorkloadRunRecipeOptions["mounts"],
    runtimeStackMounts: arrayOption(input.runtimeStackMounts ?? input.runtime_stack_mounts) as WordPressWorkloadRunRecipeOptions["runtimeStackMounts"],
    runtimeOverlays: arrayOption(input.runtimeOverlays ?? input.runtime_overlays) as WordPressWorkloadRunRecipeOptions["runtimeOverlays"],
    runtimeEnv: objectOption(input.runtimeEnv ?? input.runtime_env) as WordPressWorkloadRunRecipeOptions["runtimeEnv"],
    secretEnv: arrayOption(input.secretEnv ?? input.secret_env).map(String),
    stagedFiles: arrayOption(input.stagedFiles ?? input.staged_files) as WordPressWorkloadRunRecipeOptions["stagedFiles"],
    before: arrayOption(input.before) as WordPressWorkloadRunRecipeOptions["before"],
    steps: steps as WordPressWorkloadRunRecipeOptions["steps"],
    after: arrayOption(input.after) as WordPressWorkloadRunRecipeOptions["after"],
  }
}

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

function objectOption(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayOption(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringOption(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name)
  return typeof value === "string" && value.trim() ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function isHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h")
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printFuzzSuiteHelp(): void {
  process.stdout.write(`Usage: wp-codebox run-fuzz-suite --input-file <path> [--format=json] [--dry-run]\n\nRuns a wp-codebox/fuzz-suite/v1 JSON payload through the public fuzz-suite runner.\n`)
}

function printWordPressWorkloadHelp(): void {
  process.stdout.write(`Usage: wp-codebox run-wordpress-workload --input-file <path> [--format=json] [--dry-run]\n\nRuns a wp-codebox/wordpress-workload-run/v1 JSON payload through the public WordPress workload recipe boundary.\nResult schema: ${WORDPRESS_WORKLOAD_RUN_RESULT_SCHEMA}\n`)
}
