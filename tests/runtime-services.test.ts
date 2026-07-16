import assert from "node:assert/strict"
import { createServer } from "node:net"
import { parseLoopbackPort, runtimeServicePlan, waitForMysqlProtocol } from "../packages/cli/src/runtime-services.ts"
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

const serialized = JSON.stringify(plan)
assert.doesNotMatch(serialized, /[A-Za-z0-9_-]{24,}|127\.0\.0\.1:\d+/, "plans contain declarations, never provisioned credential values or endpoints")
console.log("runtime services tests passed")
