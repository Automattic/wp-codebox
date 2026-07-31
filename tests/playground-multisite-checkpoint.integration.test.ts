import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-multisite-checkpoint-"))
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")

try {
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", blueprint: { steps: [] } },
    workflow: {
      steps: [
        { command: "wordpress.wp-cli", args: ["command=wp core multisite-convert --title=Checkpoint --base=/"] },
        { command: "wordpress.wp-cli", args: ["command=wp site create --slug=second --title=Second --porcelain"] },
        { command: "wordpress.run-php", args: ["code=update_option('checkpoint_value','baseline'); switch_to_blog(2); update_option('checkpoint_value','baseline'); restore_current_blog();"] },
        { command: "wp-codebox.checkpoint-create", args: ["name=multisite-baseline"] },
        { command: "wordpress.run-php", args: ["code=update_option('checkpoint_value','mutated'); switch_to_blog(2); update_option('checkpoint_value','mutated'); restore_current_blog();"] },
        { command: "wp-codebox.checkpoint-restore", args: ["name=multisite-baseline"] },
        { command: "wordpress.run-php", args: ["code=$second=get_sites(array('number'=>1,'path'=>'/second/'))[0]??null; if(get_option('checkpoint_value')!=='baseline'||!$second){exit(1);} switch_to_blog((int)$second->blog_id); $value=get_option('checkpoint_value'); restore_current_blog(); if($value!=='baseline'){exit(1);} echo 'restored';"] },
      ],
    },
  })}\n`)

  const output = await runRecipe()
  if (output) {
    assert.equal(output.success, true, JSON.stringify(output))
    assert.equal(output.executions?.at(-1)?.stdout, "restored")
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
      console.log("playground multisite checkpoint integration skipped: WordPress runtime source unavailable")
      return undefined
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

console.log("playground multisite checkpoint integration ok")
