import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { chromium, type ConsoleMessage, type Page, type Request, type Response } from "playwright"

type CommandRecord = {
  command?: string
  exitCode?: number
  stdout?: string
}

type SeedOutput = {
  reply_page_anchor?: string
  reply_form_anchor?: string
  reply_page_url?: string
  topic_permalink?: string
  bbpress_active?: boolean
  plugin_under_test?: boolean
  plugin_file?: string | false
}

const repoRoot = resolve(import.meta.dirname, "..")
const recipePath = process.env.WP_CODEBOX_BROWSER_SMOKE_RECIPE ?? "./examples/recipes/cookbook/bbpress-reply-editor.json"
const holdSeconds = Number.parseInt(process.env.WP_CODEBOX_BROWSER_SMOKE_HOLD ?? "30", 10)
const artifactsRoot = resolve(repoRoot, "artifacts", "recipe-browser-smoke")

assert.ok(Number.isInteger(holdSeconds) && holdSeconds > 0, "WP_CODEBOX_BROWSER_SMOKE_HOLD must be a positive integer")

await mkdir(artifactsRoot, { recursive: true })

const startedAt = new Date().toISOString()
const runArtifactsRoot = join(artifactsRoot, `run-${startedAt.replace(/[:.]/g, "-")}`)
await mkdir(runArtifactsRoot, { recursive: true })
const artifactPath = join(artifactsRoot, `browser-smoke-${startedAt.replace(/[:.]/g, "-")}.json`)
const recipe = spawn(process.execPath, [
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  runArtifactsRoot,
  "--preview-hold",
  `${holdSeconds}s`,
  "--preview-hold-blocking",
  "--json",
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
})

let recipeStdout = ""
let recipeStderr = ""
let recipeExit: { code: number | null; signal: NodeJS.Signals | null } | undefined
recipe.stdout.on("data", (chunk) => {
  recipeStdout += chunk.toString()
})
recipe.stderr.on("data", (chunk) => {
  recipeStderr += chunk.toString()
})
recipe.once("exit", (code, signal) => {
  recipeExit = { code, signal }
})

const result: Record<string, unknown> = {
  schema: "wp-codebox/recipe-browser-smoke/v1",
  recipePath,
  holdSeconds,
  startedAt,
  artifactPath,
  runArtifactsRoot,
  consoleMessages: [],
  pageErrors: [],
  requestFailures: [],
  responses: [],
  editorSurface: { exists: false, selector: null },
}

try {
  const seed = await waitForSeedOutput(recipe, runArtifactsRoot, 90_000)
  const targetUrl = seed.reply_page_anchor ?? seed.reply_form_anchor ?? seed.reply_page_url ?? seed.topic_permalink
  assert.ok(targetUrl, "Seed output did not include a reply preview URL")
  result.seed = seed
  result.targetUrl = targetUrl

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.on("console", (message) => {
      ;(result.consoleMessages as unknown[]).push(serializeConsoleMessage(message))
    })
    page.on("pageerror", (error) => {
      ;(result.pageErrors as unknown[]).push({ name: error.name, message: error.message, stack: error.stack })
    })
    page.on("requestfailed", (request) => {
      ;(result.requestFailures as unknown[]).push(serializeRequestFailure(request))
    })
    page.on("response", (response) => {
      const request = response.request()
      if (request.resourceType() === "document" || response.status() >= 400) {
        ;(result.responses as unknown[]).push(serializeResponse(response))
      }
    })

    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
    assert.ok(response, `No page response received for ${targetUrl}`)
    result.mainResponse = serializeResponse(response)
    assert.ok(response.ok(), `Reply preview returned HTTP ${response.status()} for ${targetUrl}`)

    const editorSurface = await findEditorSurface(page)
    result.editorSurface = editorSurface
    assert.equal(editorSurface.exists, true, `Reply form/editor surface was not found at ${targetUrl}`)
    result.success = true
  } finally {
    await browser.close()
  }

  await waitForRecipeExit(recipe, holdSeconds * 1000 + 15_000)
  assert.equal(recipeExit?.code, 0, `Recipe exited with ${recipeExit?.code ?? "no"} code${recipeStderr ? `: ${recipeStderr}` : ""}`)
} catch (error) {
  result.success = false
  result.error = serializeError(error)
  stopRecipe(recipe)
} finally {
  result.recipeExit = recipeExit
  result.recipeStdoutExcerpt = recipeStdout.slice(-4000)
  result.recipeStderrExcerpt = recipeStderr.slice(-4000)
  result.finishedAt = new Date().toISOString()
  await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`)
}

assert.equal(result.success, true, `Recipe browser smoke failed; see ${artifactPath}`)
console.log(`Recipe browser smoke passed: ${artifactPath}`)

async function waitForSeedOutput(recipeProcess: ChildProcessWithoutNullStreams, directory: string, timeoutMs: number): Promise<SeedOutput> {
  const deadline = Date.now() + timeoutMs
  let lastError: Error | undefined

  while (Date.now() < deadline) {
    if (recipeExit && recipeExit.code !== 0) {
      throw new Error(`Recipe exited before seed output was available: ${recipeStderr || recipeStdout}`)
    }

    try {
      const commandsPath = await findCommandsJsonl(directory)
      if (commandsPath) {
        const seed = await readSeedOutput(commandsPath)
        if (seed) {
          return seed
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    await delay(500)
  }

  stopRecipe(recipeProcess)
  throw new Error(`Timed out waiting for recipe seed output${lastError ? `: ${lastError.message}` : ""}`)
}

async function findCommandsJsonl(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true })
  const runtimeDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("runtime-"))
    .map((entry) => entry.name)
    .sort()
    .reverse()

  for (const runtimeDirectory of runtimeDirectories) {
    const commandsPath = join(directory, runtimeDirectory, "commands.jsonl")
    try {
      await readFile(commandsPath, "utf8")
      return commandsPath
    } catch {
      // The runtime directory appears before artifact collection finishes.
    }
  }

  return undefined
}

async function readSeedOutput(commandsPath: string): Promise<SeedOutput | undefined> {
  const contents = await readFile(commandsPath, "utf8")
  for (const line of contents.split("\n")) {
    if (!line.trim()) {
      continue
    }

    const command = JSON.parse(line) as CommandRecord
    if (command.command !== "wordpress.run-php" || command.exitCode !== 0 || !command.stdout) {
      continue
    }

    const output = JSON.parse(command.stdout) as SeedOutput
    if (output.reply_page_anchor || output.reply_form_anchor || output.reply_page_url) {
      return output
    }
  }

  return undefined
}

async function findEditorSurface(page: Page): Promise<{ exists: boolean; selector: string | null }> {
  const selectors = [
    "form#new-post",
    "#bbp_reply_content",
    "textarea[name='bbp_reply_content']",
    "#bbpress-forums form",
  ]

  for (const selector of selectors) {
    const element = page.locator(selector).first()
    if ((await element.count()) > 0 && await element.isVisible().catch(() => false)) {
      return { exists: true, selector }
    }
  }

  return { exists: false, selector: null }
}

function serializeConsoleMessage(message: ConsoleMessage): Record<string, unknown> {
  return {
    type: message.type(),
    text: message.text(),
    location: message.location(),
  }
}

function serializeRequestFailure(request: Request): Record<string, unknown> {
  return {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    failure: request.failure(),
  }
}

function serializeResponse(response: Response): Record<string, unknown> {
  return {
    url: response.url(),
    status: response.status(),
    statusText: response.statusText(),
    ok: response.ok(),
    contentType: response.headers()["content-type"] ?? null,
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }

  return { name: "NonError", message: String(error) }
}

async function waitForRecipeExit(recipeProcess: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (recipeExit) {
    return
  }

  await Promise.race([
    new Promise<void>((resolveExit) => recipeProcess.once("exit", () => resolveExit())),
    delay(timeoutMs).then(() => {
      stopRecipe(recipeProcess)
      throw new Error("Timed out waiting for recipe process to exit after browser smoke")
    }),
  ])
}

function stopRecipe(recipeProcess: ChildProcessWithoutNullStreams): void {
  if (!recipeExit && !recipeProcess.killed) {
    recipeProcess.kill("SIGTERM")
  }
}
