import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeRuntimeServiceProcess, provisionRuntimeServices, RuntimeServiceProvisionError, runtimeServicePlan, type RuntimeServiceDependencies } from "../packages/cli/src/runtime-services.ts"
import { validateRecipeRuntimePolicy, validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.ts"
import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.ts"
import { validateWorkspaceRecipeJsonSchema, type RuntimeCreateSpec, type WorkspaceRecipeRuntimeService } from "../packages/runtime-core/src/index.ts"

const adminPassword = "admin-secret-'\\-value"
const externalService: WorkspaceRecipeRuntimeService = {
  id: "external-db",
  kind: "mysql",
  configuration: {
    provider: "external",
    externalService: "database-service",
    engine: "mysql",
    hostEnv: "MYSQL_ADMIN_HOST",
    portEnv: "MYSQL_ADMIN_PORT",
    usernameEnv: "MYSQL_ADMIN_USER",
    passwordEnv: "MYSQL_ADMIN_PASSWORD",
  },
  outputs: { host: "DB_HOST", port: "DB_PORT", username: "DB_USER", password: "DB_PASSWORD", database: "DB_NAME" },
}
const externalServices = [{ id: "database-service", environment: "external" as const, allowedHosts: ["database.internal:3307"], writes: "allowed-with-approval" as const }]
const policy = { network: { allowHosts: ["database.internal:3307"] }, filesystem: "sandbox" as const, commands: ["wordpress.phpunit"], secrets: "connector-scoped" as const, approvals: "on-write" as const }
const authorization = { policy, externalServices, externalServiceWritesApproved: true }

assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { externalServices, services: [externalService] },
  workflow: { steps: [{ command: "wordpress.phpunit", args: ["database-type=mysql"] }] },
}).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { services: [{ ...externalService, configuration: { provider: "external" } }] },
  workflow: { steps: [{ command: "wordpress.phpunit" }] },
}).valid, false, "external provider configuration requires host-side credential references")
assert.deepEqual(runtimeServicePlan([externalService]), [{
  id: "external-db",
  kind: "mysql",
  provider: "external",
  version: "mysql-compatible:mysql",
  bind: "configured",
  port: "configured",
  persistentVolume: false,
  configuration: externalService.configuration,
  outputs: externalService.outputs,
}])
assert.deepEqual(await validateWorkspaceRecipeSemantics({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { externalServices, services: [externalService] },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 1;"] }] },
}, "recipe.json"), [])
const exposedAdminIssues = await validateWorkspaceRecipeSemantics({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { secretEnv: ["MYSQL_ADMIN_PASSWORD"], externalServices, services: [externalService] },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 1;"] }] },
}, "recipe.json")
assert.ok(exposedAdminIssues.some((issue) => issue.code === "runtime-service-admin-env-exposed"), "administrative credentials cannot be projected into the sandbox")
const policyRecipe = { schema: "wp-codebox/workspace-recipe/v1" as const, inputs: { externalServices, services: [externalService] }, workflow: { steps: [{ command: "wordpress.phpunit", args: ["plugin-slug=example", "database-type=mysql"] }] } }
assert.ok(validateRecipeRuntimePolicy(policyRecipe, { ...policy, network: "deny" }).some((issue) => issue.code === "runtime-policy-external-service-network-denied"))
assert.ok(validateRecipeRuntimePolicy(policyRecipe, { ...policy, approvals: "never" }).some((issue) => issue.code === "runtime-policy-external-service-approval-required"))

interface FakeCall {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  stdin?: string
}

function fakeDependencies(handle?: (call: FakeCall, controller?: AbortController) => void | Promise<void>, controller?: AbortController): { dependencies: RuntimeServiceDependencies; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  return {
    calls,
    dependencies: {
      environment: {
        MYSQL_ADMIN_HOST: "database.internal",
        MYSQL_ADMIN_PORT: "3307",
        MYSQL_ADMIN_USER: "provisioner",
        MYSQL_ADMIN_PASSWORD: adminPassword,
      },
      randomBytes: (size) => Buffer.alloc(size, 0xab),
      async waitForReady() {},
      async execute(command, args, options) {
        const call = { command, args, env: options.env, signal: options.signal, stdin: options.stdin }
        calls.push(call)
        await handle?.(call, controller)
        if (options.stdin?.startsWith("SELECT EXISTS")) return { stdout: "0\n0\n" }
        return { stdout: options.stdin === "SELECT 1;\n" ? "1\n" : "" }
      },
    },
  }
}

const deniedPolicyFake = fakeDependencies()
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: deniedPolicyFake.dependencies, ...authorization, policy: { ...policy, network: "deny" } }), RuntimeServiceProvisionError)
assert.equal(deniedPolicyFake.calls.length, 0, "denied network policy fails before connecting")

const unauthorizedHostFake = fakeDependencies()
await assert.rejects(provisionRuntimeServices([externalService], {
  dependencies: unauthorizedHostFake.dependencies,
  ...authorization,
  externalServices: [{ ...externalServices[0]!, allowedHosts: ["other.internal"] }],
}), RuntimeServiceProvisionError)
assert.equal(unauthorizedHostFake.calls.length, 0, "a host absent from the external-service allowlist fails before connecting")

const approvalRefusalFake = fakeDependencies()
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: approvalRefusalFake.dependencies, ...authorization, externalServiceWritesApproved: false }), RuntimeServiceProvisionError)
assert.equal(approvalRefusalFake.calls.length, 0, "write approval refusal fails before connecting")

const successFake = fakeDependencies()
const provisioned = await provisionRuntimeServices([externalService], { dependencies: successFake.dependencies, ...authorization })
assert.equal(provisioned.env.DB_HOST, "database.internal")
assert.equal(provisioned.env.DB_PORT, "3307")
assert.match(provisioned.env.DB_NAME ?? "", /^wp_codebox_[a-f0-9]{24}$/)
assert.match(provisioned.env.DB_USER ?? "", /^wpcb_[a-f0-9]{24}$/)
const generatedPassword = provisioned.secretEnv.DB_PASSWORD ?? ""
assert.match(generatedPassword, /^[A-Za-z0-9_-]+$/)
assert.equal(provisioned.env.DB_PASSWORD, undefined, "password is absent from the non-secret output channel")
assert.equal(provisioned.evidence[0]?.provider, "external")
assert.equal(provisioned.evidence[0]?.readiness, "ready")
const createDatabase = successFake.calls.find((call) => call.stdin?.startsWith("CREATE DATABASE"))
const createUser = successFake.calls.find((call) => call.stdin?.startsWith("CREATE USER"))
assert.match(createDatabase?.stdin ?? "", /^CREATE DATABASE `wp_codebox_[a-f0-9]{24}`;\n$/)
assert.match(createUser?.stdin ?? "", /^CREATE USER 'wpcb_[a-f0-9]{24}'@'%' IDENTIFIED BY '[A-Za-z0-9_-]+';\n$/)
assert.equal(successFake.calls.some((call) => call.args.some((arg) => arg.includes(adminPassword) || arg.includes(generatedPassword))), false, "passwords never enter argv")
assert.equal(JSON.stringify(runtimeServicePlan([externalService])).includes(adminPassword), false)
assert.equal(JSON.stringify(provisioned.evidence).includes(adminPassword), false)
assert.equal(JSON.stringify(provisioned.evidence).includes(generatedPassword), false)
const bootstrapRoot = await mkdtemp(join(tmpdir(), "wp-codebox-external-mysql-bootstrap-"))
const wordpressRoot = await mkdtemp(join(tmpdir(), "wp-codebox-external-mysql-wordpress-"))
try {
  const bootstrapCalls: Parameters<PlaygroundCliModule["runCLI"]>[0][] = []
  const bootstrapRuns: Array<({ code: string } | { scriptPath: string }) & { env?: Record<string, string> }> = []
  const cliModule: PlaygroundCliModule = { async runCLI(options) {
    bootstrapCalls.push(options)
    return { serverUrl: "http://127.0.0.1:65535", playground: { async run(runOptions) { bootstrapRuns.push(runOptions); return { text: runOptions.env?.DB_PASSWORD ?? "" } } }, async [Symbol.asyncDispose]() {} }
  } }
  const runtimeSpec: RuntimeCreateSpec = {
    backend: "wordpress-playground",
    environment: { version: "mounted", wordpressInstallMode: "do-not-attempt-installing", databaseSetup: "external", assets: { wordpressDirectory: wordpressRoot }, blueprint: {} },
    policy,
    runtimeEnv: provisioned.env,
    secretEnv: provisioned.secretEnv,
    artifactsDirectory: bootstrapRoot,
  }
  const server = await startPlaygroundCliServer(runtimeSpec, [], { cliModule })
  const connectorResponse = await server.playground.run({ code: "<?php echo getenv('DB_PASSWORD');" })
  assert.equal(connectorResponse.text, generatedPassword, "generated password reaches PHP through the ephemeral run environment")
  assert.equal(bootstrapRuns[0]?.env?.DB_PASSWORD, generatedPassword)
  assert.equal(JSON.stringify(bootstrapCalls).includes(generatedPassword), false, "Playground startup options do not serialize the generated password")
  await server[Symbol.asyncDispose]()
  const mounts = bootstrapCalls[0]?.["mount-before-install"] ?? []
  const autoPrependPath = mounts.find((mount) => mount.vfsPath === "/internal/shared/wp-codebox-auto-prepend.php")?.hostPath
  const wpConfigPath = mounts.find((mount) => mount.vfsPath === "/wordpress/wp-config.php")?.hostPath
  assert.ok(autoPrependPath && wpConfigPath)
  const autoPrepend = await readFile(autoPrependPath, "utf8")
  const wpConfig = await readFile(wpConfigPath, "utf8")
  assert.match(wpConfig, /getenv\('DB_PASSWORD'\)/)
  assert.equal(autoPrepend.includes(generatedPassword), false, "generated password is not serialized into auto-prepend PHP")
  assert.equal(wpConfig.includes(generatedPassword), false, "generated password is not serialized into wp-config")
  assert.equal(await directoryContains(bootstrapRoot, generatedPassword), false, "generated password is absent from persisted artifact files")
  assert.equal(await directoryContains(wordpressRoot, generatedPassword), false, "generated password is absent from persisted WordPress files")
} finally {
  await rm(bootstrapRoot, { recursive: true, force: true })
  await rm(wordpressRoot, { recursive: true, force: true })
}
await provisioned.release()
await provisioned.release()
assert.equal(successFake.calls.filter((call) => call.stdin?.startsWith("DROP DATABASE")).length, 1)
assert.equal(successFake.calls.filter((call) => call.stdin?.startsWith("DROP USER")).length, 1)
assert.equal(successFake.calls.filter((call) => call.stdin === "SELECT 1;\n").length, 1, "the isolated account is authenticated before workload execution")
assert.equal(provisioned.evidence[0]?.teardown, "completed")

const insufficientFake = fakeDependencies((call) => {
  if (call.stdin?.startsWith("CREATE DATABASE")) throw new Error(`permission denied ${adminPassword}`)
})
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: insufficientFake.dependencies, ...authorization }), (error: unknown) => {
  assert.ok(error instanceof RuntimeServiceProvisionError)
  assert.equal(error.message.includes(adminPassword), false)
  assert.equal(JSON.stringify(error.evidence).includes(adminPassword), false)
  assert.equal(error.evidence[0]?.readiness, "failed")
  return true
})
assert.equal(insufficientFake.calls.some((call) => call.stdin === "SELECT 1;\n"), false, "insufficient privileges fail before workload credentials are used")
assert.equal(insufficientFake.calls.some((call) => call.stdin?.startsWith("DROP DATABASE")), true, "an uncertain partial create is rolled back")

const partialFake = fakeDependencies((call) => {
  if (call.stdin?.startsWith("CREATE USER")) throw new Error("create user denied")
})
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: partialFake.dependencies, ...authorization }), RuntimeServiceProvisionError)
assert.equal(partialFake.calls.some((call) => call.stdin?.startsWith("DROP DATABASE")), true)
assert.equal(partialFake.calls.some((call) => call.stdin?.startsWith("DROP USER")), true, "partial user creation is treated as uncertain and rolled back")

const cancellation = new AbortController()
const cancelledFake = fakeDependencies((call, controller) => {
  if (call.stdin?.startsWith("CREATE DATABASE")) controller?.abort()
}, cancellation)
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: cancelledFake.dependencies, signal: cancellation.signal, ...authorization }), (error: unknown) => {
  assert.ok(error instanceof RuntimeServiceProvisionError)
  assert.equal(error.evidence[0]?.diagnostic?.code, "interrupted")
  assert.equal(error.evidence[0]?.teardown, "completed")
  return true
})
const cancelledCleanup = cancelledFake.calls.find((call) => call.stdin?.startsWith("DROP DATABASE"))
assert.equal(cancelledCleanup?.signal, undefined, "cleanup uses an independent context after cancellation")

const cleanupFailureFake = fakeDependencies((call) => {
  if (call.stdin?.startsWith("DROP DATABASE")) throw new Error(`cleanup leaked ${adminPassword}`)
})
const cleanupFailure = await provisionRuntimeServices([externalService], { dependencies: cleanupFailureFake.dependencies, ...authorization })
await assert.rejects(cleanupFailure.release(), (error: unknown) => {
  assert.ok(error instanceof Error)
  assert.equal(error.message.includes(adminPassword), false)
  return true
})
assert.equal(cleanupFailureFake.calls.some((call) => call.stdin?.startsWith("DROP USER")), true, "user cleanup continues after database cleanup fails")
assert.equal(cleanupFailure.evidence[0]?.teardown, "failed")
assert.equal(cleanupFailure.evidence[0]?.diagnostic?.code, "teardown-failed")

const unavailableNamespaceFake = fakeDependencies((call) => {
  if (call.stdin?.startsWith("SELECT EXISTS")) return undefined
})
unavailableNamespaceFake.dependencies.execute = async (command, args, options) => {
  unavailableNamespaceFake.calls.push({ command, args, env: options.env, signal: options.signal, stdin: options.stdin })
  return { stdout: options.stdin?.startsWith("SELECT EXISTS") ? "1\n0\n" : "" }
}
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: unavailableNamespaceFake.dependencies, ...authorization }), RuntimeServiceProvisionError)
assert.equal(unavailableNamespaceFake.calls.some((call) => call.stdin?.startsWith("CREATE")), false, "a namespace that cannot be proven unused fails closed")

const missingCredentials = fakeDependencies()
missingCredentials.dependencies.environment = {}
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: missingCredentials.dependencies, ...authorization }), (error: unknown) => error instanceof RuntimeServiceProvisionError && error.evidence[0]?.diagnostic?.code === "provision-failed")
assert.equal(missingCredentials.calls.length, 0, "missing host credential references fail before invoking a database client")

const mariaService: WorkspaceRecipeRuntimeService = { ...externalService, configuration: { ...externalService.configuration, engine: "mariadb" } }
const mariaFake = fakeDependencies()
const maria = await provisionRuntimeServices([mariaService], { dependencies: mariaFake.dependencies, ...authorization })
assert.equal(runtimeServicePlan([mariaService])[0]?.version, "mysql-compatible:mariadb")
assert.equal(mariaFake.calls.every((call) => call.command === "mariadb"), true)
await maria.release()

await assert.rejects(executeRuntimeServiceProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { timeout: 10_000, maxOutputBytes: 128 }), (error: unknown) => {
  const bounded = error as Error & { code?: string; stdout?: string; stderr?: string }
  assert.equal(bounded.code, "runtime-service-output-overflow")
  assert.ok(Buffer.byteLength(bounded.stdout ?? "") <= 128)
  assert.ok(Buffer.byteLength(bounded.stderr ?? "") <= 128)
  return true
})

console.log("external MySQL runtime service tests passed")

async function directoryContains(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (await directoryContains(path, needle)) return true
    } else if (entry.isFile() && (await readFile(path)).includes(Buffer.from(needle))) {
      return true
    }
  }
  return false
}
