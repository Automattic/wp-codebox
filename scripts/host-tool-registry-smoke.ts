import { createRuntime } from "@automattic/wp-codebox-core"
import { createHostToolRegistry, HOST_TOOL_RESULT_SCHEMA, type HostToolResult } from "@automattic/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  const registry = createHostToolRegistry([
    {
      declaration: {
        name: "client/echo",
        description: "Echo a caller-provided payload through the Codebox host transport.",
        parameters: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string" } },
          additionalProperties: false,
        },
        executor: "client",
        scope: "run",
        runtime: { completion_signal: "progress" },
      },
      name: "client/echo",
      description: "Echo a caller-provided payload through the Codebox host transport.",
      outputSchema: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
        additionalProperties: false,
      },
      policy: { capability: "client/echo", risk: "read" },
      runtime: { completion_signal: "progress" },
      handler: (input) => input,
    },
  ])
  const catalog = registry.list()
  assert(catalog[0]?.declaration.name === "client/echo", "registry exposes caller-provided canonical tool declaration")
  assert(catalog[0]?.declaration.executor === "client", "canonical declaration keeps client executor ownership")
  assert(catalog[0]?.declaration.scope === "run", "canonical declaration stays scoped to one run")

  const runtime = await createRuntime({
    backend: "wordpress-playground",
    environment: { kind: "wordpress", version: "latest" },
    policy: { network: "deny", filesystem: "sandbox", commands: ["client/echo"], secrets: "none", approvals: "never" },
    hostTools: registry,
  }, createPlaygroundRuntimeBackend())

  const ok = await runtime.execute({ command: "client/echo", args: ['input-json={"message":"hello"}'] })
  const okBody = JSON.parse(ok.stdout) as HostToolResult
  assert(okBody.schema === HOST_TOOL_RESULT_SCHEMA, "host tool result must use the stable result schema")
  assert(okBody.status === "ok", "valid host tool call should succeed")
  assert(okBody.output && typeof okBody.output === "object" && !Array.isArray(okBody.output) && okBody.output.message === "hello", "host tool output should be structured")
  assert(okBody.toolResult.tool_name === "client/echo", "transport envelope includes canonical tool result name")
  assert(okBody.toolResult.success === true, "successful transport calls map to canonical success")
  assert(okBody.diagnostics.transport === "wp-codebox-host-tool", "transport diagnostics stay in the Codebox envelope")
  assert(okBody.diagnostics.policyCommand === "client/echo", "transport diagnostics preserve the policy command")

  const invalid = await runtime.execute({ command: "client/echo", args: ['input-json={"extra":true}'] })
  const invalidBody = JSON.parse(invalid.stdout) as HostToolResult
  assert(invalidBody.status === "error", "invalid host tool input should return a structured error")
  assert(invalidBody.error.code === "host-tool-invalid-input", "invalid input should use the stable input error code")
  assert(invalidBody.toolResult.success === false, "transport errors map to canonical tool errors")
  assert(invalidBody.toolResult.metadata.code === "host-tool-invalid-input", "canonical tool error metadata preserves transport error classification")

  let denied = false
  try {
    const deniedRuntime = await createRuntime({
      backend: "wordpress-playground",
      environment: { kind: "wordpress", version: "latest" },
      policy: { network: "deny", filesystem: "sandbox", commands: [], secrets: "none", approvals: "never" },
      hostTools: registry,
    }, createPlaygroundRuntimeBackend())
    await deniedRuntime.execute({ command: "client/echo", args: ['input-json={"message":"hello"}'] })
  } catch {
    denied = true
  }
  assert(denied, "host tool calls must remain gated by runtime policy commands")
}

await main()
