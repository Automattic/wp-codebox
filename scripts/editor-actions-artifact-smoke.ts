import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "editor-actions-artifact-smoke")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      {
        command: "wordpress.editor-actions",
        args: [
          "target=post-new",
          "post-type=post",
          "wait-timeout=30s",
          "step-timeout=30s",
          `steps-json=${JSON.stringify([
            { kind: "insertBlock", name: "core/paragraph", content: "WP Codebox editor action smoke" },
            { kind: "inspectState" },
          ])}`,
          "capture=steps,console,errors,html,screenshot,editor-state",
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

const artifactDirectory = output.artifacts.directory
const stepsPath = join(artifactDirectory, "files", "browser", "editor-action-steps.jsonl")
const consolePath = join(artifactDirectory, "files", "browser", "editor-action-console.jsonl")
const errorsPath = join(artifactDirectory, "files", "browser", "editor-action-errors.jsonl")
const htmlPath = join(artifactDirectory, "files", "browser", "editor-action-snapshot.html")
const screenshotPath = join(artifactDirectory, "files", "browser", "editor-action-screenshot.png")
const editorStatePath = join(artifactDirectory, "files", "browser", "editor-action-state.json")
const summaryPath = join(artifactDirectory, "files", "browser", "editor-action-summary.json")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(stepsPath), true, "editor action step trace should be captured")
assert.equal(existsSync(consolePath), true, "editor action console trace should be captured")
assert.equal(existsSync(errorsPath), true, "editor action error trace should be captured")
assert.equal(existsSync(htmlPath), true, "editor action DOM snapshot should be captured")
assert.equal(existsSync(screenshotPath), true, "editor action screenshot should be captured")
assert.equal(existsSync(editorStatePath), true, "editor action state should be captured")
assert.equal(existsSync(summaryPath), true, "editor action summary should be captured")

const stepsLog = await readFile(stepsPath, "utf8")
assert.match(stepsLog, /"kind":"navigate"/)
assert.match(stepsLog, /"kind":"waitFor"/)
assert.match(stepsLog, /"kind":"insertBlock"/)
assert.match(stepsLog, /"kind":"inspectState"/)
assert.match(stepsLog, /"status":"ok"/)

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  schema: string
  target: { kind: string; postType?: string }
  actions: Array<{ kind: string }>
  files: { steps?: string; editorState?: string; html?: string; screenshot?: string; summary: string }
  summary: { actions?: number; steps?: number; replayability: string; htmlSnapshot: boolean; editor?: { postType?: string; blockCount?: number; storesAvailable: boolean } }
}
assert.equal(summary.schema, "wp-codebox/editor-actions/v1")
assert.equal(summary.target.kind, "post-new")
assert.equal(summary.target.postType, "post")
assert.equal(summary.actions.length, 2)
assert.equal(summary.files.steps, "files/browser/editor-action-steps.jsonl")
assert.equal(summary.files.editorState, "files/browser/editor-action-state.json")
assert.equal(summary.files.html, "files/browser/editor-action-snapshot.html")
assert.equal(summary.files.screenshot, "files/browser/editor-action-screenshot.png")
assert.equal(summary.files.summary, "files/browser/editor-action-summary.json")
assert.equal(summary.summary.actions, 2)
assert.equal(summary.summary.steps, 4)
assert.equal(summary.summary.replayability, "artifact-backed")
assert.equal(summary.summary.htmlSnapshot, true)
assert.equal(summary.summary.editor?.postType, "post")
assert.equal(summary.summary.editor?.storesAvailable, true)
assert.ok((summary.summary.editor?.blockCount ?? 0) >= 1, "summary should include inserted block count")

const editorState = JSON.parse(await readFile(editorStatePath, "utf8")) as {
  schema: string
  storesAvailable: boolean
  post?: { type?: string }
  blocks?: Array<{ name: string; attributes?: { content?: string } }>
}
assert.equal(editorState.schema, "wp-codebox/editor-state/v1")
assert.equal(editorState.storesAvailable, true)
assert.equal(editorState.post?.type, "post")
assert.ok(editorState.blocks?.some((block) => block.name === "core/paragraph" && block.attributes?.content === "WP Codebox editor action smoke"), "inserted paragraph should appear in editor state")

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/editor-action-state.json" && file.kind === "browser-editor-state"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/editor-action-summary.json" && file.kind === "browser-summary"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ editorState?: string; steps?: string; stepCount?: number; actionCount?: number; html?: string; screenshot?: string; summaryFile?: string }> } }
assert.equal(review.browser?.probes?.[0]?.editorState, "files/browser/editor-action-state.json")
assert.equal(review.browser?.probes?.[0]?.steps, "files/browser/editor-action-steps.jsonl")
assert.equal(review.browser?.probes?.[0]?.stepCount, 4)
assert.equal(review.browser?.probes?.[0]?.actionCount, 4)
assert.equal(review.browser?.probes?.[0]?.html, "files/browser/editor-action-snapshot.html")
assert.equal(review.browser?.probes?.[0]?.screenshot, "files/browser/editor-action-screenshot.png")
assert.equal(review.browser?.probes?.[0]?.summaryFile, "files/browser/editor-action-summary.json")

console.log(`Editor actions artifact smoke passed: ${artifactDirectory}`)

async function runCli(args: string[]): Promise<any> {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)))
  assert.equal(exitCode, 0, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  return JSON.parse(stdout)
}
