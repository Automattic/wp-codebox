import { resolve } from "node:path"
import { verifyArtifactBundle, type ArtifactBundleVerificationResult } from "@chubes4/wp-codebox-core"
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

async function verifyArtifacts(options: ArtifactVerifyOptions): Promise<ArtifactBundleVerificationResult> {
  return verifyArtifactBundle(resolve(options.bundleDirectory))
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
