import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-playground-cli-startup-output-"))

try {
  const wordpressZip = join(workspace, "wordpress.zip")
  await writeFile(wordpressZip, Buffer.from("504b0506000000000000000000000000000000000000", "hex"))

  const cliModule: PlaygroundCliModule = {
    async runCLI(): Promise<never> {
      process.stderr.write("PHP Fatal error: startup asset bootstrap failed\n")
      process.stdout.write("Playground bootstrap stdout marker\n")
      process.exit(1)
    },
  }

  const spec: RuntimeCreateSpec = {
    backend: "wordpress-playground",
    environment: {
      kind: "wordpress",
      name: "playground-cli-startup-output-smoke",
      version: "7.0",
      assets: { wordpressZip },
      blueprint: { steps: [] },
    },
    policy: {
      filesystem: "readwrite-mounts",
      network: "deny",
      commands: ["wordpress.run-php"],
      secrets: "none",
      approvals: "never",
    },
    secretEnv: {},
    artifactsDirectory: workspace,
  }

  await assert.rejects(
    () => startPlaygroundCliServer(spec, [], { cliModule }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, "PlaygroundCliExitError", error.stack)
      assert.match(error.message, /exit code 1/)
      assert.match(error.message, /PHP Fatal error: startup asset bootstrap failed/)
      assert.match(error.message, /Playground bootstrap stdout marker/)
      assert.equal((error as { output?: { stderr?: string; stdout?: string } }).output?.stderr, "PHP Fatal error: startup asset bootstrap failed\n")
      assert.equal((error as { output?: { stderr?: string; stdout?: string } }).output?.stdout, "Playground bootstrap stdout marker\n")
      return true
    },
  )

  console.log("Playground CLI startup output smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}
