import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const root = new URL("..", import.meta.url)
const packagesDir = new URL("../packages/", import.meta.url)
const productionExtensions = new Set([".cjs", ".js", ".json", ".jsx", ".mjs", ".php", ".ts", ".tsx"])
const forbiddenTerms = [
  /datamachine/i,
  /data machine/i,
  /data-machine/i,
  /data-machine-code/i,
  /homeboy/i,
  /\bwpsg\b/i,
  /wp-site-generator/i,
  /wp site generator/i,
]

async function productionFiles(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue

    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
    if (entry.isDirectory()) {
      files.push(...await productionFiles(path))
      continue
    }

    const ext = entry.name.match(/\.[^.]+$/)?.[0]
    if (ext && productionExtensions.has(ext)) {
      files.push(path.pathname)
    }
  }

  return files
}

const violations: string[] = []

for (const file of await productionFiles(packagesDir)) {
  const source = await readFile(file, "utf8")
  const rel = relative(root.pathname, file)

  for (const term of forbiddenTerms) {
    if (term.test(source)) {
      violations.push(`${rel} contains ${term}`)
    }
  }
}

assert.deepEqual(
  violations,
  [],
  "Production package sources must not name downstream products or orchestration policy; use generic runtime/task/artifact/probe vocabulary and pass caller assumptions through provider inputs.",
)

console.log("production boundary enforcement passed")
