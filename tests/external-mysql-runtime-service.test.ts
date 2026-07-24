import assert from "node:assert/strict"
import { provisionRuntimeServices, RuntimeServiceProvisionError, runtimeServicePlan, type RuntimeServiceDependencies } from "../packages/cli/src/runtime-services.ts"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.ts"
import { validateWorkspaceRecipeJsonSchema, type WorkspaceRecipeRuntimeService } from "../packages/runtime-core/src/index.ts"

const adminPassword = "admin-secret-'\\-value"
const externalService: WorkspaceRecipeRuntimeService = {
  id: "external-db",
  kind: "mysql",
  configuration: {
    provider: "external",
    engine: "mysql",
    hostEnv: "MYSQL_ADMIN_HOST",
    portEnv: "MYSQL_ADMIN_PORT",
    usernameEnv: "MYSQL_ADMIN_USER",
    passwordEnv: "MYSQL_ADMIN_PASSWORD",
  },
  outputs: { host: "DB_HOST", port: "DB_PORT", username: "DB_USER", password: "DB_PASSWORD", database: "DB_NAME" },
}

assert.equal(validateWorkspaceRecipeJsonSchema({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { services: [externalService] },
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
  inputs: { services: [externalService] },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 1;"] }] },
}, "recipe.json"), [])
const exposedAdminIssues = await validateWorkspaceRecipeSemantics({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { secretEnv: ["MYSQL_ADMIN_PASSWORD"], services: [externalService] },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 1;"] }] },
}, "recipe.json")
assert.ok(exposedAdminIssues.some((issue) => issue.code === "runtime-service-admin-env-exposed"), "administrative credentials cannot be projected into the sandbox")

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

const successFake = fakeDependencies()
const provisioned = await provisionRuntimeServices([externalService], { dependencies: successFake.dependencies })
assert.equal(provisioned.env.DB_HOST, "database.internal")
assert.equal(provisioned.env.DB_PORT, "3307")
assert.match(provisioned.env.DB_NAME ?? "", /^wp_codebox_[a-f0-9]{24}$/)
assert.match(provisioned.env.DB_USER ?? "", /^wpcb_[a-f0-9]{24}$/)
assert.equal(provisioned.secretEnv.DB_PASSWORD, provisioned.env.DB_PASSWORD)
assert.equal(provisioned.evidence[0]?.provider, "external")
assert.equal(provisioned.evidence[0]?.readiness, "ready")
const createDatabase = successFake.calls.find((call) => call.stdin?.startsWith("CREATE DATABASE"))
const createUser = successFake.calls.find((call) => call.stdin?.startsWith("CREATE USER"))
assert.match(createDatabase?.stdin ?? "", /^CREATE DATABASE `wp_codebox_[a-f0-9]{24}`;\n$/)
assert.match(createUser?.stdin ?? "", /^CREATE USER 'wpcb_[a-f0-9]{24}'@'%' IDENTIFIED BY '[A-Za-z0-9_-]+';\n$/)
assert.equal(successFake.calls.some((call) => call.args.some((arg) => arg.includes(adminPassword) || arg.includes(provisioned.env.DB_PASSWORD ?? ""))), false, "passwords never enter argv")
assert.equal(JSON.stringify(runtimeServicePlan([externalService])).includes(adminPassword), false)
assert.equal(JSON.stringify(provisioned.evidence).includes(adminPassword), false)
assert.equal(JSON.stringify(provisioned.evidence).includes(provisioned.env.DB_PASSWORD ?? ""), false)
await provisioned.release()
await provisioned.release()
assert.equal(successFake.calls.filter((call) => call.stdin?.startsWith("DROP DATABASE")).length, 1)
assert.equal(successFake.calls.filter((call) => call.stdin?.startsWith("DROP USER")).length, 1)
assert.equal(successFake.calls.filter((call) => call.stdin === "SELECT 1;\n").length, 1, "the isolated account is authenticated before workload execution")
assert.equal(provisioned.evidence[0]?.teardown, "completed")

const insufficientFake = fakeDependencies((call) => {
  if (call.stdin?.startsWith("CREATE DATABASE")) throw new Error(`permission denied ${adminPassword}`)
})
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: insufficientFake.dependencies }), (error: unknown) => {
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
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: partialFake.dependencies }), RuntimeServiceProvisionError)
assert.equal(partialFake.calls.some((call) => call.stdin?.startsWith("DROP DATABASE")), true)
assert.equal(partialFake.calls.some((call) => call.stdin?.startsWith("DROP USER")), true, "partial user creation is treated as uncertain and rolled back")

const cancellation = new AbortController()
const cancelledFake = fakeDependencies((call, controller) => {
  if (call.stdin?.startsWith("CREATE DATABASE")) controller?.abort()
}, cancellation)
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: cancelledFake.dependencies, signal: cancellation.signal }), (error: unknown) => {
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
const cleanupFailure = await provisionRuntimeServices([externalService], { dependencies: cleanupFailureFake.dependencies })
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
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: unavailableNamespaceFake.dependencies }), RuntimeServiceProvisionError)
assert.equal(unavailableNamespaceFake.calls.some((call) => call.stdin?.startsWith("CREATE")), false, "a namespace that cannot be proven unused fails closed")

const missingCredentials = fakeDependencies()
missingCredentials.dependencies.environment = {}
await assert.rejects(provisionRuntimeServices([externalService], { dependencies: missingCredentials.dependencies }), (error: unknown) => error instanceof RuntimeServiceProvisionError && error.evidence[0]?.diagnostic?.code === "provision-failed")
assert.equal(missingCredentials.calls.length, 0, "missing host credential references fail before invoking a database client")

const mariaService: WorkspaceRecipeRuntimeService = { ...externalService, configuration: { ...externalService.configuration, engine: "mariadb" } }
const mariaFake = fakeDependencies()
const maria = await provisionRuntimeServices([mariaService], { dependencies: mariaFake.dependencies })
assert.equal(runtimeServicePlan([mariaService])[0]?.version, "mysql-compatible:mariadb")
assert.equal(mariaFake.calls.every((call) => call.command === "mariadb"), true)
await maria.release()

console.log("external MySQL runtime service tests passed")
