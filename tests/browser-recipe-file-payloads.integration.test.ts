import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = await mkdtemp(join(tmpdir(), "wp-codebox-browser-recipe-files-"))
const recipeDirectory = join(root, "recipe")
const invocationDirectory = join(root, "invocation")
const cli = join(repositoryRoot, "packages/cli/dist/index.js")

try {
  await Promise.all([mkdir(recipeDirectory), mkdir(invocationDirectory)])
  await writeFile(join(recipeDirectory, "action-steps.json"), JSON.stringify([{ kind: "evaluate", expression: "document.documentElement.dataset.actionRecipe = 'ready'", assert: "ready" }]))
  await writeFile(join(recipeDirectory, "scenario.json"), JSON.stringify({ url: "about:blank", captures: ["steps"], steps: [{ kind: "evaluate", expression: "document.documentElement.dataset.scenarioRecipe = 'ready'", assert: "ready" }] }))
  await writeFile(join(recipeDirectory, "scenario-steps.json"), JSON.stringify([{ kind: "evaluate", expression: "document.documentElement.dataset.scenarioStepsRecipe = 'ready'", assert: "ready" }]))
  await writeFile(join(recipeDirectory, "valid-recipe.json"), JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", blueprint: { steps: [] } },
    workflow: { steps: [
      { command: "wordpress.browser-actions", args: ["url=about:blank", "steps-json=@action-steps.json", "capture=steps"] },
      { command: "wordpress.browser-scenario", args: ["scenario-json=@scenario.json"] },
      { command: "wordpress.browser-scenario", args: ["url=about:blank", "steps-json=@scenario-steps.json", "capture=steps"] },
    ] },
  }))

  const validDryRun = await execFileAsync(process.execPath, [cli, "recipe-run", "--recipe", join(recipeDirectory, "valid-recipe.json"), "--dry-run", "--json"], {
    cwd: invocationDirectory,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const validDryRunOutput = JSON.parse(validDryRun.stdout)
  assert.equal(validDryRunOutput.plan.policy.commands.includes("wordpress.browser-actions.evaluate"), true)

  const valid = await execFileAsync(process.execPath, [cli, "recipe-run", "--recipe", join(recipeDirectory, "valid-recipe.json"), "--artifacts", join(root, "valid-artifacts"), "--json"], {
    cwd: invocationDirectory,
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const validOutput = JSON.parse(valid.stdout)
  assert.equal(validOutput.success, true, valid.stdout)
  assert.equal(validOutput.executions.length, 3)

  await writeFile(join(recipeDirectory, "malformed.json"), "{")
  await writeFile(join(recipeDirectory, "malformed-recipe.json"), JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [
      { command: "wordpress.browser-actions", args: ["url=/", "steps-json=@malformed.json"] },
      { command: "wordpress.browser-scenario", args: ["scenario-json=@malformed.json"] },
      { command: "wordpress.browser-scenario", args: ["url=/", "steps-json=@malformed.json"] },
    ] },
  }))

  let malformedStdout = ""
  try {
    await execFileAsync(process.execPath, [cli, "recipe-run", "--recipe", join(recipeDirectory, "malformed-recipe.json"), "--dry-run", "--json"], {
      cwd: invocationDirectory,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    assert.fail("Malformed file-backed browser payloads should fail recipe validation")
  } catch (error) {
    malformedStdout = String((error as { stdout?: string }).stdout ?? "")
  }
  const malformedOutput = JSON.parse(malformedStdout)
  assert.equal(malformedOutput.success, false)
  assert.deepEqual(malformedOutput.validation.issues.map((issue: { code: string }) => issue.code), ["invalid-steps-json", "invalid-scenario-json", "invalid-steps-json"])
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("browser recipe file payload integration passed")
