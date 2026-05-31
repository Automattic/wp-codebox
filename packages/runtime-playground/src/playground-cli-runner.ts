import { playgroundBlueprint } from "./blueprint.js"
import { PlaygroundCliExitError } from "./playground-command-errors.js"
import { PlaygroundPreviewPortUnavailableError, assertPreviewPortAvailable, errorHasCode, withPreviewProxy, type PlaygroundCliServer } from "./preview-server.js"
import type { MountSpec, RuntimeCreateSpec } from "@chubes4/wp-codebox-core"

interface PlaygroundCliModule {
  runCLI(options: {
    command: "server"
    port: number
    quiet: boolean
    skipBrowser: boolean
    mount: Array<{ hostPath: string; vfsPath: string }>
    blueprint?: unknown
    wp?: string
    "site-url"?: string
  }): Promise<PlaygroundCliServer>
}

export async function startPlaygroundCliServer(spec: RuntimeCreateSpec, mounts: MountSpec[]): Promise<PlaygroundCliServer> {
  const { runCLI } = (await import("@wp-playground/cli")) as unknown as PlaygroundCliModule
  if (spec.preview?.port) {
    await assertPreviewPortAvailable(spec.preview.port)
  }

  try {
    const server = await runPlaygroundCliWithoutProcessExit(() => runCLI({
      command: "server",
      port: 0,
      quiet: true,
      skipBrowser: true,
      mount: mounts.map((mount) => ({
        hostPath: mount.source,
        vfsPath: mount.target,
      })),
      wp: spec.environment.version,
      "site-url": spec.preview?.siteUrl,
      blueprint: playgroundBlueprint(spec.environment.blueprint, spec.policy, spec.preview?.siteUrl),
    }))

    if (!spec.preview?.port) {
      return server
    }

    return await withPreviewProxy(server, spec.preview.port, spec.preview.bind)
  } catch (error) {
    if (spec.preview?.port && errorHasCode(error, "EADDRINUSE")) {
      throw new PlaygroundPreviewPortUnavailableError(spec.preview.port, error)
    }

    throw error
  }
}

async function runPlaygroundCliWithoutProcessExit<T>(callback: () => Promise<T>): Promise<T> {
  const exit = process.exit
  process.exit = ((code?: string | number | null | undefined): never => {
    const exitCode = typeof code === "number" ? code : 1
    throw new PlaygroundCliExitError(exitCode)
  }) as typeof process.exit

  try {
    return await callback()
  } finally {
    process.exit = exit
  }
}
