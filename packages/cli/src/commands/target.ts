import { resolve } from "node:path"
import { runtimeArtifactStorageDescriptor, trustedBrowserSessionOrigins, type RuntimeArtifactStorageDescriptor, type TrustedBrowserSessionOrigin } from "@automattic/wp-codebox-core"

interface TargetProvisionOutput {
  success: true
  schema: "wp-codebox/target-context/v1"
  target: {
    schema: "wp-codebox/target/v1"
    id: string
    kind: string
    workspaceRoot?: string
    sessionId?: string
    storage: RuntimeArtifactStorageDescriptor
    trustedOrigins: TrustedBrowserSessionOrigin[]
    metadata?: Record<string, unknown>
  }
}

interface TargetProvisionOptions {
  id: string
  kind: string
  workspaceRoot?: string
  sessionId?: string
  artifactRoot?: string
  artifactPublicUrlRoot?: string
  artifactPathPrefix?: string
  trustedOrigins: string[]
  metadata?: Record<string, unknown>
  json: boolean
}

export async function runTargetProvisionCommand(args: string[]): Promise<number> {
  const options = parseTargetProvisionOptions(args)
  const output = targetProvisionOutput(options)
  if (!options.json) {
    console.log("WP Codebox target context")
    console.log(`Target: ${output.target.id}`)
    console.log(`Kind: ${output.target.kind}`)
    console.log(`Artifact root: ${output.target.storage.root}`)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export function targetProvisionOutput(options: TargetProvisionOptions): TargetProvisionOutput {
  const workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined
  const metadata = options.metadata && Object.keys(options.metadata).length > 0 ? options.metadata : undefined
  return {
    success: true,
    schema: "wp-codebox/target-context/v1",
    target: stripUndefined({
      schema: "wp-codebox/target/v1" as const,
      id: options.id,
      kind: options.kind,
      workspaceRoot,
      sessionId: options.sessionId,
      storage: runtimeArtifactStorageDescriptor({
        root: options.artifactRoot ?? (workspaceRoot ? `${workspaceRoot}/.wp-codebox/artifacts` : undefined),
        publicUrlRoot: options.artifactPublicUrlRoot,
        pathPrefix: options.artifactPathPrefix,
      }),
      trustedOrigins: trustedBrowserSessionOrigins(options.trustedOrigins),
      metadata,
    }),
  }
}

function parseTargetProvisionOptions(args: string[]): TargetProvisionOptions {
  const options: TargetProvisionOptions = {
    id: "default",
    kind: "generic",
    trustedOrigins: [],
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
      case "--id":
        options.id = value
        break
      case "--kind":
        options.kind = value
        break
      case "--workspace-root":
        options.workspaceRoot = value
        break
      case "--session-id":
        options.sessionId = value
        break
      case "--artifact-root":
        options.artifactRoot = value
        break
      case "--artifact-public-url-root":
        options.artifactPublicUrlRoot = value
        break
      case "--artifact-path-prefix":
        options.artifactPathPrefix = value
        break
      case "--trusted-origin":
        options.trustedOrigins.push(value)
        break
      case "--metadata":
        options.metadata = JSON.parse(value) as Record<string, unknown>
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.id.trim()) {
    throw new Error("Target id is required")
  }
  if (!options.kind.trim()) {
    throw new Error("Target kind is required")
  }

  return options
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
