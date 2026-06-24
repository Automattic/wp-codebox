import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { relative } from "node:path"
import { runtimeContractManifest } from "../packages/runtime-core/src/public.js"

const root = new URL("..", import.meta.url)
const publicConsumerRoots = ["README.md", "docs", "examples", "packages/wordpress-plugin/README.md", "packages/cli/README.md"]
const internalReferenceDocs = new Set([
  "docs/browser-runtime-dependency-audit.md",
  "docs/portable-wp-codebox.md",
  "docs/transfer-namespace-plan.md",
  "docs/transfer-readiness-checklist.md",
])

const publicDocsText = await readPublicText(publicConsumerRoots)
const manifest = runtimeContractManifest()
const publicAbilityIds = flattenStringValues(manifest.abilities)

for (const abilityId of publicAbilityIds) {
  assert.match(
    publicDocsText,
    new RegExp(escapeRegExp(abilityId)),
    `public docs should document Codebox public ability ${abilityId}`,
  )
}

for (const rawPublicPath of [
  /agents\/[a-z0-9._/-]+/i,
  /wp-codebox\.agent-sandbox-run/,
  /from ["']@automattic\/wp-codebox-playground/,
  /@wp-playground\//,
]) {
  assert.doesNotMatch(publicDocsText, rawPublicPath, `public docs must not teach ${rawPublicPath}`)
}

for (const substrateTerm of [/\bData Machine\b/i, /\bData Machine Code\b/i, /\bAgents API\b/i, /\bdatamachine\b/i]) {
  assert.doesNotMatch(publicDocsText, substrateTerm, `public docs must stay on Codebox-owned API language`)
}

const publicExamplesText = await readPublicText(["examples"])
assert.doesNotMatch(publicExamplesText, /wp-codebox\.agent-sandbox-run|agents\/[a-z0-9._/-]+/i)

const legacyFixturesText = await readPublicText(["tests/fixtures/legacy-compatibility-recipes"])
assert.match(legacyFixturesText, /wp-codebox\.agent-sandbox-run/)

const publicApiContract = await readFile(new URL("docs/public-api-contract.md", root), "utf8")
assert.match(publicApiContract, /External integrations should compose the Codebox core facades,\s+WordPress abilities, CLI, or browser SDK/)
assert.match(publicApiContract, /Product consumers should use the Codebox-owned public surfaces/)
assert.match(publicApiContract, /manifest intentionally excludes backend handler bindings/)
assert.match(publicApiContract, /`wp-codebox\/run-plan-progress\/v1`/)
assert.match(publicApiContract, /Hosts may stream or persist those snapshots in\s+their own job system/)
assert.match(publicApiContract, /host UIs own the button, policy, and durable cancellation request transport/)

const cookbookReadme = await readFile(new URL("examples/recipes/cookbook/README.md", root), "utf8")
assert.match(cookbookReadme, /Provider-specific agent compatibility fixtures are kept under\s+`tests\/fixtures\/legacy-compatibility-recipes`/)
assert.doesNotMatch(cookbookReadme, /codex-agent-smoke\.json|claude-code-agent-smoke\.json|headless-browser-agent-task\.json/)

console.log("docs boundary language ok")

async function readPublicText(paths: string[]): Promise<string> {
  const files = (await Promise.all(paths.map(collectTextFiles))).flat()
  const chunks: string[] = []

  for (const file of files) {
    if (internalReferenceDocs.has(file)) continue
    chunks.push(await readFile(new URL(file, root), "utf8"))
  }

  return chunks.join("\n")
}

async function collectTextFiles(path: string): Promise<string[]> {
  if (/\.(md|json|ts|js|ya?ml)$/.test(path)) {
    return [path]
  }

  if (/\.[^.]+$/.test(path)) {
    return []
  }

  const entries = await readdir(new URL(`${path}/`, root), { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const child = `${path}/${entry.name}`
    return entry.isDirectory() ? collectTextFiles(child) : collectTextFiles(child)
  }))

  return files.flat().map((file) => relative(root.pathname, new URL(file, root).pathname))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function flattenStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(flattenStringValues)
}
