import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:net"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const port = await reserveFreePort()
const publicUrl = "https://preview-public.example.test"
const child = spawn(process.execPath, [
  "packages/cli/dist/index.js",
  "run",
  "--mount",
  "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
  "--command",
  "wordpress.run-php",
  "--arg",
  "code=update_option('permalink_structure', '/%postname%/'); flush_rewrite_rules();",
  "--preview-port",
  String(port),
  "--preview-public-url",
  publicUrl,
  "--preview-hold",
  "20s",
  "--json",
], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
const exitPromise = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))

let stdout = ""
let stderr = ""
child.stdout.setEncoding("utf8")
child.stderr.setEncoding("utf8")
child.stdout.on("data", (chunk) => { stdout += chunk })
child.stderr.on("data", (chunk) => { stderr += chunk })

try {
  const location = await waitForCanonicalRedirect(port)
  assert.equal(location, `${publicUrl}/hello-world`)
  assert.ok(!location.includes("127.0.0.1"), "canonical redirect must not emit loopback host")
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM")
  }
}

const exitCode = await exitPromise
assert.ok(exitCode === 0 || exitCode === null, `wp-codebox exited with ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`)

async function waitForCanonicalRedirect(listenPort: number): Promise<string> {
  const deadline = Date.now() + 18000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${listenPort}/hello-world`, { redirect: "manual" })
      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location) {
        return new URL(location, publicUrl).toString()
      }
      lastError = new Error(`Unexpected response ${response.status} with location ${location ?? "<none>"}`)
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
