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
  assert.equal(recipeSummary.preview.requestedMode, "public")
  assert.equal(recipeSummary.preview.effectiveMode, "public")
  assert.equal(recipeSummary.preview.secureContext, true)
  assert.equal(recipeSummary.windowLocationOrigin, new URL(recipePublicUrl).origin)
  assert.equal(recipeSummary.localPreviewOrigin.startsWith("http://127.0.0.1:"), true)
  assert.equal(recipeSummary.requestedPreviewOrigin, recipePublicUrl)
  assert.equal(recipeSummary.effectivePreviewOrigin, recipePublicUrl)
  assert.equal(recipeOutput.artifacts.preview.url, recipePublicUrl)
  assert.equal(recipeOutput.artifacts.preview.localUrl.startsWith("http://127.0.0.1:"), true)

  const recipeReview = await review(recipeOutput)
  assert.equal(recipeReview.browser?.probes?.[0]?.requestedUrl, `${recipePublicUrl}relative-probe`)
  assert.equal(recipeReview.browser?.probes?.[0]?.preview?.requestedMode, "public")
  assert.equal(recipeReview.browser?.probes?.[0]?.preview?.effectiveMode, "public")
  assert.equal(recipeReview.browser?.probes?.[0]?.localPreviewOrigin?.startsWith("http://127.0.0.1:"), true)
  assert.equal(recipeReview.browser?.probes?.[0]?.requestedPreviewOrigin, recipePublicUrl)
  assert.equal(recipeReview.browser?.probes?.[0]?.effectivePreviewOrigin, recipePublicUrl)

  const localDefaultPort = await reserveFreePort()
  const localDefaultPublicUrl = `http://127.0.0.1:${localDefaultPort}/public-route/`
  const localDefaultRecipePath = await writeRecipe("recipe-preview-local-default.json", localDefaultPort, localDefaultPublicUrl, ["preview-mode=local"])
  const localDefaultOutput = await runCliJson(["recipe-run", "--recipe", localDefaultRecipePath, "--json"])

  assert.equal(localDefaultOutput.success, true, localDefaultOutput.error?.message ?? "recipe-run with default local preview failed")
  const localDefaultSummary = await browserSummary(localDefaultOutput)
  assert.equal(localDefaultSummary.preview.requestedMode, "local")
  assert.equal(localDefaultSummary.preview.effectiveMode, "local")
  assert.equal(localDefaultSummary.preview.publicOrigin, localDefaultPublicUrl)
  assert.equal(localDefaultSummary.effectivePreviewOrigin.startsWith("http://127.0.0.1:"), true)
  assert.notEqual(localDefaultSummary.effectivePreviewOrigin, localDefaultPublicUrl)

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
  assert.equal(overrideSummary.preview.requestedMode, "public")
  assert.equal(overrideSummary.preview.effectiveMode, "public")
  assert.equal(overrideSummary.requestedPreviewOrigin, overridePublicUrl)
  assert.equal(overrideSummary.effectivePreviewOrigin, overridePublicUrl)
  assert.equal(overrideOutput.artifacts.preview.url, overridePublicUrl)

  const overrideMetadata = JSON.parse(await readFile(overrideOutput.artifacts.metadataPath, "utf8")) as { provenance?: { task?: { preview?: { requested?: { publicUrl?: string }; effective?: { publicUrl?: string }; cliOverrides?: { publicUrl?: string } } } } }
  assert.equal(overrideMetadata.provenance?.task?.preview?.requested?.publicUrl, staleRecipePublicUrl)
  assert.equal(overrideMetadata.provenance?.task?.preview?.effective?.publicUrl, overridePublicUrl)
  assert.equal(overrideMetadata.provenance?.task?.preview?.cliOverrides?.publicUrl, overridePublicUrl)

  const missingSecurePort = await reserveFreePort()
  const missingSecureRecipePath = await writeRecipe("recipe-preview-secure-missing.json", missingSecurePort, undefined, ["preview-mode=secure"])
  const missingSecureOutput = await runCliJson(["recipe-run", "--recipe", missingSecureRecipePath, "--json"])
  const missingSecureSummary = await browserSummary(missingSecureOutput)

  assert.equal(missingSecureOutput.success, false, "secure preview without a public URL should fail")
  assert.match(missingSecureOutput.error?.message ?? "", /preview-mode=secure requires runtime\.preview\.publicUrl/)
  assert.equal(missingSecureSummary.preview.requestedMode, "secure")
  assert.equal(missingSecureSummary.preview.effectiveMode, "local")
  assert.equal(missingSecureSummary.preview.diagnostics[0]?.code, "preview-public-origin-missing")

  const insecureSecurePort = await reserveFreePort()
  const insecureSecurePublicUrl = `http://127.0.0.1:${insecureSecurePort}/secure-route/`
  const insecureSecureRecipePath = await writeRecipe("recipe-preview-secure-insecure.json", insecureSecurePort, insecureSecurePublicUrl, ["preview-mode=secure"])
  const insecureSecureOutput = await runCliJson(["recipe-run", "--recipe", insecureSecureRecipePath, "--json"])
  const insecureSecureSummary = await browserSummary(insecureSecureOutput)

  assert.equal(insecureSecureOutput.success, false, "secure preview with an HTTP public URL should fail")
  assert.match(insecureSecureOutput.error?.message ?? "", /preview-mode=secure requires an HTTPS public preview origin/)
  assert.equal(insecureSecureSummary.preview.requestedMode, "secure")
  assert.equal(insecureSecureSummary.preview.effectiveMode, "secure")
  assert.equal(insecureSecureSummary.preview.publicOrigin, insecureSecurePublicUrl)
  assert.equal(insecureSecureSummary.preview.diagnostics[0]?.code, "preview-public-origin-not-https")

  console.log("Recipe preview routing browser probe smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeRecipe(name: string, port: number, publicUrl: string | undefined, browserProbeArgs: string[] = ["preview-mode=public"]): Promise<string> {
  const recipePath = join(workspace, name)
  const artifactsDirectory = join(workspace, `${name}-artifacts`)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      preview: {
        port,
        ...(publicUrl ? { publicUrl } : {}),
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
            ...browserProbeArgs,
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

async function browserSummary(output: { artifacts?: { directory?: string } }): Promise<{ requestedUrl: string; windowLocationOrigin?: string; preview: { requestedMode: string; effectiveMode: string; localOrigin: string; publicOrigin?: string; effectiveOrigin: string; secureContext?: boolean; diagnostics: Array<{ code: string }> }; localPreviewOrigin: string; requestedPreviewOrigin?: string; effectivePreviewOrigin: string }> {
  assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")
  return JSON.parse(await readFile(join(output.artifacts.directory, "files", "browser", "summary.json"), "utf8"))
}

async function review(output: { artifacts?: { directory?: string } }): Promise<{ browser?: { probes?: Array<{ requestedUrl?: string; preview?: { requestedMode?: string; effectiveMode?: string }; localPreviewOrigin?: string; requestedPreviewOrigin?: string; effectivePreviewOrigin?: string }> } }> {
  assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")
  return JSON.parse(await readFile(join(output.artifacts.directory, "files", "review.json"), "utf8"))
}

async function runCliJson(args: string[]): Promise<any> {
  const stdout = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", ...args], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  }).then((result) => result.stdout).catch((error: { stdout?: string }) => error.stdout ?? "")
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
