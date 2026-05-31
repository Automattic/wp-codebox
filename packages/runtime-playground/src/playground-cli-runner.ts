import { playgroundBlueprint } from "./blueprint.js"
import { PlaygroundCliExitError } from "./playground-command-errors.js"
import { PlaygroundPreviewPortUnavailableError, assertPreviewPortAvailable, errorHasCode, withPreviewProxy, type PlaygroundCliServer } from "./preview-server.js"
import type { MountSpec, RuntimeCreateSpec } from "@chubes4/wp-codebox-core"
import { randomInt } from "node:crypto"
import { createServer as createNetServer } from "node:net"

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

  const port = spec.preview?.port ? 0 : await availablePlaygroundPortRange()

  try {
    const server = await runPlaygroundCliWithoutProcessExit(() => runCLI({
      command: "server",
      port,
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

async function availablePlaygroundPortRange(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(49152, 65000)
    if (await portRangeAvailable(port, 8)) {
      return port
    }
  }

  return 0
}

async function portRangeAvailable(startPort: number, size: number): Promise<boolean> {
  for (let offset = 0; offset < size; offset++) {
    if (!await portAvailable(startPort + offset)) {
      return false
    }
  }

  return true
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createNetServer()
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(port, "127.0.0.1", () => resolveListen())
    })
    return true
  } catch (error) {
    if (errorHasCode(error, "EADDRINUSE")) {
      return false
    }

    throw error
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
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
