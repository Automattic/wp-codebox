import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "../packages/runtime-core/src/index.js"
import { createPlaygroundRuntimeBackend } from "../packages/runtime-playground/src/index.js"
import { playgroundRunOptionsWithPhpEnv, runtimePhpEnvironment, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-php-env-propagation-"))
const wordpressDirectory = join(root, "wordpress")
const artifactsDirectory = join(root, "artifacts")
await mkdir(wordpressDirectory)
const payloads: Array<{ code?: string; environment?: Record<string, string> }> = []

const upstream = createServer(async (request, response) => {
  const payloadId = request.headers["x-wp-codebox-execution-payload"]
  if (typeof payloadId !== "string") {
    response.writeHead(200)
    response.end("ok")
    return
  }
  const payload = JSON.parse(await readFile(join(artifactsDirectory, "playground-internal-shared", `execution-${payloadId}.json`), "utf8")) as { code?: string; environment?: Record<string, string> }
  payloads.push(payload)
  response.writeHead(200, { "content-type": "text/plain" })
  response.end(payload.code?.includes("echo 'ready'") ? "ready" : String(payload.environment?.DB_PASSWORD ?? ""))
})

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const address = upstream.address()
assert.ok(address && typeof address === "object")
const serverUrl = `http://127.0.0.1:${address.port}`

const cliModule: PlaygroundCliModule = {
  async runCLI() {
    return {
      serverUrl,
      playground: {
        async run() {
          return { text: "" }
        },
      },
      async [Symbol.asyncDispose]() {},
    }
  },
}

const spec = {
  backend: "wordpress-playground" as const,
  artifactsDirectory,
  environment: {
    kind: "wordpress" as const,
    name: "php-env-propagation",
    version: "mounted-wordpress-source",
    phpVersion: "8.4",
    wordpressInstallMode: "do-not-attempt-installing" as const,
    databaseSetup: "external" as const,
    assets: { wordpressDirectory },
    blueprint: {},
  },
  policy: {
    network: "deny" as const,
    filesystem: "sandbox" as const,
    commands: ["wordpress.run-php"],
    secrets: "none" as const,
    approvals: "never" as const,
  },
  runtimeEnv: { DB_HOST: "127.0.0.1", DB_PORT: "33061", DB_USER: "runtime", DB_NAME: "runtime" },
  secretEnv: { DB_PASSWORD: "connector-secret" },
  secretEnvTargets: { DB_PASSWORD: "DB_PASSWORD" },
}

assert.equal(playgroundRunOptionsWithPhpEnv({ code: "<?php echo 1;" }, undefined).env, undefined)
assert.deepEqual(playgroundRunOptionsWithPhpEnv({ code: "<?php echo 1;", env: { EXTRA: "1" } }, { DB_PASSWORD: "secret" }).env, {
  EXTRA: "1",
  DB_PASSWORD: "secret",
})
assert.equal(runtimePhpEnvironment(spec)?.DB_PASSWORD, "connector-secret")

const runtime = await createRuntime(spec, createPlaygroundRuntimeBackend({ cliModule }))

try {
  const execution = await runtime.execute({
    command: "wordpress.run-php",
    args: ["bootstrap=none", "code=<?php echo getenv('DB_PASSWORD');"],
    processIdentity: "phpunit-one",
  })
  const commandPayload = payloads.find((payload) => payload.code?.includes("getenv('DB_PASSWORD')"))
  assert.equal(commandPayload?.environment?.DB_PASSWORD, "connector-secret", "isolated PHPUnit request workers must receive connector secrets")
  assert.equal(execution.stdout, "connector-secret")
} finally {
  await runtime.destroy()
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
  await rm(root, { recursive: true, force: true })
}

console.log("playground cli php env propagation ok")
