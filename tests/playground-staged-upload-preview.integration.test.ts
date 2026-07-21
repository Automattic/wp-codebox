import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { PNG } from "pngjs"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-staged-upload-preview-"))
const imageSource = join(root, "staged.png")
const htmlSource = join(root, "index.html")
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")
const uploadPath = "/wp-content/uploads/wp-codebox-staged-image/index.html"

try {
  const png = new PNG({ width: 2, height: 2 })
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([17, 34, 51, 255], offset)
  }
  await writeFile(imageSource, PNG.sync.write(png))
  await writeFile(htmlSource, '<!doctype html><meta charset="utf-8"><img id="staged-image" src="staged.png" width="2" height="2" alt="staged image">\n')
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "6.5", blueprint: { steps: [] } },
    inputs: {
      stagedFiles: [
        { source: imageSource, target: "/wordpress/wp-content/uploads/wp-codebox-staged-image/staged.png" },
        { source: htmlSource, target: "/wordpress/wp-content/uploads/wp-codebox-staged-image/index.html" },
      ],
    },
    workflow: {
      steps: [{
        command: "wordpress.browser-probe",
        args: [
          `url=${uploadPath}`,
          "wait-for=load",
          "capture=html,screenshot",
          `script=${browserPaintScript()}`,
        ],
      }],
    },
  })}\n`)

  const output = await runRecipe()
  if (output) {
    assert.equal(output.success, true, JSON.stringify(output))
    const execution = output.executions?.find((entry) => entry.command === "wordpress.browser-probe")
    assert.ok(execution?.stdout, "browser probe output should be retained")
    const probe = JSON.parse(execution.stdout) as BrowserProbeOutput
    assert.match(probe.finalUrl ?? "", /\/wp-content\/uploads\/wp-codebox-staged-image\/index\.html$/)
    assert.deepEqual(probe.summary?.scriptResult, {
      complete: true,
      naturalWidth: 2,
      naturalHeight: 2,
      width: 2,
      height: 2,
      pixel: [17, 34, 51, 255],
    })
    assert.ok(probe.files?.html, "browser probe should capture rendered HTML")
    assert.ok(probe.files?.screenshot, "browser probe should capture painted pixels")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

function browserPaintScript(): string {
  return `
const image = document.querySelector("#staged-image");
if (!(image instanceof HTMLImageElement)) throw new Error("staged image element missing");
await image.decode();
const rect = image.getBoundingClientRect();
const canvas = document.createElement("canvas");
canvas.width = 1;
canvas.height = 1;
const context = canvas.getContext("2d");
if (!context) throw new Error("2d canvas unavailable");
context.drawImage(image, 0, 0);
return {
  complete: image.complete,
  naturalWidth: image.naturalWidth,
  naturalHeight: image.naturalHeight,
  width: rect.width,
  height: rect.height,
  pixel: [...context.getImageData(0, 0, 1, 1).data],
};`
}

async function runRecipe(): Promise<RecipeRunOutput | undefined> {
  try {
    const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
      cwd: process.cwd(),
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return JSON.parse(result.stdout) as RecipeRunOutput
  } catch (error) {
    if (isUnavailableWordPressRuntimeSource(error)) {
      console.log("playground staged upload preview integration skipped: WordPress runtime source was unavailable before runtime startup")
      return undefined
    }
    throw error
  }
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
  if (typeof value !== "string") return undefined
  try {
    return JSON.parse(value) as RecipeRunOutput
  } catch {
    return undefined
  }
}

interface RecipeRunOutput {
  schema?: string
  success?: boolean
  executions?: Array<{ command?: string; stdout?: string }>
  phaseEvidence?: Array<{ name?: string; status?: string; error?: { message?: string } }>
}

interface BrowserProbeOutput {
  finalUrl?: string
  files?: { html?: string; screenshot?: string }
  summary?: { scriptResult?: unknown }
}
