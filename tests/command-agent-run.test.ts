import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { COMMAND_AGENT_RUN_SCHEMA, commandAgentRunResultJson, createCommandAgentRunResult, parseCommandAgentRunRequest, type ExecutionResult, type RuntimeInfo } from "../packages/runtime-core/src/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/command-agent-run.json", import.meta.url), "utf8"))

const request = parseCommandAgentRunRequest(fixture.args)
assert.equal(request.command, "example.echo-json")
assert.deepEqual(request.args, ["input=ok"])
assert.equal(request.parseJson, true)
assert.equal(request.session?.sessionId, "session-123")
assert.equal(request.session?.correlationId, "correlation-456")
assert.deepEqual(request.session?.metadata, { recipe: "fixture" })
assert.equal(request.auth?.required, true)

const result = createCommandAgentRunResult({
  request,
  execution: fixture.execution as ExecutionResult,
  runtime: fixture.runtime as RuntimeInfo,
  environment: fixture.environment,
})

assert.equal(result.schema, COMMAND_AGENT_RUN_SCHEMA)
assert.equal(result.command, "command-agent-run")
assert.equal(result.status, "completed")
assert.equal(result.exitCode, 0)
assert.deepEqual(result.json, { ok: true })
assert.deepEqual(result.auth, { required: true, contextKeys: ["principal", "token"] })
assert.deepEqual(result.diagnostics.environment, { runtimeEnvNames: ["PUBLIC_FLAG"], secretEnvNames: ["SECRET_TOKEN"] })
assert.equal(result.diagnostics.durationMs, 125)
assert.deepEqual(result.artifactRefs, [{ kind: "command-log", id: "stdout", path: "files/command/stdout.txt" }])
assert.equal(JSON.parse(commandAgentRunResultJson(result)).schema, COMMAND_AGENT_RUN_SCHEMA)

assert.throws(() => parseCommandAgentRunRequest([]), /requires command/)
assert.throws(() => parseCommandAgentRunRequest(["command=command-agent-run"]), /cannot target itself/)
assert.throws(() => parseCommandAgentRunRequest(["command=example", "auth-required=true"]), /requires auth-context-json/)
assert.throws(() => createCommandAgentRunResult({ request, execution: fixture.execution as ExecutionResult, runtime: { ...fixture.runtime, id: "" } as RuntimeInfo }), /requires runtime metadata/)

console.log("command-agent-run contract passed")
