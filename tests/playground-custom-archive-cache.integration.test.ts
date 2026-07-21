import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-playground-cache-lifecycle-"))
const environmentNames = ["WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR", "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_AGE_MS", "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT", "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_LEASE_MS"] as const
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]))
const zip = Buffer.alloc(22)
zip.set([0x50, 0x4b, 0x05, 0x06])
const staleBeforeDownload = join(root, "custom-stale-before-download.zip")
let requestObservedAfterCleanup = false
const source = createServer((_request, response) => {
  requestObservedAfterCleanup = !existsSync(staleBeforeDownload)
  response.writeHead(200, { "content-type": "application/zip", "content-length": String(zip.length) })
  response.end(zip)
})
await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve))
const address = source.address()
if (!address || typeof address === "string") throw new Error("archive source did not bind")
const archiveUrl = `http://127.0.0.1:${address.port}/wordpress.zip`
const progress: Array<Record<string, unknown>> = []
const warnings: string[] = []
const originalWarn = console.warn

const spec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: { version: archiveUrl, phpVersion: "8.4", blueprint: {} },
  policy: { network: "deny", filesystem: "none", commands: ["wordpress.run-php"], secrets: "none", approvals: "never" },
}
const cliModule: PlaygroundCliModule = {
  async runCLI() {
    const names = await readdir(root)
    assert.ok(names.some((name) => name.endsWith(".zip.refs")), "startup must hold an archive lease before Playground consumes it")
    return {
      serverUrl: "http://127.0.0.1:65535",
      playground: { async run() { return { text: "" } } },
      async [Symbol.asyncDispose]() {},
    }
  },
}

try {
  process.env.WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR = root
  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_AGE_MS = "0"
  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT = "0"
  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_LEASE_MS = "300"
  await writeFile(staleBeforeDownload, Buffer.alloc(8_192, "s"))
  await utimes(staleBeforeDownload, 1, 1)

  const server = await startPlaygroundCliServer(spec, [], { cliModule, onProgress(event) { progress.push(event as unknown as Record<string, unknown>) } })
  assert.equal(requestObservedAfterCleanup, true, "bounded maintenance must run before resolving or downloading the next archive")
  await new Promise((resolve) => setTimeout(resolve, 0))
  const connecting = progress.find((event) => event.phase === "preview:connecting-client")
  const cacheValidation = (connecting?.detail as Record<string, unknown> | undefined)?.cacheValidation as Record<string, unknown> | undefined
  assert.equal((cacheValidation?.retention as Record<string, unknown> | undefined)?.schema, "wp-codebox/playground-custom-archive-cache-maintenance/v1")
  assert.equal((cacheValidation?.retention as Record<string, unknown>).removedCount, 1)
  assert.equal(((cacheValidation?.retention as Record<string, unknown>).activeProtection as Record<string, unknown>).referenceCount, 0)
  console.warn = (message?: unknown) => { warnings.push(String(message)) }
  await symlink(root, join(root, "custom-teardown-warning.zip.refs"))
  await server[Symbol.asyncDispose]()
  assert.ok(warnings.some((warning) => warning.includes("custom-archive-refs-not-directory")), "successful teardown maintenance diagnostics must emit bounded warning evidence")
  assert.deepEqual((await readdir(root)).filter((name) => /^custom-.*\.zip(?:\.(?:refs|lock))?$/.test(name)), [], "teardown must release and retain no zero-bound custom cache entries or sidecars")

  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT = "invalid"
  const invalidProgress: Array<Record<string, unknown>> = []
  const invalidServer = await startPlaygroundCliServer(spec, [], { cliModule, onProgress(event) { invalidProgress.push(event as unknown as Record<string, unknown>) } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const invalidConnecting = invalidProgress.find((event) => event.phase === "preview:connecting-client")
  const invalidValidation = (invalidConnecting?.detail as Record<string, unknown>).cacheValidation as Record<string, unknown>
  const diagnostics = invalidValidation.retentionDiagnostics as Array<Record<string, unknown>>
  assert.equal(diagnostics[0]?.code, "playground-custom-archive-cache-maintenance-failed")
  await invalidServer[Symbol.asyncDispose]()
  assert.ok(warnings.some((warning) => warning.includes("playground-custom-archive-cache-maintenance-failed")), "teardown policy failures must emit a bounded warning")

  console.log("playground custom archive startup and teardown integration passed")
} finally {
  console.warn = originalWarn
  for (const name of environmentNames) {
    const value = originalEnvironment[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await new Promise<void>((resolve, reject) => source.close((error) => error ? reject(error) : resolve()))
  await rm(root, { recursive: true, force: true })
}
