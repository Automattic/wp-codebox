import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRecipeBuildCommand } from "../packages/cli/src/commands/recipe-build.ts"
import { parseLoopbackPort, provisionRuntimeServices, provisionRuntimeServicesForRecipe, RuntimeServiceProvisionError, runtimeServiceEvidenceFromError, runtimeServicePlan, waitForMysqlProtocol, type RuntimeServiceDependencies } from "../packages/cli/src/runtime-services.ts"
import { planWorkspaceRecipe } from "../packages/cli/src/recipe-dry-run.ts"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.ts"
import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.ts"
import { validateWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.ts"

const service = { id: "test-db", kind: "mysql", outputs: { host: "DB_HOST", port: "DB_PORT", password: "DB_PASSWORD" } } as const
const plan = runtimeServicePlan([service])
assert.deepEqual(plan, [{ id: "test-db", kind: "mysql", provider: "docker", version: "mysql:8.4", bind: "loopback", port: "ephemeral", persistentVolume: false, outputs: service.outputs }])
assert.equal(parseLoopbackPort("127.0.0.1:44001\n"), 44001)
assert.throws(() => parseLoopbackPort("0.0.0.0:3306"), /loopback/)

const valid = validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [service] }, workflow: { steps: [{ command: "wordpress.run-php" }] } })
assert.equal(valid.valid, true)
const unsafe = validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [{ ...service, outputs: { port: "bad-name" } }] }, workflow: { steps: [{ command: "wordpress.run-php" }] } })
assert.equal(unsafe.valid, false)
const emptyRootService = { ...service, configuration: { rootAuthentication: "empty-password" as const } }
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [emptyRootService] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, true)
assert.deepEqual(buildWordPressPhpunitRecipe({ pluginSlug: "example", services: [emptyRootService] }).inputs?.services, [emptyRootService])
const builderDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-builder-"))
try {
  const optionsPath = join(builderDirectory, "options.json")
  const recipePath = join(builderDirectory, "recipe.json")
  await writeFile(optionsPath, JSON.stringify({
    pluginSlug: "example",
    phpVersion: "8.3",
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
  ["duplicate-runtime-service-env", "duplicate-runtime-service-env", "duplicate-runtime-service-env"],
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
assert.equal(provisioned.env.DB_PORT, "41001")
assert.equal(provisioned.env.DB_PASSWORD, Buffer.alloc(24, 7).toString("base64url"))
const runCall = calls.find((call) => call.args[0] === "run")
assert.ok(runCall?.args.includes("MYSQL_PASSWORD"))
assert.ok(runCall?.args.includes("127.0.0.1::3306"), "Docker publishes MySQL on a loopback ephemeral port")
assert.deepEqual(runCall?.args.slice(runCall.args.indexOf("--tmpfs"), runCall.args.indexOf("--tmpfs") + 2), ["--tmpfs", "/var/lib/mysql"])
assert.equal(runCall?.args.includes("--volume") || runCall?.args.includes("--mount"), false, "Docker uses no persistent volume")
assert.equal(runCall?.args.some((arg) => arg.includes(provisioned.env.DB_PASSWORD)), false, "credentials never enter Docker argv")
assert.equal(JSON.stringify(provisioned.evidence).includes(provisioned.env.DB_PASSWORD), false, "credentials never enter evidence")
assert.equal(runCall?.env?.DOCKER_HOST, process.env.DOCKER_HOST, "Docker provider context is preserved")
assert.equal(calls[0]?.args[0], "image", "the provider checks the image before starting the service")
await provisioned.release()
await provisioned.release()
assert.equal(calls.filter((call) => call.args[0] === "rm").length, 1, "release is idempotent")

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
