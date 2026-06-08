import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { PNG } from "pngjs"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-visual-compare-dimension-drift-smoke")
const inputDirectory = join(workspace, "inputs")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")
const sourceScreenshot = join(inputDirectory, "source.png")
const candidateScreenshot = join(inputDirectory, "candidate.png")

await rm(workspace, { recursive: true, force: true })
await mkdir(inputDirectory, { recursive: true })

await writePng(sourceScreenshot, createFixturePng(120, 120, 20))
await writePng(candidateScreenshot, createFixturePng(120, 150, 36))

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      {
        command: "wordpress.visual-compare",
        args: [
          `source-screenshot=${sourceScreenshot}`,
          `candidate-screenshot=${candidateScreenshot}`,
          "source-label=source-fixture",
          "candidate-label=candidate-fixture",
          "threshold=0.1",
          "max-regions=4",
        ],
      },
    ],
  },
  artifacts: {
    directory: artifactsRoot,
  },
}, null, 2)}\n`)

const output = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  recipePath,
  "--json",
])

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

const summaryPath = join(output.artifacts.directory, "files", "browser", "visual-compare", "visual-diff.json")
const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  status: string
  comparison: {
    source: { width: number; height: number }
    candidate: { width: number; height: number }
    dimensionMismatch: boolean
    dimensionDrift?: {
      widthDelta: number
      heightDelta: number
      sourceOnly: unknown[]
      candidateOnly: Array<{ x: number; y: number; width: number; height: number; pixels: number; owner: string }>
    }
    regions: Array<{ x: number; y: number; width: number; height: number; pixels: number }>
  }
}

assert.equal(summary.status, "different")
assert.deepEqual(summary.comparison.source, { width: 120, height: 120 })
assert.deepEqual(summary.comparison.candidate, { width: 120, height: 150 })
assert.equal(summary.comparison.dimensionMismatch, true, "comparison should flag dimension mismatch")
assert.equal(summary.comparison.dimensionDrift?.widthDelta, 0, "dimension drift should report width delta")
assert.equal(summary.comparison.dimensionDrift?.heightDelta, 30, "dimension drift should report height delta")
assert.deepEqual(summary.comparison.dimensionDrift?.sourceOnly, [], "source should not own extra canvas area")
assert.deepEqual(summary.comparison.dimensionDrift?.candidateOnly, [
  { owner: "candidate", x: 0, y: 120, width: 120, height: 30, pixels: 3600 },
])
assert.ok(summary.comparison.regions.length > 0, "comparison should still report local mismatch regions")
assert.ok(summary.comparison.regions.length <= 4, "comparison should honor max-regions")
assert.ok(summary.comparison.regions.every((region) => region.y + region.height <= 120), "local regions should stay inside the shared overlap")
assert.ok(summary.comparison.regions.some((region) => region.y < 80 && region.y + region.height > 36), "local regions should include the shifted element")

console.log("Browser visual compare dimension drift smoke passed")

function createFixturePng(width: number, height: number, boxY: number): PNG {
  const image = new PNG({ width, height })
  fillRect(image, 0, 0, width, height, [255, 255, 255, 255])
  fillRect(image, 24, boxY, 72, 40, [37, 99, 235, 255])
  return image
}

function fillRect(image: PNG, x: number, y: number, width: number, height: number, rgba: [number, number, number, number]): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = ((row * image.width) + column) << 2
      image.data[offset] = rgba[0]
      image.data[offset + 1] = rgba[1]
      image.data[offset + 2] = rgba[2]
      image.data[offset + 3] = rgba[3]
    }
  }
}

async function writePng(path: string, image: PNG): Promise<void> {
  await writeFile(path, PNG.sync.write(image))
}

async function runCli(args: string[]): Promise<{ success?: boolean; artifacts?: { directory?: string }; error?: { message?: string } }> {
  const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const code = await new Promise<number | null>((resolveCode) => child.on("close", resolveCode))
  if (code !== 0) {
    throw new Error(`CLI exited with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  return JSON.parse(stdout)
}
