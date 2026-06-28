import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const root = new URL("..", import.meta.url)
const packagesDir = new URL("../packages/", import.meta.url)
const runtimeCoreDir = new URL("../packages/runtime-core/", import.meta.url)
const runtimeCoreSrcDir = new URL("../packages/runtime-core/src/", import.meta.url)
const publicDocPaths = [
  "README.md",
  "docs/README.md",
  "docs/portable-wp-codebox.md",
  "docs/runner-workspace-backend-contract.md",
  "packages/cli/README.md",
  "packages/wordpress-plugin/README.md",
  "examples/simple-plugin/README.md",
  "examples/agent-runtime/README.md",
  "examples/recipes/cookbook/README.md",
]
const forbiddenPublicSurfaceTerms = [
  /homeboy/i,
  /\bwpsg\b/i,
  /wp-site-generator/i,
  /wp site generator/i,
]
const forbiddenPublicConsumerGuidance = [
  /studio\s+wp\s+datamachine/i,
  /wp\s+datamachine/i,
  /agents-api\/[a-z0-9._/-]+/i,
  /datamachine\/[a-z0-9._/-]+/i,
  /data-machine-code\/[a-z0-9._/-]+/i,
  /call\s+(?:the\s+)?(?:Data Machine|Agents API|Data Machine Code)\b/i,
  /use\s+(?:the\s+)?(?:Data Machine|Agents API|Data Machine Code)\s+(?:ability|api|endpoint)\b/i,
]
const forbiddenPublicExportTargets = [
  /preview-server\.js$/,
  /playground-cli-runner\.js$/,
]
const forbiddenPublicImportSpecifiers = [
  /@wp-playground\//,
]
const forbiddenRuntimeCoreBackendSpecifiers = [
  /@automattic\/wp-codebox-playground(?:\/|$)/,
  /@wp-playground\//,
  /\bplaywright\b/,
  /\.\.\/runtime-playground(?:\/|$)/,
  /packages\/runtime-playground(?:\/|$)/,
]
const publicContractFiles = [
  "packages/runtime-core/src/runtime-boundary-contracts.ts",
  "packages/runtime-core/src/generic-ability-runtime-run.ts",
  "packages/runtime-core/src/provider-runtime-contracts.ts",
]
const forbiddenPublicContractVocabulary = [
  /data[-_ ]?machine/i,
  /datamachine/i,
  /agents[-_ ]?api/i,
  /wordpress[-_ ]?playground/i,
  /homeboy/i,
]

const violations: string[] = []

for (const rel of publicDocPaths) {
  const source = await readFile(new URL(`../${rel}`, import.meta.url), "utf8")
  for (const term of forbiddenPublicSurfaceTerms) {
    if (term.test(source)) {
      violations.push(`${rel} exposes ${term} in public documentation`)
    }
  }
  for (const guidance of forbiddenPublicConsumerGuidance) {
    if (guidance.test(source)) {
      violations.push(`${rel} tells public consumers to call internal substrate ${guidance}`)
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

const runtimeCorePackage = JSON.parse(await readFile(new URL("package.json", runtimeCoreDir), "utf8")) as { dependencies?: Record<string, string> }
for (const dependency of Object.keys(runtimeCorePackage.dependencies ?? {})) {
  if (forbiddenRuntimeCoreBackendSpecifiers.some((forbidden) => forbidden.test(dependency))) {
    violations.push(`packages/runtime-core/package.json depends on runtime backend package ${dependency}`)
  }
}

for (const file of await sourceFiles(runtimeCoreSrcDir)) {
  const source = await readFile(file, "utf8")
  const rel = relative(root.pathname, file)
  for (const specifier of importedModuleSpecifiers(source)) {
    if (forbiddenRuntimeCoreBackendSpecifiers.some((forbidden) => forbidden.test(specifier))) {
      violations.push(`${rel} imports runtime backend module ${specifier}`)
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

for (const rel of publicContractFiles) {
  const source = await readFile(new URL(`../${rel}`, import.meta.url), "utf8")
  for (const publicName of exportedContractNames(source)) {
    for (const forbidden of forbiddenPublicContractVocabulary) {
      if (forbidden.test(publicName)) {
        violations.push(`${rel} exports public contract name ${publicName} with raw upstream vocabulary ${forbidden}`)
      }
    }
  }
}

assert.deepEqual(
  violations,
  [],
  "Public package exports, dependencies, docs, and contract names must stay on Codebox-owned consumer API vocabulary.",
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

async function sourceFiles(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(child))
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(child.pathname)
    }
  }

  return files
}

function exportTargets(exportsField: unknown): string[] {
  if (typeof exportsField === "string") return [exportsField]
  if (!exportsField || typeof exportsField !== "object") return []

  return Object.values(exportsField as Record<string, unknown>).flatMap(exportTargets)
}

function exportedModuleSpecifiers(source: string): string[] {
  return [...source.matchAll(/export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "")
}

function importedModuleSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/import\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/import\(["']([^"']+)["']\)/g),
    ...source.matchAll(/export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+["']([^"']+)["']/g),
  ].map((match) => match[1] ?? "")
}

function exportedContractNames(source: string): string[] {
  return [
    ...source.matchAll(/export\s+(?:const|type|interface|class|function)\s+([A-Za-z0-9_]+)/g),
    ...source.matchAll(/export\s+\{([^}]+)\}/g),
    ...source.matchAll(/"(wp-codebox\/[^"]+)"/g),
  ].flatMap((match) => {
    const value = match[1] ?? ""
    if (value.includes(",")) {
      return value.split(",").map((part) => part.trim().split(/\s+as\s+/i).pop() ?? "").filter(Boolean)
    }
    return value ? [value] : []
  })
}
