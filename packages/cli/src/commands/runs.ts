import { RuntimeRunRegistry, type RuntimeRunRecord } from "@automattic/wp-codebox-core"

interface RunLookupOptions {
  registryDirectory: string
  runId: string
  json: boolean
}

export async function runRunsStatusCommand(args: string[]): Promise<number> {
  const options = parseRunLookupOptions(args)
  const record = await new RuntimeRunRegistry(options.registryDirectory).read(options.runId)
  if (!options.json) {
    printRunStatusHumanOutput(record)
    return 0
  }

  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  return 0
}

export async function runRunsArtifactsCommand(args: string[]): Promise<number> {
  const options = parseRunLookupOptions(args)
  const record = await new RuntimeRunRegistry(options.registryDirectory).read(options.runId)
  const output = {
    schema: "wp-codebox/run-artifacts/v1",
    runId: record.runId,
    status: record.status,
    artifactRefs: record.artifactRefs,
  }
  if (!options.json) {
    console.log(`WP Codebox run artifacts: ${record.runId}`)
    console.log(`Status: ${record.status}`)
    for (const artifact of record.artifactRefs) {
      console.log(`${artifact.kind}: ${artifact.directory ?? artifact.path ?? artifact.id ?? "unknown"}`)
    }
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

function parseRunLookupOptions(args: string[]): RunLookupOptions {
  const options: Partial<RunLookupOptions> = { json: false }

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
      case "--registry":
      case "--run-registry":
        options.registryDirectory = value
        break
      case "--run-id":
        options.runId = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.registryDirectory) {
    throw new Error("Missing required option: --registry")
  }

  if (!options.runId) {
    throw new Error("Missing required option: --run-id")
  }

  return options as RunLookupOptions
}

function printRunStatusHumanOutput(record: RuntimeRunRecord): void {
  console.log(`WP Codebox run: ${record.runId}`)
  console.log(`Status: ${record.status}`)
  console.log(`Lifecycle: ${record.lifecycle.phase}${record.lifecycle.terminal ? ` (${record.lifecycle.outcome})` : ""}`)
  console.log(`Cancellable: ${record.lifecycle.cancellable ? "yes" : "no"}`)
  console.log(`Cleanup: ${record.lifecycle.cleanup.status} (${record.lifecycle.cleanup.attempts} attempts)`)
  console.log(`Heartbeat: ${record.heartbeatAt}`)
  console.log(`Artifacts: ${record.artifactRefs.length}`)
  if (record.preview?.reviewerAccess?.openUrl) {
    console.log(`Preview: ${record.preview.reviewerAccess.openUrl} (${record.preview.reviewerAccess.status}, ${record.preview.reviewerAccess.mode})`)
  } else if (record.preview?.reviewerAccess?.reason) {
    console.log(`Preview: ${record.preview.reviewerAccess.status} (${record.preview.reviewerAccess.reason})`)
  } else if (record.preview) {
    console.log(`Preview: ${record.preview.status}`)
  }
  if (record.error?.message) {
    console.log(`Error: ${record.error.message}`)
  }
}
