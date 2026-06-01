import { playgroundBlueprint } from "./blueprint.js"
import { PlaygroundCliExitError } from "./playground-command-errors.js"
import { PlaygroundPreviewPortUnavailableError, assertPreviewPortAvailable, errorHasCode, withPreviewProxy, type PlaygroundCliServer } from "./preview-server.js"
import type { MountSpec, RuntimeCreateSpec } from "@chubes4/wp-codebox-core"
import { randomInt } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createServer as createNetServer } from "node:net"
import { resolveWordPressRelease } from "@wp-playground/wordpress"

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

  await validatePlaygroundWordPressArchiveCache(spec.environment.version)

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

export interface PlaygroundWordPressArchiveCacheValidation {
  version: string
  sourceUrl: string
  invalidArchives: Array<{
    path: string
    size: number
    reason: string
    deleted: boolean
  }>
}

export async function validatePlaygroundWordPressArchiveCache(versionQuery: string | undefined, cacheDirectory = join(homedir(), ".wordpress-playground")): Promise<PlaygroundWordPressArchiveCacheValidation> {
  const release = await resolveWordPressRelease(versionQuery)
  const version = String(release.version)
  const sourceUrl = String(release.releaseUrl)
  const archivePaths = [
    join(cacheDirectory, `${version}.zip`),
    join(cacheDirectory, `prebuilt-wp-content-for-wp-${version}.zip`),
  ]
  const invalidArchives: PlaygroundWordPressArchiveCacheValidation["invalidArchives"] = []

  for (const archivePath of archivePaths) {
    if (!existsSync(archivePath)) {
      continue
    }

    const archiveStat = await stat(archivePath)
    const reason = await invalidZipReason(archivePath, archiveStat.size)
    if (!reason) {
      continue
    }

    try {
      await unlink(archivePath)
      invalidArchives.push({ path: archivePath, size: archiveStat.size, reason, deleted: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Corrupt cached WordPress archive could not be removed: ${archivePath} (size: ${archiveStat.size} bytes, requested WordPress version: ${versionQuery ?? "latest"}, resolved WordPress version: ${version}, source URL: ${sourceUrl}, validation: ${reason}, unlink error: ${message})`)
    }
  }

  return { version, sourceUrl, invalidArchives }
}

async function invalidZipReason(archivePath: string, size: number): Promise<string | undefined> {
  if (size < 22) {
    return "too small to be a zip archive"
  }

  const header = await readFile(archivePath, { encoding: null, flag: "r" }).then((buffer) => buffer.subarray(0, 4))
  if (header.length < 4) {
    return "missing zip header"
  }

  if (header[0] !== 0x50 || header[1] !== 0x4b) {
    return `unexpected zip header ${header.toString("hex")}`
  }

  if (![0x03, 0x05, 0x07].includes(header[2])) {
    return `unexpected zip header ${header.toString("hex")}`
  }

  return undefined
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
  const activeHandles = activeProcessHandles()
  process.exit = ((code?: string | number | null | undefined): never => {
    const exitCode = typeof code === "number" ? code : 1
    throw new PlaygroundCliExitError(exitCode)
  }) as typeof process.exit

  try {
    return await callback()
  } catch (error) {
    await disposeNewProcessHandles(activeHandles)
    throw error
  } finally {
    process.exit = exit
  }
}

function activeProcessHandles(): Set<unknown> {
  const getActiveHandles = (process as typeof process & { _getActiveHandles?: () => unknown[] })._getActiveHandles
  return new Set(getActiveHandles ? getActiveHandles.call(process) : [])
}

async function disposeNewProcessHandles(before: Set<unknown>): Promise<void> {
  const handles = [...activeProcessHandles()].filter((handle) => !before.has(handle))
  await Promise.all(handles.map(disposeProcessHandle))
}

async function disposeProcessHandle(handle: unknown): Promise<void> {
  const candidate = handle as {
    close?: (callback?: (error?: Error) => void) => unknown
    destroy?: () => unknown
    unref?: () => unknown
  }

  try {
    if (typeof candidate.close === "function") {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (!settled) {
            settled = true
            resolve()
          }
        }
        const result = candidate.close?.(finish)
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).then(finish, finish)
        }
        setTimeout(finish, 1000).unref()
      })
      return
    }

    if (typeof candidate.destroy === "function") {
      candidate.destroy()
    }

    if (typeof candidate.unref === "function") {
      candidate.unref()
    }
  } catch {
    // The original Playground boot failure is the actionable error.
  }
}
