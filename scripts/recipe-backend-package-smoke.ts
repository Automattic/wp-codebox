import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-backend-package-"))

try {
  const fixtureBackendPackage = join(workspace, "fixture-playground-cli")
  const fixtureBackend = join(fixtureBackendPackage, "index.mjs")
  const incompatibleBackend = join(workspace, "incompatible-playground-cli.mjs")
  const marker = join(workspace, "fixture-options.json")
  const artifacts = join(workspace, "artifacts")
  const recipePath = join(workspace, "recipe.json")
  const incompatibleRecipePath = join(workspace, "incompatible-recipe.json")

  await mkdir(fixtureBackendPackage, { recursive: true })
  await writeFile(join(fixtureBackendPackage, "package.json"), `${JSON.stringify({ name: "@wp-playground/cli-fixture", version: "0.0.408", type: "module", exports: "./index.mjs" }, null, 2)}\n`)
  await writeFile(fixtureBackend, `import { writeFileSync } from "node:fs"

export async function runCLI(options) {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ mount: options.mount, wp: options.wp, siteUrl: options["site-url"] }, null, 2))
  return {
    serverUrl: "http://127.0.0.1:49999",
    playground: {
      async run() {
        return { exitCode: 0, text: "fixture-backend\\n" }
      },
      async writeFile() {},
    },
    async [Symbol.asyncDispose]() {},
  }
}
`)
  await writeFile(incompatibleBackend, `export const notRunCLI = true
`)

  const recipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      backend: "wordpress-playground",
      name: "backend-package-smoke",
      wp: "7.0",
      backendPackage: {
        kind: "playground",
        source: fixtureBackendPackage,
        package: "@wp-playground/cli-fixture",
        metadata: { ref: "fixture-ref" },
      },
    },
    workflow: {
      steps: [{ command: "wordpress.run-php", args: ["code=echo 'default backend must be replaced';"] }],
    },
    artifacts: { directory: artifacts },
  }
  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`)
  await writeFile(incompatibleRecipePath, `${JSON.stringify({ ...recipe, runtime: { ...recipe.runtime, backendPackage: { kind: "playground", source: incompatibleBackend } }, artifacts: { directory: join(workspace, "bad-artifacts") } }, null, 2)}\n`)

  const dryRun = await recipeRunJson(["--recipe", recipePath, "--dry-run", "--json"])
  assert.equal(dryRun.success, true, dryRun.error?.message)
  assert.equal(dryRun.plan.runtime.backendPackage.source, fixtureBackendPackage)
  assert.equal(dryRun.plan.mounts.some((mount: { metadata?: { kind?: string } }) => mount.metadata?.kind === "runtime-overlay"), false)

  const output = await recipeRunJson(["--recipe", recipePath, "--json"])
  assert.equal(output.success, true, output.error?.message)
  assert.equal(output.executions[0]?.stdout, "fixture-backend\n")

  const fixtureOptions = JSON.parse(await readFile(marker, "utf8"))
  assert.deepEqual(fixtureOptions.mount, [])

  const metadata = JSON.parse(await readFile(join(output.artifacts.directory, "metadata.json"), "utf8"))
  assert.equal(metadata.context.preparedRuntimeOverlays.length, 0)
  assert.equal(metadata.context.preparedRuntimeBackend.schema, "wp-codebox/runtime-backend-package/v1")
  assert.equal(metadata.context.preparedRuntimeBackend.source, fixtureBackendPackage)
  assert.equal(metadata.context.preparedRuntimeBackend.package.name, "@wp-playground/cli-fixture")
  assert.equal(metadata.context.preparedRuntimeBackend.package.version, "0.0.408")
  assert.match(metadata.context.preparedRuntimeBackend.package.digest.sha256, /^[a-f0-9]{64}$/)
  assert.equal(metadata.context.preparedRuntimeBackend.metadata.ref, "fixture-ref")
  assert.match(metadata.context.preparedRuntimeBackend.entrypointDigest.sha256, /^[a-f0-9]{64}$/)
  assert.equal(metadata.provenance.runtime.backendPackage.source, fixtureBackendPackage)

  const bad = await recipeRunJson(["--recipe", incompatibleRecipePath, "--json"], false)
  assert.equal(bad.success, false)
  assert.equal(bad.runtime, undefined, "incompatible backend packages must fail before runtime creation")
  assert.equal(bad.error.code, "recipe-runtime-backend-package-invalid")
  assert.equal(bad.diagnostics[0]?.phase, "backend-preparation")

  console.log("Recipe backend package smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function recipeRunJson(args: string[], expectSuccess = true): Promise<any> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", ...args], { cwd: root })
    return JSON.parse(stdout)
  } catch (error) {
    if (!expectSuccess && error && typeof error === "object" && "stdout" in error) {
      return JSON.parse(String((error as { stdout: string }).stdout))
    }
    throw error
  }
}
