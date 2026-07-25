import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "../packages/runtime-core/src/index.js"
import { executeRecipeWorkflowStep } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"
import { createPlaygroundRuntimeBackend } from "../packages/runtime-playground/src/index.js"
import type { PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-wp-cli-result-"))
const wordpressDirectory = join(root, "wordpress")
const files = new Map<string, string>()
const payload = { schema: "example/validation-result/v1", status: "ok", evidence: { retained: true } }
let wrapperPath = ""

const cliModule: PlaygroundCliModule = {
  async runCLI() {
    return {
      serverUrl: "http://127.0.0.1:9404",
      playground: {
        async writeFile(path, contents) {
          files.set(path, contents)
          wrapperPath = path
        },
        unlink(path) {
          files.delete(path)
        },
        async run(options) {
          assert.ok("scriptPath" in options)
          const scriptPath = options.scriptPath
          assert.equal(files.has(scriptPath), true, "WP-CLI wrapper must exist while the command runs")
          return {
            exitCode: 0,
            errors: "",
            get text() {
              return files.has(scriptPath) ? `${JSON.stringify(payload)}\n` : ""
            },
          }
        },
      },
      async [Symbol.asyncDispose]() {},
    }
  },
}

const runtime = await createRuntime({
  backend: "wordpress-playground",
  artifactsDirectory: join(root, "artifacts"),
  environment: {
    kind: "wordpress",
    name: "wp-cli-result",
    version: "mounted-wordpress-source",
    phpVersion: "8.4",
    wordpressInstallMode: "do-not-attempt-installing",
    assets: { wordpressDirectory },
    blueprint: {},
  },
  policy: {
    network: "deny",
    filesystem: "sandbox",
    commands: ["wordpress.wp-cli"],
    secrets: "none",
    approvals: "never",
  },
}, createPlaygroundRuntimeBackend({ cliModule }))

try {
  const execution = await executeRecipeWorkflowStep(runtime, {
    phase: "steps",
    index: 0,
    step: { command: "wordpress.wp-cli", args: ["command=example validate --format=json"] },
  }, root)

  assert.equal(execution.exitCode, 0)
  assert.equal(files.has(wrapperPath), false, "completed WP-CLI wrappers must be cleaned up")
  assert.equal(execution.stdout, `${JSON.stringify(payload)}\n`)
  assert.deepEqual(execution.result?.json, payload, "recipe output must retain successful structured WP-CLI output")
} finally {
  await runtime.destroy()
  await rm(root, { recursive: true, force: true })
}

console.log("WP-CLI recipe result survives temporary wrapper cleanup")
