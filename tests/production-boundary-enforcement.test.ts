import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const root = new URL("..", import.meta.url)
const packagesDir = new URL("../packages/", import.meta.url)
const productionExtensions = new Set([".cjs", ".js", ".json", ".jsx", ".mjs", ".php", ".ts", ".tsx"])
const publicDocPaths = [
  "README.md",
  "docs/README.md",
  "docs/portable-wp-codebox.md",
  "packages/cli/README.md",
  "packages/wordpress-plugin/README.md",
  "examples/simple-plugin/README.md",
  "examples/agent-runtime/README.md",
  "examples/recipes/cookbook/README.md",
]
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
const forbiddenPublicSurfaceTerms = [
  ...forbiddenTerms,
  /agents api/i,
  /data machine code/i,
]
const forbiddenPublicExportTargets = [
  /preview-server\.js$/,
  /playground-cli-runner\.js$/,
]
const forbiddenPublicImportSpecifiers = [
  /@wp-playground\//,
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

for (const rel of publicDocPaths) {
  const source = await readFile(new URL(`../${rel}`, import.meta.url), "utf8")
  for (const term of forbiddenPublicSurfaceTerms) {
    if (term.test(source)) {
      violations.push(`${rel} exposes ${term} in public documentation`)
    }
  }
}

for (const manifest of await packageManifests(packagesDir)) {
  const source = JSON.parse(await readFile(manifest, "utf8")) as { name?: string; exports?: unknown; dependencies?: Record<string, string> }
  const rel = relative(root.pathname, manifest)

  for (const target of exportTargets(source.exports)) {
    for (const forbidden of forbiddenPublicExportTargets) {
      if (forbidden.test(target)) {
        violations.push(`${rel} exports internal runtime target ${target}`)
      }
    }
  }

  for (const dependency of Object.keys(source.dependencies ?? {})) {
    if (source.name !== "@automattic/wp-codebox-playground" && forbiddenPublicImportSpecifiers.some((forbidden) => forbidden.test(dependency))) {
      violations.push(`${rel} depends on backend-internal package ${dependency}`)
    }
  }
}

for (const rel of ["packages/runtime-core/src/index.ts", "packages/runtime-playground/src/index.ts", "packages/cli/src/index.ts"]) {
  const source = await readFile(new URL(`../${rel}`, import.meta.url), "utf8")
  for (const target of exportedModuleSpecifiers(source)) {
    for (const forbidden of forbiddenPublicExportTargets) {
      if (forbidden.test(target)) {
        violations.push(`${rel} re-exports backend-internal module ${target}`)
      }
    }
  }
}

assert.deepEqual(
  violations,
  [],
  "Production package sources must not name downstream products or orchestration policy; use generic runtime/task/artifact/probe vocabulary and pass caller assumptions through provider inputs.",
)

console.log("production boundary enforcement passed")

async function packageManifests(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const manifests: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    manifests.push(new URL(`${entry.name}/package.json`, dir).pathname)
  }

  return manifests
}

function exportTargets(exportsField: unknown): string[] {
  if (typeof exportsField === "string") return [exportsField]
  if (!exportsField || typeof exportsField !== "object") return []

  return Object.values(exportsField as Record<string, unknown>).flatMap(exportTargets)
}

function exportedModuleSpecifiers(source: string): string[] {
  return [...source.matchAll(/export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "")
}
