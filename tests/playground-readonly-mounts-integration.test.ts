import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-readonly-mounts-integration-"))
const projectSource = join(root, "project")
const projectConfigSource = join(projectSource, "config.php")
const overlaySource = join(root, "config-overlay.php")
const readonlySource = join(root, "readonly.bin")
const readwriteSource = join(root, "readwrite.bin")
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")
const originalConfig = "<?php return 'parent';\n"
const overlayConfig = "<?php return 'overlay';\n"
const readonlyBytes = Buffer.from([0, 255, 1, 2, 3, 127, 128])
const overwrittenBytes = Buffer.from([128, 127, 3, 2, 1, 255, 0])
const stagingDirectoriesBefore = await readonlyStagingDirectories()

try {
  await mkdir(projectSource)
  await writeFile(projectConfigSource, originalConfig)
  await writeFile(overlaySource, overlayConfig)
  await writeFile(readonlySource, readonlyBytes)
  await writeFile(readwriteSource, readonlyBytes)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "6.5", blueprint: { steps: [] } },
    inputs: {
      mounts: [
        { source: projectSource, target: "/home/project", mode: "readwrite" },
        { source: overlaySource, target: "/home/project/config.php", mode: "readonly" },
        { source: readonlySource, target: "/wordpress/readonly.bin", mode: "readonly" },
        { source: readwriteSource, target: "/wordpress/readwrite.bin", mode: "readwrite" },
      ],
    },
    workflow: {
      steps: [{
        command: "wordpress.run-php",
        args: [`code=$config = file_get_contents('/home/project/config.php'); if ($config !== "<?php return 'overlay';\\n") { fwrite(STDERR, $config); exit(1); } $contents = base64_decode('${overwrittenBytes.toString("base64")}'); file_put_contents('/home/project/config.php', "overwritten"); file_put_contents('/home/project/mutated.txt', 'parent mutation'); file_put_contents('/wordpress/readonly.bin', $contents); file_put_contents('/wordpress/readwrite.bin', $contents);`],
      }],
    },
  })}\n`)

  const output = await runRecipe()
  if (output) {
    assert.equal(output.success, true, JSON.stringify(output))
    assert.equal(sha256(await readFile(readonlySource)), sha256(readonlyBytes), "readonly host bytes must survive an actual Playground PHP overwrite")
    assert.deepEqual(await readFile(readwriteSource), overwrittenBytes, "readwrite host bytes must reflect an actual Playground PHP overwrite")
    assert.equal(await readFile(overlaySource, "utf8"), overlayConfig, "readonly overlay source must survive an actual Playground PHP overwrite")
    assert.equal(await readFile(projectConfigSource, "utf8"), originalConfig, "the parent writeback must exclude the nested overlay path")
    assert.equal(await readFile(join(projectSource, "mutated.txt"), "utf8"), "parent mutation", "parent readwrite mutations must still materialize")
    assert.deepEqual(await readonlyStagingDirectories(), stagingDirectoriesBefore, "recipe-run cleanup must remove readonly mount staging")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

assert.equal(isUnavailableWordPressRuntimeSource({
  stdout: JSON.stringify({
    schema: "wp-codebox/recipe-run/v1",
    success: false,
    phaseEvidence: [{ name: "runtime_startup", status: "failed", error: { message: "Unable to resolve Playground startup asset wordpress-archive-cache for WordPress 6.5: fetch failed" } }],
  }),
}), true, "only a structured pre-runtime WordPress archive acquisition failure may skip")

assert.equal(isUnavailableWordPressRuntimeSource({
  stdout: JSON.stringify({
    schema: "wp-codebox/recipe-run/v1",
    success: false,
    phaseEvidence: [{ name: "runtime_startup", status: "completed" }, { name: "run_workloads", status: "failed", error: { message: "fetch failed" } }],
  }),
}), false, "a post-start failure containing fetch failed must fail the integration test")

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function readonlyStagingDirectories(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith("wp-codebox-readonly-mounts-")).sort()
}

async function runRecipe(): Promise<RecipeRunOutput | undefined> {
  try {
    const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
      cwd: process.cwd(),
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return recipeRunOutput(result.stdout)
  } catch (error) {
    if (isUnavailableWordPressRuntimeSource(error)) {
      console.log("playground readonly mount integration skipped: WordPress runtime source was unavailable before runtime startup")
      return undefined
    }
    throw error
  }
}

interface RecipeRunOutput {
  schema?: string
  success?: boolean
  phaseEvidence?: Array<{
    name?: string
    status?: string
    error?: { message?: string }
  }>
}

function isUnavailableWordPressRuntimeSource(error: unknown): boolean {
  const output = recipeRunOutput(error && typeof error === "object" && "stdout" in error ? error.stdout : undefined)
  const startup = output?.phaseEvidence?.find((phase) => phase.name === "runtime_startup")
  const message = startup?.error?.message ?? ""
  return output?.schema === "wp-codebox/recipe-run/v1"
    && startup?.status === "failed"
    && /Unable to resolve Playground startup asset (wordpress-archive-cache|wordpress-release-metadata)/.test(message)
    && /fetch failed|Could not resolve host|Connection timed out|network is unreachable/i.test(message)
}

function recipeRunOutput(value: unknown): RecipeRunOutput | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  try {
    const output = JSON.parse(value) as RecipeRunOutput
    return output && typeof output === "object" ? output : undefined
  } catch {
    return undefined
  }
}

console.log("playground readonly mount integration ok")
