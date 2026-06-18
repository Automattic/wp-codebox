import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { materializationPhaseResult, materializationResultEnvelope, type MaterializationArtifactRef, type MaterializationResultEnvelope } from "@automattic/wp-codebox-core"
import { writeReplayExportPackage, type ReplayExportPackage, type RuntimeSnapshotArtifact } from "@automattic/wp-codebox-playground"
import { captureStdout } from "../output.js"

interface MaterializeReplayPackageOptions {
  snapshotPath: string
  outputDirectory: string
  snapshotRef?: string
  id?: string
  createdAt?: string
  landingPage?: string
  json: boolean
}

export async function runMaterializeReplayPackageCommand(args: string[]): Promise<number> {
  const options = parseMaterializeReplayPackageOptions(args)
  const execute = () => materializeReplayPackage(options)

  if (!options.json) {
    const output = await execute()
    printMaterializeReplayPackageHumanOutput(output)
    return 0
  }

  const { result, logs } = await captureStdout(() => materializeReplayPackageEnvelope(options))
  const output = logs.length > 0 ? { ...result, logs } : result
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return result.status === "completed" ? 0 : 1
}

async function materializeReplayPackage(options: MaterializeReplayPackageOptions): Promise<ReplayExportPackage> {
  const snapshotPath = resolve(options.snapshotPath)
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
  if (!isRuntimeSnapshotArtifact(snapshot)) {
    throw new Error(`Input is not a wp-codebox/wordpress-runtime-snapshot/v1 JSON file: ${options.snapshotPath}`)
  }

  const startedAtMs = Date.now()
  return writeReplayExportPackage(snapshot, {
    directory: resolve(options.outputDirectory),
    id: options.id,
    createdAt: options.createdAt,
    landingPage: options.landingPage,
    materializeMs: Date.now() - startedAtMs,
    source: {
      inputSnapshotPath: snapshotPath,
      inputSnapshotRef: options.snapshotRef ?? options.snapshotPath,
      materializerCommand: "wp-codebox materialize-replay-package",
    },
  })
}

async function materializeReplayPackageEnvelope(options: MaterializeReplayPackageOptions): Promise<MaterializationResultEnvelope> {
  const startedAtMs = Date.now()
  try {
    const result = await materializeReplayPackage(options)
    const phase = materializationPhaseResult({
      phase: "wordpress-replay-package-materialization",
      status: "completed",
      artifactRefs: replayPackageArtifactRefs(result),
      metadata: result.metrics,
    })

    return materializationResultEnvelope({
      task: "materialize-replay-package",
      phases: [phase],
      result: result as unknown as Record<string, unknown>,
      projections: [{ kind: "wordpress-replay-package", schema: "wp-codebox/wordpress-replay-export/v1", package: result }],
      metadata: { durationMs: Date.now() - startedAtMs },
    })
  } catch (error) {
    const serialized = serializeMaterializationError(error)
    return materializationResultEnvelope({
      task: "materialize-replay-package",
      status: "failed",
      phases: [materializationPhaseResult({
        phase: "wordpress-replay-package-materialization",
        status: "failed",
        error: serialized,
      })],
      diagnostics: [{
        code: serialized.code ?? "replay-package-materialization-failed",
        message: serialized.message,
        severity: "error",
        phase: "wordpress-replay-package-materialization",
      }],
      error: serialized,
      metadata: { durationMs: Date.now() - startedAtMs },
    })
  }
}

function parseMaterializeReplayPackageOptions(args: string[]): MaterializeReplayPackageOptions {
  const options: Partial<MaterializeReplayPackageOptions> = { json: false }

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
      case "--snapshot":
        options.snapshotPath = value
        break
      case "--output":
        options.outputDirectory = value
        break
      case "--snapshot-ref":
        options.snapshotRef = value
        break
      case "--id":
        options.id = value
        break
      case "--created-at":
        options.createdAt = value
        break
      case "--landing-page":
        options.landingPage = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.snapshotPath) {
    throw new Error("Missing required option: --snapshot")
  }

  if (!options.outputDirectory) {
    throw new Error("Missing required option: --output")
  }

  return options as MaterializeReplayPackageOptions
}

function printMaterializeReplayPackageHumanOutput(output: ReplayExportPackage): void {
  console.log("WP Codebox replay package")
  console.log(`Directory: ${output.directory}`)
  console.log(`Blueprint: ${output.artifacts.blueprint}`)
  console.log(`Snapshot: ${output.artifacts.snapshot}`)
  console.log(`Notes: ${output.artifacts.notes}`)
  console.log(`Manifest: ${output.artifacts.manifest}`)
}

function replayPackageArtifactRefs(result: ReplayExportPackage): MaterializationArtifactRef[] {
  return [
    { kind: "replay-package-manifest", path: result.artifacts.manifest, digest: result.manifest.contentDigest },
    { kind: "replay-package-blueprint", path: result.artifacts.blueprint },
    { kind: "replay-package-bundle", path: result.artifacts.playgroundBundle },
    { kind: "runtime-snapshot", path: result.artifacts.snapshot },
    { kind: "replay-package-notes", path: result.artifacts.notes },
  ]
}

function serializeMaterializationError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    }
  }
  return { name: "Error", message: String(error) }
}

function isRuntimeSnapshotArtifact(value: unknown): value is RuntimeSnapshotArtifact {
  return isRecord(value)
    && value.schema === "wp-codebox/wordpress-runtime-snapshot/v1"
    && value.version === 1
    && isRecord(value.compatibility)
    && value.compatibility.backend === "wordpress-playground"
    && isRecord(value.database)
    && Array.isArray(value.database.tables)
    && Array.isArray(value.files)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
