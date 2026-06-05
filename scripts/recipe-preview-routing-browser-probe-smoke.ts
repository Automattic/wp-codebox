import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-preview-routing-"))

try {
  const recipePort = await reserveFreePort()
  const recipePublicUrl = `http://127.0.0.1:${recipePort}/public-route/`
  const recipePath = await writeRecipe("recipe-preview.json", recipePort, recipePublicUrl)
  const recipeOutput = await runCliJson(["recipe-run", "--recipe", recipePath, "--json"])

  assert.equal(recipeOutput.success, true, recipeOutput.error?.message ?? "recipe-run failed")
  const recipeSummary = await browserSummary(recipeOutput)
  assert.equal(recipeSummary.requestedUrl, `${recipePublicUrl}relative-probe`)
  assert.equal(recipeSummary.localPreviewOrigin.startsWith("http://127.0.0.1:"), true)
  assert.equal(recipeSummary.requestedPreviewOrigin, recipePublicUrl)
  assert.equal(recipeSummary.effectivePreviewOrigin, recipePublicUrl)
  assert.equal(recipeOutput.artifacts.preview.url, recipePublicUrl)
  assert.equal(recipeOutput.artifacts.preview.localUrl.startsWith("http://127.0.0.1:"), true)

  const recipeReview = await review(recipeOutput)
  assert.equal(recipeReview.browser?.probes?.[0]?.requestedUrl, `${recipePublicUrl}relative-probe`)
  assert.equal(recipeReview.browser?.probes?.[0]?.localPreviewOrigin?.startsWith("http://127.0.0.1:"), true)
  assert.equal(recipeReview.browser?.probes?.[0]?.requestedPreviewOrigin, recipePublicUrl)
  assert.equal(recipeReview.browser?.probes?.[0]?.effectivePreviewOrigin, recipePublicUrl)

  const overridePort = await reserveFreePort()
  const staleRecipePublicUrl = "https://stale-preview.example.test/"
  const overridePublicUrl = `http://127.0.0.1:${overridePort}/cli-route/`
  const overrideRecipePath = await writeRecipe("recipe-preview-override.json", overridePort, staleRecipePublicUrl)
  const overrideOutput = await runCliJson([
    "recipe-run",
    "--recipe",
    overrideRecipePath,
    "--preview-public-url",
    overridePublicUrl,
    "--json",
  ])

  assert.equal(overrideOutput.success, true, overrideOutput.error?.message ?? "recipe-run with CLI preview override failed")
  const overrideSummary = await browserSummary(overrideOutput)
  assert.equal(overrideSummary.requestedUrl, `${overridePublicUrl}relative-probe`)
  assert.equal(overrideSummary.requestedPreviewOrigin, overridePublicUrl)
  assert.equal(overrideSummary.effectivePreviewOrigin, overridePublicUrl)
  assert.equal(overrideOutput.artifacts.preview.url, overridePublicUrl)

  const overrideMetadata = JSON.parse(await readFile(overrideOutput.artifacts.metadataPath, "utf8")) as { provenance?: { task?: { preview?: { requested?: { publicUrl?: string }; effective?: { publicUrl?: string }; cliOverrides?: { publicUrl?: string } } } } }
  assert.equal(overrideMetadata.provenance?.task?.preview?.requested?.publicUrl, staleRecipePublicUrl)
  assert.equal(overrideMetadata.provenance?.task?.preview?.effective?.publicUrl, overridePublicUrl)
  assert.equal(overrideMetadata.provenance?.task?.preview?.cliOverrides?.publicUrl, overridePublicUrl)

  console.log("Recipe preview routing browser probe smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeRecipe(name: string, port: number, publicUrl: string): Promise<string> {
  const recipePath = join(workspace, name)
  const artifactsDirectory = join(workspace, `${name}-artifacts`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      preview: {
        port,
        publicUrl,
      },
    },
    workflow: {
      steps: [
        {
          command: "wordpress.browser-probe",
          args: [
            "url=relative-probe",
            "wait-for=domcontentloaded",
            "capture=html",
          ],
        },
      ],
    },
    artifacts: {
      directory: artifactsDirectory,
    },
  }, null, 2)}\n`)

  return recipePath
}

async function browserSummary(output: { artifacts?: { directory?: string } }): Promise<{ requestedUrl: string; localPreviewOrigin: string; requestedPreviewOrigin?: string; effectivePreviewOrigin: string }> {
  assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")
  return JSON.parse(await readFile(join(output.artifacts.directory, "files", "browser", "summary.json"), "utf8"))
}

async function review(output: { artifacts?: { directory?: string } }): Promise<{ browser?: { probes?: Array<{ requestedUrl?: string; localPreviewOrigin?: string; requestedPreviewOrigin?: string; effectivePreviewOrigin?: string }> } }> {
  assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")
  return JSON.parse(await readFile(join(output.artifacts.directory, "files", "review.json"), "utf8"))
}

async function runCliJson(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", ...args], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  })
  return JSON.parse(stdout)
}

async function reserveFreePort(): Promise<number> {
  const server = await listenOnPort(0)
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await closeServer(server)
  return port
}

async function listenOnPort(port: number): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(port, "127.0.0.1", () => resolveListen())
  })
  return server
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}
