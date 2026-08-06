import assert from "node:assert/strict"
import { classifyManagedDatabaseMysqliError, managedDatabaseDiagnosticEndpoint, managedDatabaseDiagnosticsPhp } from "../packages/runtime-playground/src/playground-cli-runner.ts"

assert.deepEqual(managedDatabaseDiagnosticEndpoint("database.internal", "3307"), { hostClass: "hostname", port: { present: true, valid: true } })
assert.deepEqual(managedDatabaseDiagnosticEndpoint("127.0.0.1", "0"), { hostClass: "loopback", port: { present: true, valid: false } })
assert.deepEqual(managedDatabaseDiagnosticEndpoint(undefined, undefined), { hostClass: "absent", port: { present: false, valid: false } })
assert.equal(classifyManagedDatabaseMysqliError(1045), "authentication_failed")
assert.equal(classifyManagedDatabaseMysqliError(1049), "database_missing")
assert.equal(classifyManagedDatabaseMysqliError(2002), "endpoint_unreachable")

const secret = "do-not-log-this-password"
const source = managedDatabaseDiagnosticsPhp({
  environment: { databaseSetup: "external" },
  runtimeEnv: { DB_HOST: "database.internal", DB_PORT: "3307", DB_USER: "runtime", DB_NAME: "application" },
  secretEnv: { DB_PASSWORD: secret },
  metadata: { managedRuntimeServices: [{ id: "database-service", kind: "mysql", provider: "external", readiness: "ready", lifecycle: "provisioned" }] },
} as any)
assert.match(source, /\\"id\\":\\"database-service\\"/)
assert.match(source, /\\"provider\\":\\"external\\"/)
assert.match(source, /DB_PASSWORD/)
assert.equal(source.includes("database.internal"), false)
assert.equal(source.includes(secret), false)

console.log("managed database diagnostics classification and redaction ok")
