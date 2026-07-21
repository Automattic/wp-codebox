import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const secret = "sk-abcdefghijklmnopqrstuvwxyz"
const root = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-bootstrap-failure-"))
const fatalMuPlugin = join(root, "fatal-bootstrap.php")
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")
const exitArtifactsPath = join(root, "exit-artifacts")

try {
  await writeFile(fatalMuPlugin, `<?php\ntrigger_error('PHPUnit bootstrap fixture token: ${secret}', E_USER_ERROR);\n`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "6.5", blueprint: { steps: [] } },
    inputs: {
      mounts: [{
        source: fatalMuPlugin,
        target: "/wordpress/wp-content/mu-plugins/wp-codebox-bootstrap-failure.php",
        mode: "readonly",
      }],
    },
    workflow: {
      steps: [{ command: "wordpress.phpunit", args: ["plugin-slug=bootstrap-failure-fixture"] }],
    },
  })}\n`)

  const output = await runFailedRecipe()
  assert.equal(output.success, false, JSON.stringify(output))
  const message = output.error?.message ?? ""
  assert.match(message, /wordpress\.phpunit crashed before producing a structured response/)
  assert.match(message, /failureClassification=runtime-worker-failure/)
  assert.match(message, /wordpress\.phpunit structured diagnostics/)
  assert.match(message, /PHPUnit bootstrap fixture token: \[redacted\]/)
  assert.doesNotMatch(message, new RegExp(secret))

  const latest = JSON.parse(await readFile(join(artifactsPath, "latest-runtime.json"), "utf8")) as { paths?: { runtimeDirectory?: string } }
  const runtimeDirectory = latest.paths?.runtimeDirectory
  assert.ok(runtimeDirectory, "failed recipe must retain a runtime artifact directory")
  const artifactDirectory = join(artifactsPath, runtimeDirectory)
  const diagnostic = await readFile(join(artifactDirectory, "files", "phpunit", ".pg-test-result.txt"), "utf8")
  const commandLog = await readFile(join(artifactDirectory, "logs", "commands.log"), "utf8")
  assert.match(diagnostic, /STAGE_FATAL:bootstrap:PHPUnit bootstrap fixture token: \[redacted\]/)
  assert.doesNotMatch(diagnostic, new RegExp(secret))
  assert.match(commandLog, /wordpress\.phpunit structured diagnostics/)
  assert.match(commandLog, /PHPUnit bootstrap fixture token: \[redacted\]/)
  assert.doesNotMatch(commandLog, new RegExp(secret))

  await writeFile(fatalMuPlugin, `<?php\necho 'PHPUnit bootstrap exit fixture token: ${secret}';\nexit(1);\n`)
  const exitOutput = await runFailedRecipe(exitArtifactsPath)
  assert.equal(exitOutput.success, false, JSON.stringify(exitOutput))
  const exitMessage = exitOutput.error?.message ?? ""
  assert.match(exitMessage, /wordpress\.phpunit structured diagnostics/)
  assert.match(exitMessage, /PHPUnit bootstrap exit fixture token: \[redacted\]/)
  assert.doesNotMatch(exitMessage, new RegExp(secret))

  const exitLatest = JSON.parse(await readFile(join(exitArtifactsPath, "latest-runtime.json"), "utf8")) as { paths?: { runtimeDirectory?: string } }
  const exitRuntimeDirectory = exitLatest.paths?.runtimeDirectory
  assert.ok(exitRuntimeDirectory, "terminated recipe must retain a runtime artifact directory")
  const exitDiagnostic = await readFile(join(exitArtifactsPath, exitRuntimeDirectory, "files", "phpunit", ".pg-test-result.txt"), "utf8")
  assert.match(exitDiagnostic, /STAGE_DIE:bootstrap:PHPUnit bootstrap exit fixture token: \[redacted\]/)
  assert.doesNotMatch(exitDiagnostic, new RegExp(secret))
} finally {
  await rm(root, { recursive: true, force: true })
}

async function runFailedRecipe(outputPath = artifactsPath): Promise<RecipeRunOutput> {
  try {
    const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", outputPath, "--json"], {
      cwd: process.cwd(),
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return recipeRunOutput(result.stdout)
  } catch (error) {
    const output = recipeRunOutput(error && typeof error === "object" && "stdout" in error ? error.stdout : undefined)
    if (output) {
      return output
    }
    throw error
  }
}

interface RecipeRunOutput {
  success?: boolean
  error?: { message?: string }
}

function recipeRunOutput(value: unknown): RecipeRunOutput {
  assert.equal(typeof value, "string", "recipe-run must return JSON output")
  return JSON.parse(value) as RecipeRunOutput
}

console.log("playground phpunit bootstrap failure integration ok")
