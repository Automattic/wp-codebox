import { createRuntime, stripUndefined, type ArtifactBundle, type ExecutionResult, type MountSpec, type Runtime, type RuntimeInfo, type RuntimePolicy } from "@automattic/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"
import { serializeError } from "./output.js"
import { recipeMountType } from "./recipe-sources.js"
import { defaultPolicy, runPolicy } from "./recipe-validation.js"

export const WP_CODEBOX_RUNTIME_VERSION = "0.0.0"
export const DEFAULT_WORDPRESS_VERSION = "7.0"

export interface RunOptions {
  mounts: Array<{ type?: MountSpec["type"]; source: string; target: string; mode: "readonly" | "readwrite"; metadata?: Record<string, unknown> }>
  command: string
  args: string[]
  wpVersion?: string
  artifactsDirectory?: string
  policy?: RuntimePolicy
  secretEnv?: Record<string, string>
  metadata?: Record<string, unknown>
  blueprint?: unknown
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  json: boolean
}

export interface RunOutput {
  success: boolean
  runtime?: RuntimeInfo
  execution?: ExecutionResult
  artifacts?: ArtifactBundle
  logs?: string[]
  error?: {
    name: string
    message: string
    code?: string
    [key: string]: unknown
  }
}

export interface BootOptions {
  mounts: RunOptions["mounts"]
  wpVersion?: string
  artifactsDirectory?: string
  policy?: RuntimePolicy
  blueprint?: unknown
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  json: boolean
}

export interface BootOutput {
  success: boolean
  schema: "wp-codebox/boot/v1"
  runtime?: RuntimeInfo
  artifacts?: ArtifactBundle
  logs?: string[]
  error?: RunOutput["error"]
}

export interface BlueprintValidateOptions {
  blueprint: unknown
  blueprintPath?: string
  wpVersion?: string
  artifactsDirectory?: string
  policy?: RuntimePolicy
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  json: boolean
}

export interface BlueprintValidateOutput {
  success: boolean
  schema: "wp-codebox/blueprint-validation/v1"
  blueprintPath?: string
  runtime?: RuntimeInfo
  artifacts?: ArtifactBundle
  logs?: string[]
  error?: RunOutput["error"]
}

export interface RuntimeReleaseInterruption {
  interruptible<T>(promise: Promise<T>): Promise<T>
}

export function runtimeMetadata(artifactsDirectory: string | undefined, wpVersion: string): Record<string, unknown> {
  return {
    runtime: {
      version: WP_CODEBOX_RUNTIME_VERSION,
      wordpressVersion: wpVersion,
    },
    task: {
      artifactsDirectory,
    },
  }
}

export function previewSpec(publicUrl: string | undefined, port: number | undefined, bind: string | undefined): { publicUrl?: string; siteUrl?: string; port?: number; bind?: string } | undefined {
  if (bind && port === undefined) {
    throw new Error("--preview-bind requires --preview-port because upstream Playground does not expose bind-host control yet")
  }

  if (!publicUrl && port === undefined && !bind) {
    return undefined
  }

  return stripUndefined({
    publicUrl,
    siteUrl: publicUrl,
    port,
    bind,
  })
}

function runMetadata(options: RunOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "cli-run",
      command: options.command,
      args: options.args,
      artifactsDirectory: options.artifactsDirectory,
      previewPublicUrl: options.previewPublicUrl,
      previewPort: options.previewPort,
      previewBind: options.previewBind,
    }),
  }
}

function bootMetadata(options: BootOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "cli-boot",
      artifactsDirectory: options.artifactsDirectory,
      previewPublicUrl: options.previewPublicUrl,
      previewPort: options.previewPort,
      previewBind: options.previewBind,
    }),
  }
}

function blueprintValidationMetadata(options: BlueprintValidateOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "blueprint-validation",
      blueprintPath: options.blueprintPath,
      artifactsDirectory: options.artifactsDirectory,
      previewPublicUrl: options.previewPublicUrl,
      previewPort: options.previewPort,
      previewBind: options.previewBind,
    }),
  }
}

export async function run(options: RunOptions): Promise<RunOutput> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let execution: ExecutionResult | undefined
  let artifacts: ArtifactBundle | undefined

  try {
    runtime = await createRuntime(
      {
        backend: "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: "wp-codebox-cli",
          version: options.wpVersion ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: options.blueprint ?? { steps: [] },
        },
        policy: options.policy ?? runPolicy(options.command),
        secretEnv: options.secretEnv,
        artifactsDirectory: options.artifactsDirectory,
        metadata: options.metadata ?? runMetadata(options),
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    )

    for (const mount of options.mounts) {
      await runtime.mount({ type: await recipeMountType(mount.source, mount.type), source: mount.source, target: mount.target, mode: mount.mode, metadata: mount.metadata })
    }

    execution = await runtime.execute({ command: options.command, args: options.args })
    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds)

    return {
      success: true,
      runtime: runtimeInfo ?? await runtime.info(),
      execution,
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      try {
        artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
      } catch {
        // Preserve the original failure as the CLI result.
      }

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    return {
      success: false,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(execution ? { execution } : {}),
      ...(artifacts ? { artifacts } : {}),
      error: serializeError(error),
    }
  }
}

export async function boot(options: BootOptions): Promise<BootOutput> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let artifacts: ArtifactBundle | undefined

  try {
    runtime = await createRuntime(
      {
        backend: "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: "wp-codebox-boot",
          version: options.wpVersion ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: options.blueprint ?? { steps: [] },
        },
        policy: options.policy ?? defaultPolicy,
        artifactsDirectory: options.artifactsDirectory,
        metadata: bootMetadata(options),
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    )

    for (const mount of options.mounts) {
      await runtime.mount({ type: await recipeMountType(mount.source, mount.type), source: mount.source, target: mount.target, mode: mount.mode, metadata: mount.metadata })
    }

    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds)

    return {
      success: true,
      schema: "wp-codebox/boot/v1",
      runtime: runtimeInfo ?? await runtime.info(),
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      try {
        artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
      } catch {
        // Preserve the original failure as the CLI result.
      }

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    return {
      success: false,
      schema: "wp-codebox/boot/v1",
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(artifacts ? { artifacts } : {}),
      error: serializeError(error),
    }
  }
}

export async function validateBlueprint(options: BlueprintValidateOptions): Promise<BlueprintValidateOutput> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let artifacts: ArtifactBundle | undefined

  try {
    runtime = await createRuntime(
      {
        backend: "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: "wp-codebox-blueprint-validation",
          version: options.wpVersion ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: options.blueprint,
        },
        policy: options.policy ?? defaultPolicy,
        artifactsDirectory: options.artifactsDirectory,
        metadata: blueprintValidationMetadata(options),
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    )

    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds)

    return {
      success: true,
      schema: "wp-codebox/blueprint-validation/v1",
      ...(options.blueprintPath ? { blueprintPath: options.blueprintPath } : {}),
      runtime: runtimeInfo ?? await runtime.info(),
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      try {
        artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
      } catch {
        // Preserve the original failure as the CLI result.
      }

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    return {
      success: false,
      schema: "wp-codebox/blueprint-validation/v1",
      ...(options.blueprintPath ? { blueprintPath: options.blueprintPath } : {}),
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(artifacts ? { artifacts } : {}),
      error: serializeError(error),
    }
  }
}

export async function releaseRuntime(runtime: Runtime, previewHoldSeconds = 0, afterDestroy?: () => Promise<void>, interruption?: RuntimeReleaseInterruption): Promise<void> {
  const holdSeconds = Math.max(0, Math.floor(previewHoldSeconds))
  if (holdSeconds === 0) {
    await runtime.destroy()
    await afterDestroy?.()
    return
  }

  try {
    await (interruption ? interruption.interruptible(new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000))) : new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000)))
  } finally {
    await runtime.destroy()
    await afterDestroy?.()
  }
}
