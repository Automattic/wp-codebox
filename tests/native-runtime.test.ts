import assert from "node:assert/strict"
import { createRuntime, type ArtifactBundle, type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { createDockerNativeRuntimeDriver, createNativeRuntimeBackend, type NativeRuntimeDriver, type NativeRuntimeProvenance } from "@automattic/wp-codebox-native"

const provenance: NativeRuntimeProvenance = {
  schema: "wp-codebox/native-runtime-provenance/v1",
  backend: "wordpress-native",
  php: { version: "8.4.1", sapi: "fpm-fcgi" },
  container: { image: "example.test/php", digest: `sha256:${"a".repeat(64)}`, containment: "required" },
  opcache: { enabled: true, persistent: true, evidence: { status: { opcache_enabled: true } } },
  httpConcurrency: { workers: 2, model: "php-fpm" },
  database: { integration: "managed-runtime-service", disposable: true },
  browser: { authentication: "fixture-only", credentials: "runtime-generated" },
  benchmarks: { coldStartup: true, warmNoopPhp: true, dynamicWordPressRequest: true },
  representative: { scope: "local", productionRum: false },
}

const spec: RuntimeCreateSpec = {
  backend: "wordpress-native",
  environment: { kind: "wordpress", name: "WordPress", version: "6.8", phpVersion: "8.4" },
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.run-php", "wordpress.browser-actions", "wordpress.bench"], secrets: "none", approvals: "never" },
}

function driver(calls: string[]): NativeRuntimeDriver {
  return {
    async create() { calls.push("create"); return provenance },
    async recordProvenance(value) {
      calls.push(`provenance:${value.php.version}`)
      return { path: "runtime/native-runtime-provenance.json", sha256: "b".repeat(64) }
    },
    async mount() { calls.push("mount") },
    async execute(value: ExecutionSpec) {
      calls.push(`execute:${value.command}`)
      return { id: "command", command: value.command, args: value.args ?? [], exitCode: 0, stdout: "ok", stderr: "", startedAt: "2026-09-03T00:00:00.000Z", finishedAt: "2026-09-03T00:00:00.001Z" }
    },
    async observe() { calls.push("observe"); return { type: "browser-result", data: { authenticated: true }, observedAt: "2026-09-03T00:00:00.000Z" } },
    async snapshot() { calls.push("snapshot"); return { id: "snapshot", createdAt: "2026-09-03T00:00:00.000Z", metadata: {} } },
    async collectArtifacts() { calls.push("artifacts"); return {} as ArtifactBundle },
    async destroy() { calls.push("destroy") },
  }
}

const calls: string[] = []
const runtime = await createRuntime(spec, createNativeRuntimeBackend({ driver: driver(calls) }))
assert.deepEqual(calls, ["create", "provenance:8.4.1"])
assert.equal((await runtime.info()).backend, "wordpress-native")
await runtime.mount({ type: "directory", source: "/fixture", target: "/var/www/html/wp-content/plugins/fixture", mode: "readonly" })
await runtime.execute({ command: "wordpress.run-php", args: ["code=<?php echo 'ok';"] })
await runtime.execute({ command: "wordpress.browser-actions", args: ["auth=wordpress-admin", "actor=fixture-admin"] })
await runtime.execute({ command: "wordpress.bench", args: ["workloads-json=[]"] })
assert.deepEqual((await runtime.observe({ type: "browser-result" })).data, { authenticated: true })
assert.deepEqual(calls.slice(2), ["mount", "execute:wordpress.run-php", "execute:wordpress.browser-actions", "execute:wordpress.bench", "observe"])
await assert.rejects(() => runtime.execute({ command: "wordpress.wp-cli" }), /not allowed/)
await assert.rejects(() => runtime.execute({ command: "wordpress.browser-actions" }), /require runtime fixture authentication/)
await Promise.all([runtime.destroy(), runtime.destroy()])
assert.equal(calls.filter((call) => call === "destroy").length, 1)
assert.equal((await runtime.info()).status, "destroyed")
await assert.rejects(() => runtime.execute({ command: "wordpress.run-php" }), /destroyed/)

const invalidCalls: string[] = []
const invalidDriver = driver(invalidCalls)
invalidDriver.create = async () => ({ ...provenance, httpConcurrency: { workers: 1, model: "php-fpm" } })
await assert.rejects(() => createRuntime(spec, createNativeRuntimeBackend({ driver: invalidDriver })), /concurrent HTTP worker model/)
assert.deepEqual(invalidCalls, ["destroy"])

const incompleteBenchmarkCalls: string[] = []
const incompleteBenchmarkDriver = driver(incompleteBenchmarkCalls)
incompleteBenchmarkDriver.create = async () => ({ ...provenance, benchmarks: { ...provenance.benchmarks, warmNoopPhp: false } })
await assert.rejects(() => createRuntime(spec, createNativeRuntimeBackend({ driver: incompleteBenchmarkDriver })), /benchmark coverage/)
assert.deepEqual(incompleteBenchmarkCalls, ["destroy"])

const dockerCalls: string[] = []
const docker = createDockerNativeRuntimeDriver({
  temporaryDirectory: () => "/tmp",
  async fetch(url) { return { status: 200, body: url.includes("install.php") ? "Success! Log In" : "fixture" } },
  async run(command, args) {
    dockerCalls.push(`${command} ${args.join(" ")}`)
    if (args[0] === "port") return { stdout: "127.0.0.1:49152\n", stderr: "" }
    if (args.some((arg) => arg.includes("PHP_VERSION"))) return { stdout: "8.4.1\napache2handler", stderr: "" }
    if (args.some((arg) => arg.includes("opcache_get_configuration()"))) return { stdout: "{\"directives\":{\"opcache.enable\":true}}", stderr: "" }
    if (args.some((arg) => arg.includes("get_user_by"))) return { stdout: "ready", stderr: "" }
    return { stdout: "ok", stderr: "" }
  },
})
const dockerProvenance = await docker.create(spec)
assert.equal(dockerProvenance.container.containment, "required")
assert.equal(dockerProvenance.httpConcurrency.workers, 2)
assert.equal(dockerProvenance.php.sapi, "apache2handler")
assert.ok(dockerCalls.some((call) => call.includes("--platform linux/amd64") && call.includes("mariadb:11.4@sha256:8fade42367c1d0505a2c06cfacd411e1bd81c28995183d00935e09b702fd0042")))
assert.ok(dockerCalls.some((call) => call.includes("--platform linux/amd64") && call.includes("wordpress:php8.4-apache@sha256:b5ad1a1b6fe6f1232d27a6effb0abc45cf71dcac6d6aba0db7d6fcaec047ffb3")))
await docker.recordProvenance(dockerProvenance)
await docker.mount({ type: "directory", source: "/fixture", target: "/wordpress/wp-content/plugins/fixture", mode: "readonly" })
assert.ok(dockerCalls.some((call) => call.includes("cp /fixture/. ") && call.includes(":/var/www/html/wp-content/plugins/fixture")))
assert.match((await docker.execute({ command: "wordpress.run-php", args: ["code=echo 'ok';"] })).stdout, /ok/)
const benchmark = await docker.execute({ command: "wordpress.bench" })
assert.match(benchmark.stdout, /warmNoopPhpMs/)
const nativeArtifacts = await docker.collectArtifacts()
assert.match(nativeArtifacts.commandsPath, /files\/native\/commands\.json$/)
await Promise.all([docker.destroy(), docker.destroy()])
assert.equal(dockerCalls.filter((call) => call.startsWith("docker network rm ")).length, 1)

console.log("native runtime adapter ok")
