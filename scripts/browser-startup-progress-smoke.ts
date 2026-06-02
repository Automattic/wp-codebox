import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime, type BrowserStartupProgressEvent, type LifecycleEvent } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-browser-startup-progress-"))

try {
  const progress: BrowserStartupProgressEvent[] = []
  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: {
        kind: "wordpress",
        name: "browser-startup-progress-smoke",
        version: "7.0",
        blueprint: {
          steps: [
            { step: "installPlugin", pluginZipFile: { resource: "literal", name: "example-plugin.zip" } },
            { step: "activatePlugin", pluginPath: "example-plugin/example-plugin.php" },
          ],
        },
      },
      policy: runtimePolicy(),
      artifactsDirectory,
      metadata: {
        runtime: { version: "0.0.0" },
        task: { kind: "browser-startup-progress-smoke" },
      },
      onBrowserStartupProgress: (event) => progress.push(event),
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    await assert.rejects(
      () => runtime.execute({ command: "wordpress.run-php", args: ["code=echo 'progress smoke';"] }),
      /Playground CLI exited|Blueprint|Invalid/i,
      "fixture blueprint dependency should fail after emitting startup progress",
    )
  } finally {
    await runtime.destroy().catch(() => undefined)
  }

  assertProgressEvent(progress, "preview:start", "running")
  assertProgressEvent(progress, "preview:loading-client", "running")
  assertProgressEvent(progress, "preview:loading-wordpress", "running")
  assertProgressEvent(progress, "preview:applying-blueprint", "running")
  assertProgressEvent(progress, "preview:installing-dependencies", "running")
  assertProgressEvent(progress, "preview:activating-dependencies", "running")
  assertProgressEvent(progress, "preview:error", "failed")
  assertUserSafeLabels(progress)

  const readyProgress: BrowserStartupProgressEvent[] = []
  const readyRuntime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "browser-startup-ready-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: runtimePolicy(),
      artifactsDirectory,
      metadata: {
        runtime: { version: "0.0.0" },
        task: { kind: "browser-startup-ready-smoke" },
      },
      onBrowserStartupProgress: (event) => readyProgress.push(event),
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    const execution = await readyRuntime.execute({ command: "wordpress.run-php", args: ["code=echo 'ready';"] })
    assert.equal(execution.stdout, "ready")
    const lifecycle = await readyRuntime.observe({ type: "runtime-events" })
    const lifecycleEvents = lifecycle.data as LifecycleEvent[]
    assert.ok(lifecycleEvents.some((event) => event.type === "runtime.browser-startup-progress"), "progress should be recorded in lifecycle events")
  } finally {
    await readyRuntime.destroy()
  }

  assertProgressEvent(readyProgress, "preview:start", "running")
  assertProgressEvent(readyProgress, "preview:loading-client", "running")
  assertProgressEvent(readyProgress, "preview:loading-wordpress", "running")
  assertProgressEvent(readyProgress, "preview:connecting-client", "running")
  assertProgressEvent(readyProgress, "preview:ready", "complete")
  assertUserSafeLabels(readyProgress)

  const occupiedPort = await reserveFreePort()
  const server = await listenOnPort(occupiedPort)
  const errorProgress: BrowserStartupProgressEvent[] = []
  const portRuntime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "browser-startup-port-error-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: runtimePolicy(),
      artifactsDirectory,
      metadata: {
        runtime: { version: "0.0.0" },
        task: { kind: "browser-startup-port-error-smoke" },
      },
      preview: { port: occupiedPort },
      onBrowserStartupProgress: (event) => errorProgress.push(event),
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    await assert.rejects(
      () => portRuntime.execute({ command: "wordpress.run-php", args: ["code=echo 'port';"] }),
      /preview-port|EADDRINUSE|unavailable/i,
    )
  } finally {
    await portRuntime.destroy().catch(() => undefined)
    await closeServer(server)
  }

  assertProgressEvent(errorProgress, "preview:start", "running")
  assertProgressEvent(errorProgress, "preview:error", "failed")
  assert.equal(errorProgress.at(-1)?.detail?.error && typeof errorProgress.at(-1)?.detail?.error, "object")

  console.log("Browser startup progress smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}

function runtimePolicy() {
  return {
    network: "deny" as const,
    filesystem: "readwrite-mounts" as const,
    commands: ["wordpress.run-php"],
    secrets: "none" as const,
    approvals: "never" as const,
  }
}

function assertProgressEvent(events: BrowserStartupProgressEvent[], phase: BrowserStartupProgressEvent["phase"], status: BrowserStartupProgressEvent["status"]): void {
  const event = events.find((candidate) => candidate.phase === phase && candidate.status === status)
  assert.ok(event, `expected ${phase} ${status} progress event`)
  assert.equal(event?.schema, "wp-codebox/browser-startup-progress/v1")
  assert.equal(typeof event?.elapsed_ms, "number")
}

function assertUserSafeLabels(events: BrowserStartupProgressEvent[]): void {
  const unsafe = /codebox|playground|sandbox|runtime|blueprint|plugin/i
  for (const event of events) {
    assert.ok(event.label, `expected ${event.phase} to include a product label`)
    assert.doesNotMatch(event.label ?? "", unsafe)
  }
}

async function reserveFreePort(): Promise<number> {
  const server = await listenOnPort(0)
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await closeServer(server)
  return port
}

async function listenOnPort(port: number): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(port, "127.0.0.1", () => resolveListen())
  })
  return server
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}
