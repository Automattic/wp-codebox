import { resolve } from "node:path"
import { verifyArtifactBundle, type ArtifactBundleVerificationResult } from "@automattic/wp-codebox-core"
import { browserArtifactMetrics, type BrowserArtifactMetricsResult } from "@automattic/wp-codebox-playground"
import { printArtifactVerifyHumanOutput } from "../output.js"

interface ArtifactVerifyOptions {
  bundleDirectory: string
  json: boolean
}

export async function runArtifactsVerifyCommand(args: string[]): Promise<number> {
  const options = parseArtifactVerifyOptions(args)
  const output = await verifyArtifacts(options)
  if (!options.json) {
    printArtifactVerifyHumanOutput(output)
    return output.valid ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.valid ? 0 : 1
}

export async function runArtifactsBrowserMetricsCommand(args: string[]): Promise<number> {
  const options = parseArtifactBrowserMetricsOptions(args)
  const output = await browserMetrics(options)
  if (!options.json) {
    printArtifactBrowserMetricsHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

async function verifyArtifacts(options: ArtifactVerifyOptions): Promise<ArtifactBundleVerificationResult> {
  return verifyArtifactBundle(resolve(options.bundleDirectory))
}

async function browserMetrics(options: ArtifactVerifyOptions): Promise<BrowserArtifactMetricsResult> {
  return browserArtifactMetrics(resolve(options.bundleDirectory))
}

function parseArtifactBrowserMetricsOptions(args: string[]): ArtifactVerifyOptions {
  return parseArtifactVerifyOptions(args)
}

function printArtifactBrowserMetricsHumanOutput(output: BrowserArtifactMetricsResult): void {
  console.log("WP Codebox browser metrics")
  console.log(`Bundle: ${output.bundleDirectory}`)
  console.log(`Browser metrics: ${output.hasBrowserMetrics ? "yes" : "no"}`)
  if (Object.keys(output.metrics).length > 0) {
    console.log("Metrics:")
    for (const [name, value] of Object.entries(output.metrics).sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`  ${name}: ${value}`)
    }
  }
  if (Object.keys(output.artifacts).length > 0) {
    console.log("Artifacts:")
    for (const [name, artifact] of Object.entries(output.artifacts).sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`  ${name}: ${artifact.path}`)
    }
  }
}

function parseArtifactVerifyOptions(args: string[]): ArtifactVerifyOptions {
  const options: Partial<ArtifactVerifyOptions> = { json: false }

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
      case "--bundle":
      case "--artifacts":
        options.bundleDirectory = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.bundleDirectory) {
    throw new Error("Missing required option: --bundle")
  }

  return options as ArtifactVerifyOptions
}
