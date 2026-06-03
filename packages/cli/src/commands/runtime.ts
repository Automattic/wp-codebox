import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { captureStdout, printBlueprintValidateHumanOutput, printBootHumanOutput, printHumanOutput } from "../output.js"
import { parsePreviewBind, parsePreviewHoldSeconds, parsePreviewPort, parsePreviewPublicUrl } from "../preview-options.js"
import { boot, run, validateBlueprint, type BlueprintValidateOptions, type BootOptions, type RunOptions } from "../runtime-command-wrappers.js"
import type { RuntimePolicy } from "@automattic/wp-codebox-core"

export async function runBootCommand(args: string[]): Promise<number> {
  const options = await parseBootOptions(args)
  const execute = () => boot(options)

  if (!options.json) {
    const output = await execute()
    printBootHumanOutput(output)
    return output.success ? 0 : 1
  }

  const { result, logs } = await captureStdout(execute)
  const output = logs.length > 0 ? { ...result, logs } : result
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  printJsonFailureDiagnostic(output)
  return output.success ? 0 : 1
}

export async function runValidateBlueprintCommand(args: string[]): Promise<number> {
  const options = await parseBlueprintValidateOptions(args)
  const execute = () => validateBlueprint(options)

  if (!options.json) {
    const output = await execute()
    printBlueprintValidateHumanOutput(output)
    return output.success ? 0 : 1
  }

  const { result, logs } = await captureStdout(execute)
  const output = logs.length > 0 ? { ...result, logs } : result
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  printJsonFailureDiagnostic(output)
  return output.success ? 0 : 1
}

export async function runRunCommand(args: string[]): Promise<number> {
  const options = await parseRunOptions(args)
  const execute = () => run(options)

  if (!options.json) {
    const output = await execute()
    printHumanOutput(output)
    return output.success ? 0 : 1
  }

  const { result, logs } = await captureStdout(execute)
  const output = logs.length > 0 ? { ...result, logs } : result
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  printJsonFailureDiagnostic(output)
  return output.success ? 0 : 1
}

function printJsonFailureDiagnostic(output: { success: boolean; error?: { message?: string }; logs?: string[] }): void {
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

async function parseRunOptions(args: string[]): Promise<RunOptions> {
  const options: RunOptions = {
    mounts: [],
    command: "",
    args: [],
    json: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--mount":
        options.mounts.push(parseMount(value))
        break
      case "--command":
        options.command = value
        break
      case "--arg":
        options.args.push(value)
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--preview-hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--policy":
        options.policy = await parsePolicy(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.command) {
    throw new Error("Missing required option: --command")
  }

  if (options.mounts.length === 0) {
    throw new Error("At least one --mount host:vfs value is required")
  }

  return options
}

async function parseBootOptions(args: string[]): Promise<BootOptions> {
  const options: BootOptions = {
    mounts: [],
    json: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--mount":
        options.mounts.push(parseMount(value))
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--blueprint":
        options.blueprint = await parseJsonOption(value)
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--policy":
        options.policy = await parsePolicy(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  return options
}

async function parseBlueprintValidateOptions(args: string[]): Promise<BlueprintValidateOptions> {
  const options: Partial<BlueprintValidateOptions> = { json: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--blueprint":
        options.blueprint = await parseJsonOption(value)
        options.blueprintPath = jsonOptionPath(value)
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--preview-hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--policy":
        options.policy = await parsePolicy(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (options.blueprint === undefined) {
    throw new Error("Missing required option: --blueprint")
  }

  return options as BlueprintValidateOptions
}

function parseMount(value: string): RunOptions["mounts"][number] {
  const [source, target, mode = "readwrite"] = value.split(":")

  if (!source || !target) {
    throw new Error(`Invalid mount, expected host:vfs: ${value}`)
  }

  if (mode !== "readonly" && mode !== "readwrite") {
    throw new Error(`Invalid mount mode, expected readonly or readwrite: ${mode}`)
  }

  return {
    source: resolve(source),
    target,
    mode,
    metadata: {
      kind: "cli-mount",
    },
  }
}

async function parsePolicy(value: string): Promise<RuntimePolicy> {
  return JSON.parse(await readJsonOption(value)) as RuntimePolicy
}

async function parseJsonOption(value: string): Promise<unknown> {
  return JSON.parse(await readJsonOption(value))
}

async function readJsonOption(value: string): Promise<string> {
  const trimmed = value.trim()
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? value : await readFile(resolve(value), "utf8")
}

function jsonOptionPath(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? undefined : resolve(value)
}
