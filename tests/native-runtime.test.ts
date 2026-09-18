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
  wordPressRoot: { source: "image-default" },
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
const dockerArgs: string[][] = []
const docker = createDockerNativeRuntimeDriver({
  temporaryDirectory: () => "/tmp",
  async fetch(url) { return { status: 200, body: url.includes("install.php") ? "Success! Log In" : "fixture" } },
  async run(command, args) {
    dockerArgs.push(args)
    dockerCalls.push(`${command} ${args.join(" ")}`)
    if (args[0] === "inspect") return { stdout: "running\n0\n{\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"49152\"}]}\n", stderr: "" }
    if (args.some((arg) => arg.includes("PHP_VERSION"))) return { stdout: "8.4.1\napache2handler", stderr: "" }
    if (args.some((arg) => arg.includes("opcache_get_configuration()"))) return { stdout: "{\"directives\":{\"opcache.enable\":true}}", stderr: "" }
    if (args.some((arg) => arg.includes("check_connection"))) return { stdout: "ready", stderr: "" }
    if (args.some((arg) => arg.includes("wp_install("))) return { stdout: "ready", stderr: "" }
    return { stdout: "ok", stderr: "" }
  },
})
const dockerProvenance = await docker.create(spec)
assert.equal(dockerProvenance.container.containment, "required")
assert.equal(dockerProvenance.httpConcurrency.workers, 2)
assert.equal(dockerProvenance.php.sapi, "apache2handler")
assert.ok(dockerCalls.some((call) => call.includes("--platform linux/amd64") && call.includes("mariadb:11.4@sha256:8fade42367c1d0505a2c06cfacd411e1bd81c28995183d00935e09b702fd0042")))
assert.ok(dockerCalls.some((call) => call.includes("--platform linux/amd64") && call.includes("wordpress:php8.4-apache@sha256:b5ad1a1b6fe6f1232d27a6effb0abc45cf71dcac6d6aba0db7d6fcaec047ffb3")))
const appRunArgs = dockerArgs.find((args) => args[0] === "run" && args.some((arg) => arg.startsWith("wordpress:php8.4-apache@")))
assert.equal(appRunArgs?.[appRunArgs.indexOf("--publish") + 1], "127.0.0.1:0:80/tcp")
assert.equal(appRunArgs?.[appRunArgs.indexOf("--entrypoint") + 1], "bash")
assert.match(appRunArgs?.at(-1) ?? "", /exec \/usr\/local\/bin\/docker-entrypoint\.sh apache2-foreground/)
assert.equal(dockerArgs.some((args) => args[0] === "port"), false)
// Publishing requires a non-internal network, so the app publishes on its own
// network and joins the internal database network afterwards.
const appNetwork = appRunArgs?.[appRunArgs.indexOf("--network") + 1]
const internalNetwork = dockerArgs.find((args) => args[0] === "network" && args[1] === "create" && args.includes("--internal"))?.at(-1)
assert.ok(appNetwork && internalNetwork && appNetwork !== internalNetwork)
assert.ok(dockerArgs.some((args) => args[0] === "network" && args[1] === "create" && !args.includes("--internal") && args.at(-1) === appNetwork))
assert.ok(dockerArgs.some((args) => args[0] === "network" && args[1] === "connect" && args[2] === internalNetwork))
assert.equal(dockerArgs.find((args) => args[0] === "run" && args.some((arg) => arg.startsWith("mariadb:11.4@")))?.includes(appNetwork), false)
await docker.recordProvenance(dockerProvenance)
await docker.mount({ type: "directory", source: "/fixture", target: "/wordpress/wp-content/plugins/fixture", mode: "readonly" })
assert.ok(dockerCalls.some((call) => call.includes("cp /fixture/. ") && call.includes(":/var/www/html/wp-content/plugins/fixture")))
assert.match((await docker.execute({ command: "wordpress.run-php", args: ["code=echo 'ok';"] })).stdout, /ok/)
const benchmark = await docker.execute({ command: "wordpress.bench" })
assert.match(benchmark.stdout, /warmNoopPhpMs/)
const nativeArtifacts = await docker.collectArtifacts()
assert.match(nativeArtifacts.commandsPath, /files\/native\/commands\.json$/)
await Promise.all([docker.destroy(), docker.destroy()])
assert.deepEqual(dockerArgs.filter((args) => args[0] === "network" && args[1] === "rm").map((args) => args.at(-1)).sort(), [appNetwork, internalNetwork].sort())

const failedDockerArgs: string[][] = []
const failedDocker = createDockerNativeRuntimeDriver({
  temporaryDirectory: () => "/tmp",
  async fetch() { return { status: 200, body: "fixture" } },
  async run(_command, args) {
    failedDockerArgs.push(args)
    if (args[0] === "inspect") return { stdout: "exited\n1\n{\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"49152\"}]}\n", stderr: "" }
    if (args[0] === "logs") return { stdout: "apache2: configuration error", stderr: "" }
    return { stdout: "ok", stderr: "" }
  },
})
await assert.rejects(() => failedDocker.create(spec), /state=exited exitCode=1 portBindings=\{"80\/tcp":\[\{"HostIp":"127\.0\.0\.1","HostPort":"49152"\}\]\}; docker inspect: exited 1 \{"80\/tcp":\[\{"HostIp":"127\.0\.0\.1","HostPort":"49152"\}\]\}; docker logs: apache2: configuration error/)
assert.deepEqual(failedDockerArgs.filter((args) => args[0] === "inspect").map((args) => args.slice(0, 3)), [["inspect", "--format", "{{.State.Status}}\n{{.State.ExitCode}}\n{{json .NetworkSettings.Ports}}"], ["inspect", "--format", "status={{.State.Status}} exitCode={{.State.ExitCode}} ports={{json .NetworkSettings.Ports}}"]])
assert.deepEqual(failedDockerArgs.find((args) => args[0] === "logs")?.slice(0, 3), ["logs", "--tail", "100"])
await failedDocker.destroy()
assert.equal(failedDockerArgs.filter((args) => args[0] === "rm" && args[1] === "-f").length, 2)
assert.equal(failedDockerArgs.filter((args) => args[0] === "network" && args[1] === "rm").length, 2)

const missingBindingDocker = createDockerNativeRuntimeDriver({
  temporaryDirectory: () => "/tmp",
  async fetch() { return { status: 200, body: "fixture" } },
  async run(_command, args) {
    if (args[0] === "inspect") return { stdout: "running\n0\n{\"80/tcp\":null}\n", stderr: "" }
    if (args[0] === "logs") return { stdout: "waiting for database", stderr: "" }
    return { stdout: "ok", stderr: "" }
  },
})
await assert.rejects(() => missingBindingDocker.create(spec), /state=running exitCode=0 portBindings=\{"80\/tcp":null\}.*docker inspect: running 0 \{"80\/tcp":null\}; docker logs: waiting for database/)
await missingBindingDocker.destroy()

// A consumer-supplied WordPress root must be copied into the contained runtime BEFORE
// install and readiness checks, and its source path must be recorded in provenance so
// evidence cannot be confused with the pinned image default.
const customRootArgs: string[][] = []
const customRootDocker = createDockerNativeRuntimeDriver({
  temporaryDirectory: () => "/tmp",
  async fetch() { return { status: 200, body: "fixture" } },
  async run(_command, args) {
    customRootArgs.push(args)
    if (args[0] === "inspect") return { stdout: "running\n0\n{\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"49153\"}]}\n", stderr: "" }
    if (args.some((arg) => arg.includes("PHP_VERSION"))) return { stdout: "8.4.1\napache2handler", stderr: "" }
    if (args.some((arg) => arg.includes("opcache_get_configuration()"))) return { stdout: "{\"directives\":{\"opcache.enable\":true}}", stderr: "" }
    if (args.some((arg) => arg.includes("check_connection"))) return { stdout: "ready", stderr: "" }
    if (args.some((arg) => arg.includes("wp_install("))) return { stdout: "ready", stderr: "" }
    return { stdout: "ok", stderr: "" }
  },
})
const customRootProvenance = await customRootDocker.create({ ...spec, environment: { ...spec.environment, assets: { wordpressDirectory: "/srv/custom-wordpress" } } })
assert.deepEqual(customRootProvenance.wordPressRoot, { source: "directory", path: "/srv/custom-wordpress" })
const copyCallIndex = customRootArgs.findIndex((args) => args[0] === "cp" && args[1] === "/srv/custom-wordpress/." && args[2]?.endsWith(":/var/www/html"))
assert.ok(copyCallIndex >= 0, "expected a docker cp of the custom WordPress root into /var/www/html")
const inspectCallIndex = customRootArgs.findIndex((args) => args[0] === "inspect")
const dbProbeCallIndex = customRootArgs.findIndex((args) => args.some((arg) => arg.includes("check_connection")))
// The copy must precede readiness inspection and the install/database probe.
assert.ok(copyCallIndex < inspectCallIndex && copyCallIndex < dbProbeCallIndex, "custom WordPress root must be copied before readiness checks and install")
await customRootDocker.destroy()

// Browser-action arguments must fail closed with actionable errors before any
// browser is launched, never silently degrading to defaults.
const argProbeDocker = createDockerNativeRuntimeDriver({
  temporaryDirectory: () => "/tmp",
  async fetch() { return { status: 200, body: "fixture" } },
  async run(_command, args) {
    if (args[0] === "inspect") return { stdout: "running\n0\n{\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"49154\"}]}\n", stderr: "" }
    if (args.some((arg) => arg.includes("PHP_VERSION"))) return { stdout: "8.4.1\napache2handler", stderr: "" }
    if (args.some((arg) => arg.includes("opcache_get_configuration()"))) return { stdout: "{\"directives\":{\"opcache.enable\":true}}", stderr: "" }
    if (args.some((arg) => arg.includes("check_connection"))) return { stdout: "ready", stderr: "" }
    if (args.some((arg) => arg.includes("wp_install("))) return { stdout: "ready", stderr: "" }
    return { stdout: "ok", stderr: "" }
  },
})
await argProbeDocker.create(spec)
const baseBrowserArgs = ["auth=wordpress-admin", `steps-json=${JSON.stringify([{ kind: "navigate", url: "/" }])}`]
await assert.rejects(() => argProbeDocker.execute({ command: "wordpress.browser-actions", args: [...baseBrowserArgs, "capture=websocket"] }), /does not support capture=websocket on the native backend; supported: steps, console, errors, network, screenshot, html/)
await assert.rejects(() => argProbeDocker.execute({ command: "wordpress.browser-actions", args: [...baseBrowserArgs, "auth-user-id=7"] }), /can only authenticate as the runtime-generated fixture user id 1/)
await assert.rejects(() => argProbeDocker.execute({ command: "wordpress.browser-actions", args: [...baseBrowserArgs, "auth-user-id=abc"] }), /auth-user-id must be a positive integer/)
await assert.rejects(() => argProbeDocker.execute({ command: "wordpress.browser-actions", args: [...baseBrowserArgs, "timeout=5x"] }), /timeout must be a duration like 500ms or 2s/)
await assert.rejects(() => argProbeDocker.execute({ command: "wordpress.browser-actions", args: [...baseBrowserArgs, "step-timeout=0s"] }), /step-timeout must be a positive duration/)
await argProbeDocker.destroy()

console.log("native runtime adapter ok")
