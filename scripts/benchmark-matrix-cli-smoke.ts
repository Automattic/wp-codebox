import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/benchmark-matrix-cli-smoke")
const recipePath = resolve(workspace, "recipe.json")
const matrixPath = resolve(workspace, "matrix.json")

rmSync(workspace, { recursive: true, force: true })
mkdirSync(workspace, { recursive: true })

writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: { steps: [{ command: "wordpress.bench", args: [] }] },
}, null, 2)}\n`)

writeFileSync(matrixPath, `${JSON.stringify({
  schema: "wp-codebox/benchmark-recipe-matrix/v1",
  recipe: "./recipe.json",
  dimensions: [
    { id: "wp", values: [{ id: "7.0", value: { recipe: { runtime: { wp: "7.0" } } } }] },
    { id: "cache", values: [] },
  ],
}, null, 2)}\n`)

const result = spawnSync(process.execPath, [cli, "bench", "matrix", "--matrix", matrixPath, "--json"], { cwd: root, encoding: "utf8" })
assert.equal(result.status, 1, result.stderr || result.stdout)

const output = JSON.parse(result.stdout)
assert.equal(output.schema, "wp-codebox/benchmark-matrix-run/v1")
assert.equal(output.matrix.schema, "wp-codebox/benchmark-matrix/v1")
assert.equal(output.matrix.cells.length, 0)
assert.equal(output.diagnostics.length, 1)
assert.equal(output.diagnostics[0].cellId, "matrix-expansion")
assert.equal(output.diagnostics[0].code, "empty-dimension")

console.log("benchmark matrix cli smoke passed")
