import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-preview-port-"))

try {
  const runPort = await reserveFreePort()
  const runOutput = await runCliJson([
    "run",
    "--mount",
    "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
    "--command",
    "wordpress.run-php",
    "--arg",
    "code-file=./examples/simple-plugin/probe.php",
    "--artifacts",
    artifactsDirectory,
    "--preview-port",
    String(runPort),
    "--preview-public-url",
    "https://run-preview.example.test/",
    "--json",
  ])
  assert.equal(runOutput.success, true)
  assert.equal(new URL(runOutput.artifacts.preview.localUrl).port, String(runPort))
  assert.equal(runOutput.artifacts.preview.url, "https://run-preview.example.test/")

  const recipePort = await reserveFreePort()
  const recipeOutput = await runCliJson([
    "recipe-run",
    "--recipe",
    "./examples/recipes/seeded-plugin-workspace.json",
    "--artifacts",
    artifactsDirectory,
    "--preview-port",
    String(recipePort),
    "--json",
  ])
  assert.equal(recipeOutput.success, true)
  assert.equal(new URL(recipeOutput.artifacts.preview.url).port, String(recipePort))
  assert.equal(recipeOutput.artifacts.preview.status, "expired-on-completion")

  await assert.rejects(
    () => runCliJson([
      "run",
      "--mount",
      "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
      "--command",
      "wordpress.run-php",
      "--arg",
      "code-file=./examples/simple-plugin/probe.php",
      "--artifacts",
      artifactsDirectory,
      "--preview-port",
      String(recipePort),
      "--json",
    ], recipePort),
    (error) => {
      const childError = error as { stdout?: string; stderr?: string }
      assert.match(`${childError.stdout ?? ""}\n${childError.stderr ?? ""}`, /EADDRINUSE/)
      assert.match(`${childError.stdout ?? ""}\n${childError.stderr ?? ""}`, new RegExp(`--preview-port ${recipePort}`))
      return true
    },
  )

  await assert.rejects(
    () => runCliJson([
      "run",
      "--mount",
      "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
      "--command",
      "wordpress.run-php",
      "--preview-port",
      "0",
      "--json",
    ]),
    (error) => {
      const childError = error as { stdout?: string; stderr?: string }
      assert.match(`${childError.stdout ?? ""}\n${childError.stderr ?? ""}`, /--preview-port must be an integer between 1 and 65535/)
      return true
    },
  )
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}

async function runCliJson(args: string[], heldPort?: number): Promise<any> {
  let server: Server | undefined
  if (heldPort !== undefined) {
    server = await listenOnPort(heldPort)
  }

  try {
    const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", ...args], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024 * 10,
    })
    return JSON.parse(stdout)
  } finally {
    await closeServer(server)
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
