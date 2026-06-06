import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-agent-fanout-phase-smoke")
const recipePath = resolve(workspace, "recipe.json")
const artifactDirectory = resolve(workspace, "artifacts")

const request = {
  schema: "wp-codebox/agent-fanout-request/v1",
  session_id: "fanout-smoke-parent",
  concurrency: 2,
  orchestrator: { surface: "browser-task-phase-smoke" },
  aggregation: {
    policy: "fail",
    outputNamespace: "aggregate/final",
  },
  workers: [
    {
      schema: "wp-codebox/agent-fanout-worker/v1",
      id: "design",
      goal: "Produce a design candidate.",
      agent: "generic-design-agent",
      artifactNamespace: "workers/design",
      artifactRefs: [{ path: "fanout/workers/design/artifacts/report.json", kind: "worker-report", finalPath: "aggregate/design.json" }],
    },
    {
      schema: "wp-codebox/agent-fanout-worker/v1",
      id: "copy",
      goal: "Produce a copy candidate.",
      agent: "generic-copy-agent",
      artifactNamespace: "workers/copy",
      artifactRefs: [{ path: "fanout/workers/copy/artifacts/report.json", kind: "worker-report", finalPath: "aggregate/copy.json" }],
    },
  ],
}

mkdirSync(workspace, { recursive: true })
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-agent-fanout-phase-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  workflow: {
    steps: [
      {
        command: "wp-codebox.agent-fanout",
        args: [`request-json=${JSON.stringify(request)}`],
      },
    ],
  },
}, null, 2)}\n`)

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  artifactDirectory,
  "--json",
], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

assert.equal(result.status, 0, result.stderr || result.stdout)
const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.executions[0].recipeCommand, "wp-codebox.agent-fanout")
const fanoutResult = JSON.parse(output.executions[0].stdout)
assert.equal(fanoutResult.schema, "wp-codebox/agent-fanout-result/v1")
assert.equal(fanoutResult.session.children.length, 2)
assert.equal(fanoutResult.aggregate.finalArtifactRefs[0].path, "aggregate/final/result.json")

const manifest = JSON.parse(readFileSync(output.artifacts.manifestPath, "utf8")) as { files: Array<{ path: string; kind: string; contentType?: string }> }
const metadata = JSON.parse(readFileSync(output.artifacts.metadataPath, "utf8"))

const expectedFiles = [
  ["files/runtime-evidence/fanout/plan.json", "agent-fanout-plan"],
  ["files/runtime-evidence/fanout/events.jsonl", "agent-fanout-event-log"],
  ["files/runtime-evidence/fanout/workers/design/result.json", "agent-fanout-worker-result:design"],
  ["files/runtime-evidence/fanout/workers/copy/result.json", "agent-fanout-worker-result:copy"],
  ["files/runtime-evidence/fanout/aggregate/input.json", "agent-fanout-aggregation-input"],
  ["files/runtime-evidence/fanout/aggregate/result.json", "agent-fanout-aggregation-output"],
  ["files/runtime-evidence/aggregate/final/result.json", "agent-fanout-aggregate-final"],
  ["files/runtime-evidence/fanout/result.json", "agent-fanout-result"],
] as const

for (const [path, kind] of expectedFiles) {
  assert.ok(manifest.files.some((file) => file.path === path && file.kind === kind), `Expected ${kind} at ${path}`)
}

const eventPath = join(output.artifacts.directory, "files/runtime-evidence/fanout/events.jsonl")
const events = readFileSync(eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
assert.ok(events.every((event) => event.schema === "wp-codebox/agent-fanout-event/v1"))
assert.deepEqual(events.map((event) => event.event), [
  "fanout.started",
  "worker.started",
  "worker.completed",
  "worker.started",
  "worker.completed",
  "aggregation.started",
  "aggregation.completed",
  "fanout.completed",
])
assert.equal(metadata.evidence.runtimeEvidence["agent-fanout-event-log"].path, "files/runtime-evidence/fanout/events.jsonl")

console.log("recipe agent fanout phase smoke passed")
