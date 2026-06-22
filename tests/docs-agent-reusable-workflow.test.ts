import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = new URL("..", import.meta.url)

const workflow = await readFile(new URL("../.github/workflows/docs-agent-runner.yml", import.meta.url), "utf8")
const publicWorkflowSurface = workflow.slice(0, workflow.indexOf("jobs:"))

assert.match(workflow, /^name: Docs Agent Runner \(reusable\)$/m)
assert.match(workflow, /workflow_call:/)
assert.match(workflow, /recipe_path:/)
assert.match(workflow, /recipe_json:/)
assert.match(workflow, /uses: Extra-Chill\/homeboy-extensions\/.github\/workflows\/datamachine-agent-ci.yml@main/)
assert.match(workflow, /agent_runtime: wp-codebox/)
assert.doesNotMatch(publicWorkflowSurface, /homeboy|datamachine|data machine|data-machine|agents api/i)
assert.doesNotMatch(publicWorkflowSurface, /mount|component path|ability id|provider plugin/i)

const docs = await readFile(new URL("../docs/docs-agent-reusable-workflow.md", import.meta.url), "utf8")
assert.match(docs, /^# Docs Agent Reusable Workflow/m)
assert.match(docs, /wp-codebox\/docs-agent-runner-recipe\/v1/)
assert.match(docs, /implementation-specific runtime wiring, workspace adapters,\s+plugins, and model setup stay behind the WP Codebox boundary/)
assert.doesNotMatch(docs, /homeboy|datamachine|data machine|data-machine|agents api|sandbox mounts|ability ids|provider internals/i)

const tmp = await mkdtemp(join(tmpdir(), "wp-codebox-docs-agent-recipe-"))
const outputPath = join(tmp, "github-output.txt")
const recipePath = join(tmp, "recipe.json")

await writeFile(recipePath, JSON.stringify({
  schema: "wp-codebox/docs-agent-runner-recipe/v1",
  targetRepository: "Automattic/example-target",
  prompt: "Update docs.",
  policy: {
    requireAppToken: true,
    allowedRepositories: ["Automattic/example-target", "Automattic/docs-agent"],
  },
  runner: {
    verificationCommands: [{ command: "npm test", description: "Run docs checks" }],
  },
  engine: {
    outputMappings: { docs_pr_url: "metadata.engine_data.docs_agent.pr_url" },
  },
}))

await execFileAsync("node", [new URL("../scripts/prepare-docs-agent-runner-recipe.mjs", import.meta.url).pathname], {
  cwd: root.pathname,
  env: {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    RECIPE_PATH: recipePath,
    RECIPE_JSON: "",
    TARGET_REPO: "",
    PROMPT: "",
    GITHUB_REPOSITORY_NAME: "Automattic/caller",
  },
})

const outputs = await readFile(outputPath, "utf8")
assert.match(outputs, /target_repo<<__WP_CODEBOX_OUTPUT__\nAutomattic\/example-target\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /bundle_repo<<__WP_CODEBOX_OUTPUT__\nhttps:\/\/github.com\/Automattic\/docs-agent.git\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /agent_slug<<__WP_CODEBOX_OUTPUT__\ndocs-agent\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /require_app_token<<__WP_CODEBOX_OUTPUT__\ntrue\n__WP_CODEBOX_OUTPUT__/)
assert.match(outputs, /verification_commands<<__WP_CODEBOX_OUTPUT__\n\[{"command":"npm test","description":"Run docs checks"}\]\n__WP_CODEBOX_OUTPUT__/)

console.log("docs agent reusable workflow ok")
