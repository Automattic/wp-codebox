import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHostToolRegistry, createRuntime, type HostToolResult } from "@automattic/wp-codebox-core"
import { createClaudeCodeHostTool, createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  process.env.CLAUDE_CODE_SESSION_TOKEN = "must-not-reach-child-process"
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-claude-code-host-tool-"))
  const nested = join(root, "repo")
  await mkdir(nested)
  const resolvedNested = await realpath(nested)

  const registry = createHostToolRegistry([
    createClaudeCodeHostTool({
      command: process.execPath,
      args: [
        "-e",
        "let prompt=''; process.stdin.on('data', c => prompt += c); process.stdin.on('end', () => console.log(JSON.stringify({ cwd: process.cwd(), prompt, args: process.argv.slice(1), leaked: process.env.CLAUDE_CODE_SESSION_TOKEN || null })))",
        "--",
      ],
      cwd: root,
      allowedCwdRoots: [root],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }),
  ])
  const catalog = registry.list()
  assert(catalog[0]?.declaration.name === "claude_code/run", "Claude Code host tool should expose a stable canonical id")
  assert(catalog[0]?.declaration.runtime?.auth === "host-owned", "Claude Code host tool should declare host-owned auth")
  assert(catalog[0]?.declaration.runtime?.secrets === "none-in-recipe", "Claude Code host tool should declare recipe-safe secret handling")

  const runtime = await createRuntime({
    backend: "wordpress-playground",
    environment: { kind: "wordpress", version: "latest" },
    policy: { network: "deny", filesystem: "sandbox", commands: ["claude_code/run"], secrets: "none", approvals: "never" },
    hostTools: registry,
  }, createPlaygroundRuntimeBackend())

  const ok = await runtime.execute({
    command: "claude_code/run",
    args: [`input-json=${JSON.stringify({ prompt: "Summarize the task.", cwd: nested, model: "claude-code", maxTurns: 2 })}`],
  })
  const okBody = JSON.parse(ok.stdout) as HostToolResult
  assert(okBody.status === "ok", "claude_code/run should execute through the host tool transport")
  assert(typeof okBody.output === "object" && okBody.output !== null && !Array.isArray(okBody.output), "claude_code/run output should be structured")
  assert(okBody.output.cwd === resolvedNested, "claude_code/run should run from the requested allowed cwd")
  assert(okBody.output.exitCode === 0, `claude_code/run should report exit code: ${JSON.stringify(okBody.output)}`)
  assert(!("args" in okBody.output), "claude_code/run output should not serialize argv or prompt text")
  const childPayload = JSON.parse(String(okBody.output.stdout)) as { prompt?: string; args?: string[]; leaked?: string | null }
  assert(childPayload.prompt === "Summarize the task.", "claude_code/run should pass the prompt on stdin")
  assert(childPayload.args?.includes("--model") && childPayload.args?.includes("claude-code"), "claude_code/run should pass non-secret model selection as argv")
  assert(childPayload.args?.includes("--max-turns") && childPayload.args?.includes("2"), "claude_code/run should pass max turn bounds as argv")
  assert(childPayload.leaked === null, "claude_code/run should not inherit Claude auth/session env by default")

  const deniedCwd = await runtime.execute({
    command: "claude_code/run",
    args: [`input-json=${JSON.stringify({ prompt: "No escape", cwd: tmpdir() })}`],
  })
  const deniedCwdBody = JSON.parse(deniedCwd.stdout) as HostToolResult
  assert(deniedCwdBody.status === "error", "claude_code/run cwd escapes should fail closed")
  assert(deniedCwdBody.error.message.includes("outside allowed roots"), "claude_code/run cwd errors should be explicit")

  const deniedEnv = await runtime.execute({
    command: "claude_code/run",
    args: [`input-json=${JSON.stringify({ prompt: "No env", env: { CLAUDE_CODE_SESSION_TOKEN: "blocked" } })}`],
  })
  const deniedEnvBody = JSON.parse(deniedEnv.stdout) as HostToolResult
  assert(deniedEnvBody.status === "error", "claude_code/run should reject caller-supplied env")
  assert(deniedEnvBody.error.code === "host-tool-invalid-input", "caller env rejection should happen at schema validation")
}

await main()
