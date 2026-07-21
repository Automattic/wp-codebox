import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-bounded-recipe-integration-"))
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")
const plan = {
  schema: "wp-codebox/bounded-runtime-plan/v1",
  concurrency: 2,
  entries: [
    { id: "one", argv: ["wordpress.run-php", "bootstrap=none", "code=usleep(20000); echo getenv('DB_INDEX');"], environment: { DB_INDEX: "db-one" }, timeoutMs: 30_000, processIdentity: "one", artifactNamespace: "entries/one", inputIndex: 0 },
    { id: "two", argv: ["wordpress.run-php", "bootstrap=none", "code=echo getenv('DB_INDEX');"], environment: { DB_INDEX: "db-two" }, timeoutMs: 30_000, processIdentity: "two", artifactNamespace: "entries/two", inputIndex: 1 },
  ],
}

try {
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", blueprint: { steps: [] } },
    workflow: { steps: [{ command: "wp-codebox.bounded-runtime-plan", args: [`plan-json=${JSON.stringify(plan)}`] }] },
  })}\n`)
  const command = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
    cwd: process.cwd(),
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const output = JSON.parse(command.stdout)
  assert.equal(output.success, true, command.stdout)
  assert.doesNotMatch(command.stdout, /db-one|db-two/, "entry environment values must not appear in recipe-run output")
  const aggregate = JSON.parse(await readFile(join(artifactsPath, "bounded-plan/result.json"), "utf8"))
  assert.deepEqual(aggregate.counts, { total: 2, succeeded: 2, failed: 0, timedOut: 0, cancelled: 0 })
  assert.deepEqual(aggregate.entries.map((entry: { id: string }) => entry.id), ["one", "two"])
  assert.equal(await readFile(join(artifactsPath, "entries/one/stdout.txt"), "utf8"), "[redacted]")
  assert.equal(await readFile(join(artifactsPath, "entries/two/stdout.txt"), "utf8"), "[redacted]")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("bounded recipe plan integration passed")
