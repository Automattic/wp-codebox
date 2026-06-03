import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHostToolRegistry, createRuntime, type HostToolResult } from "@automattic/wp-codebox-core"
import { createHostCommandTool, createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-host-command-"))
  const nested = join(root, "repo")
  await mkdir(nested)
  const resolvedNested = await realpath(nested)

  const registry = createHostToolRegistry([
    createHostCommandTool({
      name: "host/node_smoke",
      description: "Runs a bounded Node.js host command for smoke coverage.",
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1), token: process.env.SMOKE_TOKEN || null }))", "--"],
      cwd: root,
      allowedCwdRoots: [root],
      allowedInputEnv: ["SMOKE_TOKEN"],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }),
  ])

  const runtime = await createRuntime({
    backend: "wordpress-playground",
    environment: { kind: "wordpress", version: "latest" },
    policy: { network: "deny", filesystem: "sandbox", commands: ["host/node_smoke"], secrets: "none", approvals: "never" },
    hostTools: registry,
  }, createPlaygroundRuntimeBackend())

  const ok = await runtime.execute({
    command: "host/node_smoke",
    args: [`input-json=${JSON.stringify({ args: ["--flag"], cwd: nested, env: { SMOKE_TOKEN: "allowed" } })}`],
  })
  const okBody = JSON.parse(ok.stdout) as HostToolResult
  assert(okBody.status === "ok", "allowed host command should succeed")
  assert(typeof okBody.output === "object" && okBody.output !== null && !Array.isArray(okBody.output), "host command output should be an object")
  assert(okBody.output.cwd === resolvedNested, "host command should run from requested allowed cwd")
  assert(okBody.output.exitCode === 0, `host command should report exit code: ${JSON.stringify(okBody.output)}`)
  assert(typeof okBody.output.stdout === "string" && okBody.output.stdout.includes("allowed"), "host command should pass explicitly allowed env")

  const deniedCwd = await runtime.execute({
    command: "host/node_smoke",
    args: [`input-json=${JSON.stringify({ cwd: tmpdir() })}`],
  })
  const deniedCwdBody = JSON.parse(deniedCwd.stdout) as HostToolResult
  assert(deniedCwdBody.status === "error", "host command cwd escapes should fail closed")
  assert(deniedCwdBody.error.message.includes("outside allowed roots"), "host command cwd errors should be explicit")

  const deniedEnv = await runtime.execute({
    command: "host/node_smoke",
    args: [`input-json=${JSON.stringify({ env: { SECRET_TOKEN: "blocked" } })}`],
  })
  const deniedEnvBody = JSON.parse(deniedEnv.stdout) as HostToolResult
  assert(deniedEnvBody.status === "error", "host command env escapes should fail closed")
  assert(deniedEnvBody.error.message.includes("env is not allowed"), "host command env errors should be explicit")
}

await main()
