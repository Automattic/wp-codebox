import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRecipeBuildCommand } from "../packages/cli/src/commands/recipe-build.ts"
import { executeRuntimeServiceProcess, parseLoopbackPort, provisionRuntimeServices, provisionRuntimeServicesForRecipe, RuntimeServiceProvisionError, runtimeServiceEvidenceFromError, runtimeServicePlan, waitForMysqlProtocol, type RuntimeServiceDependencies } from "../packages/cli/src/runtime-services.ts"
import { planWorkspaceRecipe } from "../packages/cli/src/recipe-dry-run.ts"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.ts"
import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.ts"
import { validateWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.ts"

const service = { id: "test-db", kind: "mysql", outputs: { host: "DB_HOST", port: "DB_PORT", password: "DB_PASSWORD" } } as const
const plan = runtimeServicePlan([service])
assert.deepEqual(plan, [{ id: "test-db", kind: "mysql", provider: "docker", version: "mysql:8.4", bind: "loopback", port: "ephemeral", persistentVolume: false, storage: "tmpfs", outputs: service.outputs }])
assert.equal(parseLoopbackPort("127.0.0.1:44001\n"), 44001)
assert.throws(() => parseLoopbackPort("0.0.0.0:3306"), /loopback/)
const auxiliaryServices = [
  { id: "cache", kind: "redis", outputs: { host: "REDIS_HOST", port: "REDIS_PORT", url: "REDIS_URL" } },
  { id: "mail", kind: "smtp", outputs: { host: "SMTP_HOST", port: "SMTP_PORT", httpPort: "SMTP_HTTP_PORT" } },
  { id: "upstream", kind: "http", configuration: { responseStatus: 503, responseBody: "unavailable" }, outputs: { url: "FIXTURE_URL" } },
] satisfies WorkspaceRecipe["inputs"] extends { services?: infer T } ? NonNullable<T> : never
assert.deepEqual(runtimeServicePlan(auxiliaryServices).map(({ kind, version }) => [kind, version]), [["redis", "redis:7.4-alpine"], ["smtp", "axllent/mailpit:v1.27"], ["http", "hashicorp/http-echo:1.0"]])

const valid = validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [service] }, workflow: { steps: [{ command: "wordpress.run-php" }] } })
assert.equal(valid.valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: auxiliaryServices }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, true)
const unsafe = validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [{ ...service, outputs: { port: "bad-name" } }] }, workflow: { steps: [{ command: "wordpress.run-php" }] } })
assert.equal(unsafe.valid, false)
const emptyRootService = { ...service, configuration: { rootAuthentication: "empty-password" as const } }
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [emptyRootService] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, true)
const indexedForeignKeyService = { ...service, configuration: { foreignKeyTargetPolicy: "indexed" as const } }
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [indexedForeignKeyService] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, true)
const diskStorageService = { ...service, configuration: { storage: "disk" as const } }
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [diskStorageService] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, true)
assert.deepEqual(runtimeServicePlan([diskStorageService])[0]?.storage, "disk")
const mariaDbService = { ...service, configuration: { engine: "mariadb" as const, rootAuthentication: "empty-password" as const } }
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [mariaDbService] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, true)
assert.equal(runtimeServicePlan([mariaDbService])[0]?.version, "mariadb:11.4")
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [{ ...service, configuration: { foreignKeyTargetPolicy: "anything" } }] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, false)
assert.deepEqual(buildWordPressPhpunitRecipe({ pluginSlug: "example", services: [emptyRootService] }).inputs?.services, [emptyRootService])
const mysqlPhpunitRecipe = buildWordPressPhpunitRecipe({ pluginSlug: "example", databaseType: "mysql" })
assert.deepEqual(mysqlPhpunitRecipe.inputs?.services, [{ id: "wordpress-database", kind: "mysql", outputs: { host: "DB_HOST", port: "DB_PORT", username: "DB_USER", password: "DB_PASSWORD", database: "DB_NAME" } }])
assert.ok(mysqlPhpunitRecipe.workflow.steps[0].args?.includes("database-type=mysql"))
const sqlitePhpunitRecipe = buildWordPressPhpunitRecipe({ pluginSlug: "example" })
assert.equal(sqlitePhpunitRecipe.inputs?.services, undefined)
assert.equal(sqlitePhpunitRecipe.workflow.steps[0].args?.some((arg) => arg.startsWith("database-type=")), false)
assert.equal(buildWordPressPhpunitRecipe({ pluginSlug: "example", wordpressInstallMode: "do-not-attempt-installing" }).runtime?.wordpressInstallMode, "do-not-attempt-installing")
const builderDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-builder-"))
try {
  const optionsPath = join(builderDirectory, "options.json")
  const recipePath = join(builderDirectory, "recipe.json")
  await writeFile(optionsPath, JSON.stringify({
    pluginSlug: "example",
    phpVersion: "8.3",
    databaseType: "mysql",
    extensions: [{ manifest: "./sodium/manifest.json" }],
    backendPackage: { kind: "playground", source: "./playground-cli", package: "@wp-playground/cli" },
    testRoot: "/home/example/bin/tests/core",
    phpunitXml: "/home/example/bin/tests/core/phpunit.xml",
  }))
  assert.equal(await runRecipeBuildCommand(["phpunit", "--options", optionsPath, "--output", recipePath]), 0)
  const builtRecipe = JSON.parse(await readFile(recipePath, "utf8")) as WorkspaceRecipe
  assert.ok(builtRecipe.workflow.steps[0].args?.includes("test-root=/home/example/bin/tests/core"))
  assert.ok(builtRecipe.workflow.steps[0].args?.includes("phpunit-xml=/home/example/bin/tests/core/phpunit.xml"))
  assert.equal(builtRecipe.runtime?.phpVersion, "8.3")
  assert.equal(builtRecipe.inputs?.services?.[0]?.kind, "mysql")
  assert.ok(builtRecipe.workflow.steps[0].args?.includes("database-type=mysql"))
  assert.deepEqual(builtRecipe.runtime?.extensions, [{ manifest: "./sodium/manifest.json" }])
  assert.deepEqual(builtRecipe.runtime?.backendPackage, { kind: "playground", source: "./playground-cli", package: "@wp-playground/cli" })

  await writeFile(optionsPath, JSON.stringify({ pluginSlug: "example" }))
  assert.equal(await runRecipeBuildCommand(["phpunit", "--options", optionsPath, "--output", recipePath]), 0)
  const defaultRecipe = JSON.parse(await readFile(recipePath, "utf8")) as WorkspaceRecipe
  assert.ok(defaultRecipe.workflow.steps[0].args?.includes("test-root=/wordpress/wp-content/plugins/example/tests"))
  assert.ok(defaultRecipe.workflow.steps[0].args?.includes("phpunit-xml=/wordpress/wp-content/plugins/example/phpunit.xml.dist"))
} finally {
  await rm(builderDirectory, { recursive: true, force: true })
}
const recipe: WorkspaceRecipe = { schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [service] }, workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 'ok';"] }] } }
assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, "recipe.json"), [])
const dryRun = await planWorkspaceRecipe(recipe, process.cwd(), { recipePath: "recipe.json" }, {
  defaultWordPressVersion: "latest",
  resolveExecutionSpec: async (step) => ({ command: step.command, args: step.args ?? [] }),
})
assert.deepEqual(dryRun.services, plan)
const collisions: WorkspaceRecipe = {
  ...recipe,
  distribution: { name: "fixture", wordpress: { root: "/wordpress" }, env: { DB_HOST: "distribution" } },
  inputs: { runtimeEnv: { DB_PORT: "3306" }, secretEnv: ["DB_PASSWORD"], services: [service] },
}
assert.deepEqual(
  (await validateWorkspaceRecipeSemantics(collisions, "recipe.json")).map((issue) => issue.code),
  ["runtime-service-secret-target-collision", "duplicate-runtime-service-env", "duplicate-runtime-service-env", "duplicate-runtime-service-env"],
)

const server = createServer((socket) => socket.end(Buffer.from([1, 0, 0, 0, 10])))
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
await waitForMysqlProtocol("127.0.0.1", address.port, 250)
await new Promise<void>((resolve) => server.close(() => resolve()))
await assert.rejects(waitForMysqlProtocol("127.0.0.1", address.port, 25), /readiness timed out/)

const closingServer = createServer((socket) => socket.end())
await new Promise<void>((resolve) => closingServer.listen(0, "127.0.0.1", resolve))
const closingAddress = closingServer.address()
assert.ok(closingAddress && typeof closingAddress !== "string")
await assert.rejects(waitForMysqlProtocol("127.0.0.1", closingAddress.port, 25), /readiness timed out/, "a pre-handshake close remains retryable instead of leaving an unsettled promise")
await new Promise<void>((resolve) => closingServer.close(() => resolve()))

const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv; signal?: AbortSignal }> = []
const dependencies: RuntimeServiceDependencies = {
  randomBytes: (size) => Buffer.alloc(size, 7),
  async execute(_command, args, options) {
    calls.push({ args, env: options.env, signal: options.signal })
    if (args[0] === "port") return { stdout: "127.0.0.1:41001\n" }
    return { stdout: "" }
  },
  async waitForReady() {},
}
const provisioned = await provisionRuntimeServices([service], { dependencies })
const provisionedPassword = Buffer.alloc(24, 7).toString("base64url")
assert.equal(provisioned.env.DB_PORT, "41001")
assert.equal(provisioned.env.DB_PASSWORD, undefined, "password is excluded from the non-secret output channel")
assert.equal(provisioned.secretEnv.DB_PASSWORD, provisionedPassword)
assert.deepEqual(provisioned.secretEnvTargets, { DB_PASSWORD: "DB_PASSWORD" })
const runCall = calls.find((call) => call.args[0] === "run")
assert.ok(runCall?.args.includes("MYSQL_PASSWORD"))
assert.ok(runCall?.args.includes("127.0.0.1::3306"), "Docker publishes MySQL on a loopback ephemeral port")
assert.deepEqual(runCall?.args.slice(runCall.args.indexOf("--tmpfs"), runCall.args.indexOf("--tmpfs") + 2), ["--tmpfs", "/var/lib/mysql"])
assert.equal(runCall?.args.includes("--volume") || runCall?.args.includes("--mount"), false, "Docker uses no persistent volume")
assert.equal(runCall?.args.some((arg) => arg.includes(provisionedPassword)), false, "credentials never enter Docker argv")
const readinessCall = calls.find((call) => call.args[0] === "exec")
assert.ok(readinessCall?.args.includes("mysql"), "MySQL readiness authenticates against the initialized database")
assert.equal(readinessCall?.args.some((arg) => arg.includes(provisionedPassword)), false, "readiness credentials never enter Docker argv")
assert.equal(readinessCall?.env?.MYSQL_PWD, provisionedPassword, "readiness credentials use the child environment")
assert.equal(JSON.stringify(provisioned.evidence).includes(provisionedPassword), false, "credentials never enter evidence")
assert.equal(runCall?.env?.DOCKER_HOST, process.env.DOCKER_HOST, "Docker provider context is preserved")
assert.equal(calls[0]?.args[0], "image", "the provider checks the image before starting the service")
await provisioned.release()
await provisioned.release()
assert.equal(calls.filter((call) => call.args[0] === "rm").length, 1, "release is idempotent")
assert.deepEqual(calls.find((call) => call.args[0] === "rm")?.args.slice(0, 3), ["rm", "--force", "--volumes"])

const diskCalls: Array<{ args: string[] }> = []
const diskProvisioned = await provisionRuntimeServices([diskStorageService], { dependencies: {
  ...dependencies,
  async execute(command, args, options) {
    diskCalls.push({ args })
    return await dependencies.execute(command, args, options)
  },
} })
assert.deepEqual(diskProvisioned.evidence[0]?.storage, "disk")
const diskRunCall = diskCalls.find((call) => call.args[0] === "run")
assert.deepEqual(diskRunCall?.args.slice(diskRunCall.args.indexOf("--mount"), diskRunCall.args.indexOf("--mount") + 2), ["--mount", "type=volume,destination=/var/lib/mysql"])
assert.equal(diskRunCall?.args.includes("--tmpfs"), false, "disk storage does not allocate a tmpfs datadir")
await diskProvisioned.release()
assert.deepEqual(diskCalls.find((call) => call.args[0] === "rm")?.args.slice(0, 3), ["rm", "--force", "--volumes"], "release removes anonymous Docker volumes")

const missingProviderDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  execute: async (_command, args, options) => await executeRuntimeServiceProcess("wp-codebox-provider-command-that-does-not-exist", args, options),
}
await assert.rejects(provisionRuntimeServices([service], { dependencies: missingProviderDependencies }), (error: unknown) => {
  assert.ok(error instanceof RuntimeServiceProvisionError)
  assert.deepEqual(error.evidence[0]?.diagnostic, {
    code: "provider-unavailable",
    command: "docker",
    cause: { code: "ENOENT", message: "Provider command executable was not found" },
  })
  return true
})
const missingProviderChild = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
  import { executeRuntimeServiceProcess } from "./packages/cli/src/runtime-services.ts";
  await executeRuntimeServiceProcess("wp-codebox-provider-command-that-does-not-exist", [], { timeout: 300_000 }).catch(() => undefined);
`], { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 })
assert.equal(missingProviderChild.error, undefined, `spawn ENOENT child exits without retaining its process timeout: ${missingProviderChild.error?.message ?? ""}`)
assert.equal(missingProviderChild.status, 0, missingProviderChild.stderr)

const failedStartDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    if (args[0] === "run") throw new Error("provider start failed")
    return dependencies.execute(command, args, options)
  },
}
await assert.rejects(provisionRuntimeServices([service], { dependencies: failedStartDependencies }), (error: unknown) => error instanceof RuntimeServiceProvisionError && error.evidence[0]?.diagnostic?.code === "provision-failed")

const failedReadinessDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async waitForReady() { throw new Error("provider readiness failed") },
}
await assert.rejects(provisionRuntimeServices([service], { dependencies: failedReadinessDependencies }), (error: unknown) => error instanceof RuntimeServiceProvisionError && error.evidence[0]?.diagnostic?.code === "readiness-failed")

const unavailableDuringReadinessDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    if (args[0] === "exec" || args[0] === "rm") return await executeRuntimeServiceProcess("wp-codebox-provider-command-that-does-not-exist", args, options)
    return dependencies.execute(command, args, options)
  },
}
await assert.rejects(provisionRuntimeServices([service], { dependencies: unavailableDuringReadinessDependencies }), (error: unknown) => {
  assert.ok(error instanceof RuntimeServiceProvisionError)
  assert.equal(error.evidence[0]?.diagnostic?.code, "provider-unavailable", "cleanup failure does not replace the primary provider failure")
  assert.equal(error.evidence[0]?.teardown, "failed", "failed cleanup remains visible in service evidence")
  return true
})

let ordinaryReadinessAttempts = 0
const retryingReadinessDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    if (args[0] === "exec" && ordinaryReadinessAttempts++ === 0) throw new Error("provider readiness command failed")
    return dependencies.execute(command, args, options)
  },
}
const retriedReadiness = await provisionRuntimeServices([service], { dependencies: retryingReadinessDependencies })
assert.equal(ordinaryReadinessAttempts, 2, "ordinary Docker readiness failures remain retryable")
await retriedReadiness.release()

const emptyRootCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
const emptyRootDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    emptyRootCalls.push({ args, env: options.env })
    return dependencies.execute(command, args, options)
  },
}
const emptyRoot = await provisionRuntimeServices([emptyRootService], { dependencies: emptyRootDependencies })
const emptyRootRun = emptyRootCalls.find((call) => call.args[0] === "run")
assert.ok(emptyRootRun?.args.includes("MYSQL_ALLOW_EMPTY_PASSWORD"), "empty root auth is explicit in the provider plan")
assert.equal(emptyRootRun?.args.includes("MYSQL_ROOT_PASSWORD"), false)
assert.equal(emptyRootRun?.env?.MYSQL_ALLOW_EMPTY_PASSWORD, "yes")
assert.equal(emptyRootRun?.env?.MYSQL_ROOT_PASSWORD, undefined)
await emptyRoot.release()

const indexedForeignKeyCalls: Array<{ args: string[] }> = []
const indexedForeignKeyDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    indexedForeignKeyCalls.push({ args })
    return dependencies.execute(command, args, options)
  },
}
const indexedForeignKey = await provisionRuntimeServices([indexedForeignKeyService], { dependencies: indexedForeignKeyDependencies })
const indexedForeignKeyRun = indexedForeignKeyCalls.find((call) => call.args[0] === "run")
assert.deepEqual(indexedForeignKeyRun?.args.slice(-2), ["mysql:8.4", "--restrict-fk-on-non-standard-key=OFF"], "indexed foreign-key targets opt into the MySQL compatibility mode")
await indexedForeignKey.release()

const auxiliaryCalls: string[][] = []
const auxiliaryDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    auxiliaryCalls.push(args)
    return await dependencies.execute(command, args, options)
  },
}
const auxiliary = await provisionRuntimeServices(auxiliaryServices, { dependencies: auxiliaryDependencies })
assert.equal(auxiliary.env.REDIS_URL, "redis://127.0.0.1:41001")
assert.equal(auxiliary.env.FIXTURE_URL, "http://127.0.0.1:41001")
assert.equal((await auxiliary.control("cache", "pause")).status, "applied")
assert.equal((await auxiliary.control("cache", "resume")).status, "applied")
assert.equal((await auxiliary.control("cache", "stop")).status, "applied")
assert.equal((await auxiliary.control("cache", "start")).status, "applied")
assert.equal((await auxiliary.control("cache", "flush")).status, "applied")
assert.equal((await auxiliary.control("mail", "restart")).status, "applied")
assert.equal((await auxiliary.control("upstream", "latency", { milliseconds: 50 })).status, "unsupported")
assert.ok(auxiliaryCalls.some((args) => args.includes("redis:7.4-alpine")))
assert.ok(auxiliaryCalls.some((args) => args.includes("axllent/mailpit:v1.27")))
assert.ok(auxiliaryCalls.some((args) => args.includes("hashicorp/http-echo:1.0")))
assert.equal(auxiliary.evidence.find((item) => item.id === "cache")?.controls?.length, 5)
await auxiliary.release()

const mariaDbCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
const mariaDbDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    mariaDbCalls.push({ args, env: options.env })
    return dependencies.execute(command, args, options)
  },
}
const mariaDb = await provisionRuntimeServices([mariaDbService], { dependencies: mariaDbDependencies })
const mariaDbRun = mariaDbCalls.find((call) => call.args[0] === "run")
const mariaDbReadiness = mariaDbCalls.find((call) => call.args[0] === "exec")
assert.ok(mariaDbRun?.args.includes("mariadb:11.4"))
assert.ok(mariaDbReadiness?.args.includes("mariadb"), "MariaDB readiness uses the image client")
assert.ok(mariaDbRun?.args.includes("MARIADB_ALLOW_EMPTY_ROOT_PASSWORD"))
assert.equal(mariaDbRun?.env?.MARIADB_ALLOW_EMPTY_ROOT_PASSWORD, "yes")
assert.equal(mariaDbRun?.env?.MYSQL_ALLOW_EMPTY_PASSWORD, undefined)
await mariaDb.release()

const interruptedAfterProvision = new AbortController()
const provisionedBeforeAbort = await provisionRuntimeServices([service], { dependencies, signal: interruptedAfterProvision.signal })
interruptedAfterProvision.abort()
await provisionedBeforeAbort.release()
const cleanupCall = calls.filter((call) => call.args[0] === "rm").at(-1)
assert.equal(cleanupCall?.signal, undefined, "teardown has an independent cleanup context after interruption")

let finishLateProvisioning: (() => void) | undefined
let lateRemoval = false
const lateDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    if (args[0] === "run") await new Promise<void>((resolve) => { finishLateProvisioning = resolve })
    if (args[0] === "rm") lateRemoval = true
    return dependencies.execute(command, args, options)
  },
}
const guardedProvisioning = provisionRuntimeServicesForRecipe([service], async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  throw new Error("recipe timeout")
}, { dependencies: lateDependencies })
while (!finishLateProvisioning) await new Promise<void>((resolve) => setTimeout(resolve, 1))
finishLateProvisioning()
await assert.rejects(guardedProvisioning, /recipe timeout/)
assert.equal(lateRemoval, true, "a timeout waits for and tears down late provisioning")

const absentDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(command, args, options) {
    if (args[0] === "rm") {
      const error = new Error("docker rm failed") as Error & { stderr: string }
      error.stderr = `Error response from daemon: No such container: fixture`
      throw error
    }
    return dependencies.execute(command, args, options)
  },
}
const alreadyAbsent = await provisionRuntimeServices([service], { dependencies: absentDependencies })
await alreadyAbsent.release()
assert.equal(alreadyAbsent.evidence[0]?.teardown, "completed", "an already absent container is idempotently released")

let failedCleanup = false
const failingDependencies: RuntimeServiceDependencies = {
  ...dependencies,
  async execute(_command, args, options) {
    if (args[0] === "port") return { stdout: "127.0.0.1:41001\n" }
    if (args[0] === "rm") { failedCleanup = true; throw new Error("remove failed") }
    return dependencies.execute("docker", args, options)
  },
  async waitForReady() { throw new Error("not ready") },
}
await assert.rejects(provisionRuntimeServices([service], { dependencies: failingDependencies }), (error: unknown) => {
  assert.ok(error instanceof RuntimeServiceProvisionError)
  assert.equal(error.evidence[0]?.readiness, "failed")
  assert.equal(error.evidence[0]?.teardown, "failed")
  assert.equal(error.evidence[0]?.diagnostic?.code, "teardown-failed")
  return true
})
assert.equal(failedCleanup, true)

const controller = new AbortController()
controller.abort()
await assert.rejects(provisionRuntimeServices([service], { dependencies, signal: controller.signal }), (error: unknown) => error instanceof RuntimeServiceProvisionError && error.evidence[0]?.diagnostic?.code === "interrupted")

const nestedEvidence = [{ id: "nested", kind: "mysql", provider: "test", version: "test", readiness: "failed", lifecycle: "failed" }] satisfies import("../packages/cli/src/runtime-services.ts").RuntimeServiceEvidence[]
const nestedError = new Error("phase failed", { cause: new RuntimeServiceProvisionError("service failed", nestedEvidence) })
assert.equal(runtimeServiceEvidenceFromError(nestedError), nestedEvidence, "phase wrappers retain structured service evidence")
console.log("runtime services tests passed")
