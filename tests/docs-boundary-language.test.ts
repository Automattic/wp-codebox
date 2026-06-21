import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const forbiddenConsumerTerms = [
  /\bStudio Web\b/,
  /\bStudio Native\b/,
  /\bHomeboy\b/,
  /\bStatic Site Importer\b/,
]

const genericContractDocs = [
  "docs/architecture.md",
  "docs/recipe-contract.md",
  "docs/sandbox-session-contract.md",
  "docs/tool-bridge-contract.md",
  "docs/external-apply-adapter-contract.md",
  "docs/agent-fanout-contract.md",
  "docs/agent-runtime-contract.md",
  "docs/public-api-contract.md",
  "docs/generic-runtime-primitives.md",
  "docs/portable-wp-codebox.md",
  "docs/benchmark-contract.md",
]

const root = new URL("..", import.meta.url)
const violations: string[] = []

for (const doc of genericContractDocs) {
  const source = await readFile(new URL(doc, root), "utf8")

  for (const term of forbiddenConsumerTerms) {
    if (term.test(source)) {
      violations.push(`${doc} contains ${term}`)
    }
  }
}

assert.deepEqual(
  violations,
  [],
  "Generic boundary docs must not name example consumers as runtime concepts; keep named products in explicit example-consumer notes.",
)

const exampleConsumerDoc = await readFile(new URL("docs/example-consumer-boundary-contracts.md", root), "utf8")

assert.match(exampleConsumerDoc, /^# Example Consumer Boundary Contracts/m)
assert.match(exampleConsumerDoc, /## Public\/Internal Boundary/)
assert.match(exampleConsumerDoc, /Consumers compose WP Codebox APIs\./)
assert.match(exampleConsumerDoc, /Data Machine job, artifact, pending-action, and flow concepts stay behind\s+Codebox run, artifact, approval, and session contracts\./)
assert.match(exampleConsumerDoc, /Agents API execution targets and principals stay behind Codebox task, provider,\s+permission, and runtime-session contracts\./)
assert.match(exampleConsumerDoc, /Data Machine Code workspace lifecycle and GitHub workflow details stay behind\s+Codebox source, workspace, evidence, and apply-back contracts\./)
assert.match(exampleConsumerDoc, /WordPress Playground boot, filesystem, preview, and PHP\/WP-CLI details stay\s+behind Codebox runtime, mount, command, preview, and browser-session contracts\./)
assert.match(exampleConsumerDoc, /Public schema names, top-level DTO fields, package entrypoints, and docs intended\s+for consumers use Codebox vocabulary\./)
assert.match(exampleConsumerDoc, /Named products may appear in integration notes as\s+example consumers/)
assert.match(exampleConsumerDoc, /## Example Consumers/)

const agentRuntimeContract = await readFile(new URL("docs/agent-runtime-contract.md", root), "utf8")
assert.match(agentRuntimeContract, /`generic-ability-runtime-run` is the canonical primitive/)
assert.doesNotMatch(agentRuntimeContract, /Until the upstream agent\/provider stack exposes one stable browser-runtime primitive/)

console.log("docs boundary language ok")
