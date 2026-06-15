import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const claudeRecipe = JSON.parse(readFileSync("examples/recipes/cookbook/claude-code-agent-smoke.json", "utf8"))
const codexRecipe = JSON.parse(readFileSync("examples/recipes/cookbook/codex-agent-smoke.json", "utf8"))
const claudeJson = JSON.stringify(claudeRecipe)

assert.equal(claudeRecipe.schema, "wp-codebox/workspace-recipe/v1")
assert.equal(claudeRecipe.runtime?.backend, "wordpress-playground", "Claude Code example should keep Codebox as the WordPress Playground sandbox substrate")
assert.notEqual(claudeRecipe.runtime?.backend, "claude-code", "Claude Code must not become a Codebox runtime backend")
assert.notEqual(claudeRecipe.runtime?.name, "claude-code", "Claude Code must not be modeled as a named Codebox runtime")

const claudeOverlay = claudeRecipe.runtime?.overlays?.find((overlay: Record<string, unknown>) => overlay.library === "php-ai-client")
const codexOverlay = codexRecipe.runtime?.overlays?.find((overlay: Record<string, unknown>) => overlay.library === "php-ai-client")
assert.ok(claudeOverlay, "Claude Code example should use a php-ai-client bundled-library overlay")
assert.equal(claudeOverlay.kind, codexOverlay?.kind, "Claude Code example should mirror the Codex php-ai-client overlay kind")
assert.equal(claudeOverlay.target, codexOverlay?.target, "Claude Code example should mount php-ai-client at the same target as the Codex example")
assert.equal(claudeOverlay.strategy, codexOverlay?.strategy, "Claude Code example should use the same php-ai-client overlay strategy as the Codex example")

const claudeProvider = claudeRecipe.inputs?.extra_plugins?.find((plugin: Record<string, unknown>) => plugin.slug === "ai-provider-for-claude-code")
assert.ok(claudeProvider, "Claude Code example should use the carried ai-provider-for-claude-code plugin")
assert.equal(claudeProvider.activate, false, "Claude Code provider plugin activation should follow the Codex example pattern")
assert.match(String(claudeProvider.source), /wp-coding-agents\/carried-plugins\/ai-provider-for-claude-code/)

const args = claudeRecipe.workflow?.steps?.[0]?.args ?? []
assert.ok(args.includes("provider=claude-code"), "Claude Code example should select the provider through the sandbox agent task")
assert.ok(args.includes("model=claude-code"), "Claude Code example should keep model selection at provider level")
assert.ok(args.includes("provider-plugin-slugs=ai-provider-for-claude-code"), "Claude Code example should pass provider plugin slugs like the Codex recipe")

assert.deepEqual(claudeRecipe.inputs?.secretEnv, [
  "AI_PROVIDER_CLAUDE_CODE_REFRESH_TOKEN",
  "AI_PROVIDER_CLAUDE_CODE_ACCESS_TOKEN",
  "AI_PROVIDER_CLAUDE_CODE_EXPIRES_AT",
], "Claude Code example should reference env names only, not auth/session values")

assert.ok(!claudeJson.includes("claude_code/run"), "Claude Code example should not use a Codebox host/runtime command")
assert.ok(!claudeJson.includes("hostTools"), "Claude Code example should not add host tools")
assert.ok(!claudeJson.includes("Homeboy"), "Claude Code example should not make Homeboy part of the recipe contract")
assert.ok(!claudeJson.includes("refresh-token-"), "Claude Code example should not contain sample session material")
assert.ok(!claudeJson.includes("access-token-"), "Claude Code example should not contain sample auth material")

console.log("Claude Code agent recipe smoke passed")
