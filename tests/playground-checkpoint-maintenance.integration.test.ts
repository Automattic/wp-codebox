import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-checkpoint-maintenance-"))
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")

try {
  const maintenanceCase = (id: string) => ({
    id,
    target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
    input: {
      schema: "wp-codebox/wordpress-workload-run/v1",
      steps: [
        {
          command: "wordpress.run-php",
          args: ["code=$path=ABSPATH.'.maintenance'; file_put_contents(ABSPATH.'remove-maintenance.php',\"<?php unlink(__DIR__ . '/.maintenance'); echo file_exists(__DIR__ . '/.maintenance') ? 'present' : 'absent';\"); file_put_contents($path,'<?php $upgrading = time();'); clearstatcache(true); file_exists($path); echo 'primed';"],
        },
        { command: "wordpress.http-request", args: ["url=/remove-maintenance.php", "expect-status=200"] },
      ],
    },
  })
  const suite = {
    schema: "wp-codebox/fuzz-suite/v1",
    id: "checkpoint-maintenance-coherence",
    resetPolicy: { mode: "checkpoint-per-case", checkpointName: "maintenance-baseline" },
    cases: [maintenanceCase("maintenance-one"), maintenanceCase("maintenance-two"), maintenanceCase("maintenance-three")],
  }

  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "nightly", phpVersion: "8.3", blueprint: { steps: [] } },
    workflow: {
      steps: [{ command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(suite)}`] }],
    },
  })}\n`)

  const output = await runRecipe()
  if (output) {
    assert.equal(output.success, true, JSON.stringify(output))
    const result = JSON.parse(output.executions?.[0]?.stdout ?? "{}")
    assert.equal(result.status, "passed", JSON.stringify(result))
    assert.deepEqual(result.cases.map((fuzzCase: { reset?: { mode?: string; status?: string } }) => [fuzzCase.reset?.mode, fuzzCase.reset?.status]), [
      ["checkpoint-per-case", "passed"],
      ["checkpoint-per-case", "passed"],
      ["checkpoint-per-case", "passed"],
    ])
    for (const fuzzCase of result.cases) {
      assert.equal(JSON.stringify(fuzzCase).includes("absent"), true, JSON.stringify(fuzzCase))
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

async function runRecipe(): Promise<RecipeRunOutput | undefined> {
  try {
    const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
      cwd: process.cwd(),
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return JSON.parse(result.stdout) as RecipeRunOutput
  } catch (error) {
    const output = recipeRunOutput(error && typeof error === "object" && "stdout" in error ? error.stdout : undefined)
    const message = output?.phaseEvidence?.find((phase) => phase.name === "runtime_startup")?.error?.message ?? ""
    if (/Unable to resolve Playground startup asset.*fetch failed|Could not resolve host|network is unreachable/i.test(message)) {
      console.log("playground checkpoint maintenance integration skipped: WordPress runtime source unavailable")
      return undefined
    }
    if (output?.executions?.[0]?.stdout) {
      const result = JSON.parse(output.executions[0].stdout) as { cases?: unknown }
      throw new Error(`Checkpoint maintenance fuzz failure: ${JSON.stringify(result.cases)}`)
    }
    throw error
  }
}

function recipeRunOutput(value: unknown): RecipeRunOutput | undefined {
  if (typeof value !== "string") return undefined
  try { return JSON.parse(value) as RecipeRunOutput } catch { return undefined }
}

interface RecipeRunOutput {
  success?: boolean
  executions?: Array<{ stdout: string }>
  phaseEvidence?: Array<{ name?: string; error?: { message?: string } }>
}

console.log("playground checkpoint maintenance integration ok")
