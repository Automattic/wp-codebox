import { createRuntime } from "@chubes4/wp-codebox-core"
import { createHostToolRegistry, HOST_TOOL_RESULT_SCHEMA, type HostToolResult } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  const registry = createHostToolRegistry([
    {
      name: "host.echo",
      description: "Echo a host-provided payload through the generic host tool bridge.",
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
        additionalProperties: false,
      },
      policy: { capability: "host.echo", risk: "read" },
      handler: (input) => input,
    },
  ])

  const runtime = await createRuntime({
    backend: "wordpress-playground",
    environment: { kind: "wordpress", version: "latest" },
    policy: { network: "deny", filesystem: "sandbox", commands: ["host.echo"], secrets: "none", approvals: "never" },
    hostTools: registry,
  }, createPlaygroundRuntimeBackend())

  const ok = await runtime.execute({ command: "host.echo", args: ['input-json={"message":"hello"}'] })
  const okBody = JSON.parse(ok.stdout) as HostToolResult
  assert(okBody.schema === HOST_TOOL_RESULT_SCHEMA, "host tool result must use the stable result schema")
  assert(okBody.status === "ok", "valid host tool call should succeed")
  assert(okBody.output && typeof okBody.output === "object" && !Array.isArray(okBody.output) && okBody.output.message === "hello", "host tool output should be structured")

  const invalid = await runtime.execute({ command: "host.echo", args: ['input-json={"extra":true}'] })
  const invalidBody = JSON.parse(invalid.stdout) as HostToolResult
  assert(invalidBody.status === "error", "invalid host tool input should return a structured error")
  assert(invalidBody.error.code === "host-tool-invalid-input", "invalid input should use the stable input error code")

  let denied = false
  try {
    const deniedRuntime = await createRuntime({
      backend: "wordpress-playground",
      environment: { kind: "wordpress", version: "latest" },
      policy: { network: "deny", filesystem: "sandbox", commands: [], secrets: "none", approvals: "never" },
      hostTools: registry,
    }, createPlaygroundRuntimeBackend())
    await deniedRuntime.execute({ command: "host.echo", args: ['input-json={"message":"hello"}'] })
  } catch {
    denied = true
  }
  assert(denied, "host tool calls must remain gated by runtime policy commands")
}

await main()
