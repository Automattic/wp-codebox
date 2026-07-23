import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeBoundedRecipePlan } from "../packages/cli/src/bounded-recipe-plan.js"
import type { ExecutionSpec, Runtime } from "../packages/runtime-core/src/index.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-bounded-recipe-plan-"))
const executed: ExecutionSpec[] = []
let active = 0
let maximumActive = 0
const runtime = {
  async execute(spec: ExecutionSpec) {
    executed.push(spec)
    active++
    maximumActive = Math.max(maximumActive, active)
    try {
      await new Promise((resolve) => setTimeout(resolve, spec.args?.some((arg) => arg.includes("suite-one")) ? 15 : 1))
      const failed = spec.args?.some((arg) => arg.includes("suite-failed"))
      return {
        id: failed ? "failed" : "one",
        command: spec.command,
        args: spec.args ?? [],
        exitCode: failed ? 1 : 0,
        stdout: failed ? "" : "password=entry-secret\n",
        stderr: failed ? "database entry-secret failed\n" : "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        artifactRefs: [{ kind: "test", id: "runtime-ref", path: "runtime/ref.json" }],
      }
    } finally {
      active--
    }
  },
} as Runtime

try {
  const result = await executeBoundedRecipePlan(runtime, {
    schema: "wp-codebox/bounded-runtime-plan/v1",
    concurrency: 2,
    entries: [
      { id: "one", argv: ["wordpress.run-php", "code=suite-one", "env-json={\"BASE\":\"base\"}"], environment: { DB_PASSWORD: "entry-secret" }, processIdentity: "one", artifactNamespace: "entries/one", inputIndex: 0 },
      { id: "failed", argv: ["wordpress.run-php", "code=suite-failed"], environment: { DB_PASSWORD: "entry-secret" }, processIdentity: "failed", artifactNamespace: "entries/failed", inputIndex: 1 },
    ],
  }, { artifactRoot: root, recipeDirectory: root })

  assert.equal(maximumActive, 2)
  assert.deepEqual(result.entries.map((entry) => entry.id), ["one", "failed"])
  assert.deepEqual(result.counts, { total: 2, succeeded: 1, failed: 1, timedOut: 0, cancelled: 0 })
  assert.equal(result.entries[0]?.stdoutRef, "entries/one/stdout.txt")
  assert.equal(result.entries[1]?.resultRef, "entries/failed/result.json")
  assert.deepEqual(result.entries[0]?.artifactRefs, ["runtime/ref.json"])
  const firstExecution = executed.find((spec) => spec.args?.some((arg) => arg.includes("suite-one")))
  const firstEnvironmentArg = firstExecution?.args?.find((arg) => arg.startsWith("env-json="))
  assert.deepEqual(JSON.parse(firstEnvironmentArg?.slice("env-json=".length) ?? "{}"), { BASE: "base" })
  assert.deepEqual(firstExecution?.environment, { DB_PASSWORD: "entry-secret" })
  assert.equal(await readFile(join(root, "entries/one/stdout.txt"), "utf8"), "password=[redacted]\n")
  assert.equal(await readFile(join(root, "entries/failed/stderr.txt"), "utf8"), "database [redacted] failed\n")
  assert.equal(JSON.parse(await readFile(join(root, "bounded-plan/result.json"), "utf8")).schema, "wp-codebox/bounded-runtime-plan-result/v1")
  const progress = JSON.parse(await readFile(join(root, "bounded-plan/progress.json"), "utf8"))
  assert.equal(progress.schema, "wp-codebox/bounded-runtime-plan-progress/v1")
  assert.equal(progress.complete, true)
  assert.deepEqual(progress.counts, { total: 2, succeeded: 1, failed: 1, timedOut: 0, cancelled: 0, unfinished: 0 })
  assert.deepEqual(progress.entries.map((entry: { id: string }) => entry.id), ["one", "failed"])
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("bounded recipe plan tests passed")
