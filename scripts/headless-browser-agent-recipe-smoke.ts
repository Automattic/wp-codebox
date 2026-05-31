import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const recipePath = "./examples/recipes/cookbook/headless-browser-agent-task.json"
const artifactsRoot = resolve(repoRoot, "artifacts", "headless-browser-agent-recipe-smoke")

await rm(artifactsRoot, { recursive: true, force: true })

const output = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  artifactsRoot,
  "--json",
])

assert.equal(output.success, true, output.error?.message ?? "headless browser-agent recipe failed")
assert.equal(output.schema, "wp-codebox/recipe-run/v1")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")
assert.ok(output.executions.some((execution: { recipeCommand?: string }) => execution.recipeCommand === "wp-codebox.agent-sandbox-run"), "recipe should include an agent sandbox run step")
assert.equal(output.agentResult?.schema, "wp-codebox/agent-result/v1")
assert.equal(output.agentResult?.status, "completed")

const artifactDirectory = output.artifacts.directory
const browserDirectory = join(artifactDirectory, "files", "browser")
const summaryPath = join(browserDirectory, "summary.json")
const actionSummaryPath = join(browserDirectory, "action-summary.json")
const stepsPath = join(browserDirectory, "steps.jsonl")
const screenshotPath = join(browserDirectory, "screenshot-agent-task-completed.png")
const transcriptPath = join(artifactDirectory, "files", "transcript.json")
const agentResultPath = join(artifactDirectory, "files", "agent-result.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(summaryPath), true, "browser probe summary should be captured")
assert.equal(existsSync(actionSummaryPath), true, "browser action summary should be captured")
assert.equal(existsSync(stepsPath), true, "browser action steps should be captured")
assert.equal(existsSync(screenshotPath), true, "named completion screenshot should be captured")
assert.equal(existsSync(transcriptPath), true, "agent transcript should be captured")
assert.equal(existsSync(agentResultPath), true, "agent result summary should be captured")

const steps = await readFile(stepsPath, "utf8")
assert.match(steps, /"kind":"navigate"/)
assert.match(steps, /"kind":"expect"/)
assert.match(steps, /"kind":"screenshot"/)

const actionSummary = JSON.parse(await readFile(actionSummaryPath, "utf8")) as { assertions?: { total: number; passed: number; failed: number }; summary?: { replayability?: string } }
assert.equal(actionSummary.assertions?.total, 2)
assert.equal(actionSummary.assertions?.passed, 2)
assert.equal(actionSummary.assertions?.failed, 0)
assert.equal(actionSummary.summary?.replayability, "artifact-backed")

const transcript = JSON.parse(await readFile(transcriptPath, "utf8")) as { executions: Array<{ parsed?: { output?: string } }> }
const agentOutput = JSON.parse(transcript.executions[0]?.parsed?.output ?? "{}") as { schema?: string; status?: string }
assert.equal(agentOutput.schema, "wp-codebox/headless-browser-agent-task-demo/v1")
assert.equal(agentOutput.status, "completed")

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: unknown[] } }
assert.ok((review.browser?.probes?.length ?? 0) >= 2, "review should summarize browser evidence")

console.log(`Headless browser-agent recipe smoke passed: ${artifactDirectory}`)

async function runCli(args: string[]): Promise<any> {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number | null>((resolveExit) => {
    const timeout = setTimeout(() => {
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGTERM")
        } else {
          child.kill("SIGTERM")
        }
      } catch {
        child.kill("SIGTERM")
      }
      resolveExit(null)
    }, 300_000)
    child.once("exit", (code) => {
      clearTimeout(timeout)
      resolveExit(code)
    })
  })
  assert.equal(exitCode, 0, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  return JSON.parse(stdout)
}
