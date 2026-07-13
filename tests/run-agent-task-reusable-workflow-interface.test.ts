import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = new URL("..", import.meta.url).pathname

const { stdout } = await execFileAsync("npx", ["tsx", "scripts/validate-run-agent-task-reusable-workflow-interface.ts"], {
  cwd: repositoryRoot,
  env: { ...process.env, WP_CODEBOX_DIR: repositoryRoot },
})

if (!stdout.includes("wp-codebox/reusable-workflow-interface/v1 ok")) {
  throw new Error("Reusable workflow interface validator did not report success")
}

console.log("run-agent-task reusable workflow interface test ok")
