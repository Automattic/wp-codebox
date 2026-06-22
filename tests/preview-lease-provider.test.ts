import assert from "node:assert/strict"
import { startPlaygroundCliServer } from "../packages/runtime-playground/src/playground-cli-runner.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"
import type { RuntimeCreateSpec, RuntimePreviewLeaseProvider } from "../packages/runtime-core/src/index.js"

const baseSpec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: {
    version: "mounted-wordpress-source",
    wordpressInstallMode: "do-not-attempt-installing",
    assets: { wordpressDirectory: "/tmp/wordpress" },
    blueprint: {},
  },
  policy: {
    network: "deny",
    filesystem: "readwrite-mounts",
    commands: [],
    secrets: "none",
    approvals: "never",
  },
}

function cliModule(disposed: { value: boolean }) {
  return {
    async runCLI(): Promise<PlaygroundCliServer> {
      return {
        playground: {
          async run() {
            return { text: "" }
          },
        },
        serverUrl: "http://127.0.0.1:65535",
        async [Symbol.asyncDispose]() {
          disposed.value = true
        },
      }
    },
  }
}

{
  const calls: string[] = []
  const disposed = { value: false }
  let acquiredLocalUrl = ""
  let releasedStatus = ""
  const provider: RuntimePreviewLeaseProvider = {
    acquire(request) {
      calls.push("acquire")
      acquiredLocalUrl = request.localUrl
      return {
        schema: "wp-codebox/preview-lease/v1",
        public_url: "https://preview.example.test/site",
        local_url: request.localUrl,
        lease: { id: "lease-1", status: "active", provider: "test-provider" },
      }
    },
    probe(lease) {
      calls.push("probe")
      return {
        status: "reachable",
        lease: {
          ...lease,
          reachability: { status: "reachable", checked_at: "2026-06-22T00:00:00.000Z" },
        },
      }
    },
    release(_lease, request) {
      calls.push("release")
      releasedStatus = request.status
    },
  }

  const server = await startPlaygroundCliServer({ ...baseSpec, preview: { leaseProvider: provider } }, [], { cliModule: cliModule(disposed) })
  assert.deepEqual(calls, ["acquire", "probe"])
  assert.equal(server.previewLease?.public_url, "https://preview.example.test/site")
  assert.equal(server.previewLease?.reachability?.status, "reachable")
  assert.match(acquiredLocalUrl, /^http:\/\/127\.0\.0\.1:/)

  await server[Symbol.asyncDispose]()
  assert.deepEqual(calls, ["acquire", "probe", "release"])
  assert.equal(releasedStatus, "released")
  assert.equal(disposed.value, true)
}

{
  const calls: string[] = []
  const disposed = { value: false }
  const provider: RuntimePreviewLeaseProvider = {
    acquire(request) {
      calls.push("acquire")
      return {
        schema: "wp-codebox/preview-lease/v1",
        public_url: "https://preview.example.test/site",
        local_url: request.localUrl,
        lease: { id: "lease-2", status: "active", provider: "test-provider" },
      }
    },
    probe() {
      calls.push("probe")
      return { status: "unreachable" }
    },
    release(_lease, request) {
      calls.push(`release:${request.status}:${request.reason}`)
    },
  }

  await assert.rejects(
    startPlaygroundCliServer({ ...baseSpec, preview: { leaseProvider: provider } }, [], { cliModule: cliModule(disposed) }),
    /Preview lease probe reported unreachable preview/,
  )
  assert.deepEqual(calls, ["acquire", "probe", "release:failed:probe-failed"])
  assert.equal(disposed.value, true)
}

console.log("preview lease provider lifecycle ok")
