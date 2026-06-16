import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const recipe = JSON.parse(readFileSync("examples/recipes/cookbook/codex-agent-smoke.json", "utf8"))
const readme = readFileSync("examples/recipes/cookbook/README.md", "utf8")

const overlay = recipe.runtime?.overlays?.find((entry: Record<string, unknown>) => entry.library === "php-ai-client")
assert.ok(overlay, "Codex example should include a php-ai-client overlay")
assert.match(String(overlay.source), /absolute\/path\/to\/php-ai-client-with-bearer-token-auth-and-vendor/)
assert.match(String(overlay.metadata?.purpose), /bearer-token/)
assert.match(String(overlay.metadata?.purpose), /Composer vendor/)

const providerPlugin = recipe.inputs?.extra_plugins?.find((entry: Record<string, unknown>) => entry.slug === "ai-provider-for-openai")
assert.ok(providerPlugin, "Codex example should include the OpenAI provider plugin")
assert.equal(providerPlugin.activate, false, "Codex provider plugin activation should be handled by the sandbox agent task")
assert.match(String(providerPlugin.source), /registers-codex/)

const args = recipe.workflow?.steps?.[0]?.args ?? []
assert.ok(args.includes("provider=codex"), "Codex recipe should select the codex provider id")
assert.ok(args.includes("provider-plugin-slugs=ai-provider-for-openai"), "Codex recipe should pass the provider plugin slug")

for (const requiredPattern of [
  /materialized local\s+filesystem paths/,
  /must register the `codex` provider id/,
  /bearer-token request authentication/,
  /vendor\/composer\/installed\.json/,
  /WP Codebox stays generic and\s+local-path based/,
]) {
  assert.match(readme, requiredPattern, `Codex README should document: ${requiredPattern}`)
}

console.log("Codex agent recipe smoke passed")
