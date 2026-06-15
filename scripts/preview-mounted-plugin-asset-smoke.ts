import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(`${tmpdir()}/wp-codebox-preview-plugin-asset-`)
const port = await reserveFreePort()
const publicHost = "preview-public.example.test"
const publicUrl = `https://${publicHost}`
const previewReadyTimeoutMs = 75_000

await writeFile(`${workspace}/simple-plugin.php`, "<?php\n/** Plugin Name: Preview Asset Smoke */\n")
await writeFile(`${workspace}/probe.js`, "window.__wpCodeboxPreviewAssetSmoke = true;\n")

const child = spawn(process.execPath, [
  "packages/cli/dist/index.js",
  "run",
  "--mount",
  `${workspace}:/wordpress/wp-content/plugins/preview-asset-smoke`,
  "--command",
  "wordpress.run-php",
  "--arg",
  "code=echo 'ready';",
  "--preview-port",
  String(port),
  "--preview-bind",
  "127.0.0.1",
  "--preview-public-url",
  publicUrl,
  "--preview-hold",
  "60s",
  "--json",
], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
const exitPromise = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))

let stdout = ""
let stderr = ""
let pendingError: unknown

try {
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })

  try {
    await assertMountedPluginAsset({ origin: `http://127.0.0.1:${port}`, host: publicHost })
    await assertMountedPluginAsset({ origin: `http://[::1]:${port}`, host: publicHost })
  } catch (error) {
    pendingError = error
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
    }
  }

  const exitCode = await exitPromise
  assert.ok(exitCode === 0 || exitCode === null, `wp-codebox exited with ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}

if (pendingError) {
  throw pendingError
}

console.log("Preview mounted plugin asset smoke passed")

async function assertMountedPluginAsset({ origin, host }: { origin: string; host: string }): Promise<void> {
  const response = await waitForMountedPluginAsset(origin, host)
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /javascript|text\/plain|application\/octet-stream/)
  assert.match(body, /__wpCodeboxPreviewAssetSmoke/)
}

async function waitForMountedPluginAsset(origin: string, host: string): Promise<Response> {
  const deadline = Date.now() + previewReadyTimeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/wp-content/plugins/preview-asset-smoke/probe.js`, {
        redirect: "manual",
        headers: {
          host,
          "x-forwarded-host": host,
          "x-forwarded-port": "443",
          "x-forwarded-proto": "https",
        },
      })
      if (response.status === 200) {
        return response
      }
      const body = await response.text().catch(() => "")
      lastError = new Error(`Unexpected asset response ${response.status}: ${body.slice(0, 200)}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250))
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function reserveFreePort(): Promise<number> {
  const server = await listenOnPort(0)
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const reservedPort = address.port
  await closeServer(server)
  return reservedPort
}

async function listenOnPort(listenPort: number): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(listenPort, "127.0.0.1", () => resolveListen())
  })
  return server
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}
