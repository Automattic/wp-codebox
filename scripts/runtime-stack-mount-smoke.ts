import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-stack-mount-"))

try {
  const stackMarker = join(workspace, "stack-marker.txt")
  await writeFile(stackMarker, "runtime-stack-override\n")

  const recipePath = join(workspace, "recipe.json")
  const artifacts = join(workspace, "artifacts")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      wp: "latest",
      stack: {
        mounts: [{
          type: "file",
          source: stackMarker,
          target: "/wordpress/wp-includes/php-ai-client/stack-marker.txt",
          mode: "readonly",
          metadata: { component: "php-ai-client", ref: "test-stack" },
        }],
      },
    },
    workflow: {
      steps: [{
        command: "wordpress.run-php",
        args: ["code=echo file_get_contents(ABSPATH . 'wp-includes/php-ai-client/stack-marker.txt');"],
      }],
    },
    artifacts: { directory: artifacts },
  }, null, 2)}\n`)

  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], { cwd: root })
  const output = JSON.parse(stdout)
  assert.equal(output.success, true, output.error?.message)
  assert.equal(output.executions[0]?.stdout, "runtime-stack-override\n")

  const metadata = JSON.parse(await readFile(join(output.artifacts.directory, "metadata.json"), "utf8"))
  assert.equal(metadata.context.recipe.runtime.stack.mounts[0].target, "/wordpress/wp-includes/php-ai-client/stack-marker.txt")
  assert.equal(metadata.context.recipe.runtime.stack.mounts[0].metadata.component, "php-ai-client")

  console.log("Runtime stack mount smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}
