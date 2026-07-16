import assert from "node:assert/strict"
import { createServer } from "node:net"
import { parseLoopbackPort, provisionRuntimeServices, RuntimeServiceProvisionError, runtimeServicePlan, waitForMysqlProtocol, type RuntimeServiceDependencies } from "../packages/cli/src/runtime-services.ts"
import { validateWorkspaceRecipeJsonSchema } from "../packages/runtime-core/src/recipe-schema.ts"

const service = { id: "test-db", kind: "mysql", outputs: { host: "DB_HOST", port: "DB_PORT", password: "DB_PASSWORD" } } as const
const plan = runtimeServicePlan([service])
assert.deepEqual(plan, [{ id: "test-db", kind: "mysql", provider: "docker", version: "mysql:8.4", bind: "loopback", port: "ephemeral", persistentVolume: false, outputs: service.outputs }])
assert.equal(parseLoopbackPort("127.0.0.1:44001\n"), 44001)
assert.throws(() => parseLoopbackPort("0.0.0.0:3306"), /loopback/)

const valid = validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [service] }, workflow: { steps: [{ command: "wordpress.run-php" }] } })
assert.equal(valid.valid, true)
const unsafe = validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [{ ...service, outputs: { port: "bad-name" } }] }, workflow: { steps: [{ command: "wordpress.run-php" }] } })
assert.equal(unsafe.valid, false)

const server = createServer((socket) => socket.end(Buffer.from([1, 0, 0, 0, 10])))
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address !== "string")
await waitForMysqlProtocol("127.0.0.1", address.port, 250)
await new Promise<void>((resolve) => server.close(() => resolve()))
await assert.rejects(waitForMysqlProtocol("127.0.0.1", address.port, 25), /readiness timed out/)

const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
const dependencies: RuntimeServiceDependencies = {
  randomBytes: (size) => Buffer.alloc(size, 7),
  async execute(_command, args, options) {
    calls.push({ args, env: options.env })
    if (args[0] === "port") return { stdout: "127.0.0.1:41001\n" }
    return { stdout: "" }
  },
  async waitForReady() {},
}
const provisioned = await provisionRuntimeServices([service], { dependencies })
assert.equal(provisioned.env.DB_PORT, "41001")
assert.equal(provisioned.env.DB_PASSWORD, Buffer.alloc(24, 7).toString("base64url"))
assert.ok(calls[0]?.args.includes("MYSQL_PASSWORD"))
assert.equal(calls[0]?.args.some((arg) => arg.includes(provisioned.env.DB_PASSWORD)), false, "credentials never enter Docker argv")
assert.equal(JSON.stringify(provisioned.evidence).includes(provisioned.env.DB_PASSWORD), false, "credentials never enter evidence")
await provisioned.release()
await provisioned.release()
assert.equal(calls.filter((call) => call.args[0] === "rm").length, 1, "release is idempotent")

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
console.log("runtime services tests passed")
