import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { recipeExecutionSpec } from "../packages/cli/src/agent-sandbox.js"
import { dryRunRecipe } from "../packages/cli/src/recipe-dry-run.js"

const claudeRecipe = JSON.parse(readFileSync("examples/recipes/cookbook/claude-code-agent-smoke.json", "utf8"))
const codexRecipe = JSON.parse(readFileSync("examples/recipes/cookbook/codex-agent-smoke.json", "utf8"))

assert.equal(claudeRecipe.schema, "wp-codebox/workspace-recipe/v1")
assert.equal(claudeRecipe.runtime?.backend, "wordpress-playground", "Claude Code example should keep Codebox as the WordPress Playground sandbox substrate")
assert.equal(claudeRecipe.runtime?.name, "claude-code-agent-smoke")

const claudeOverlay = claudeRecipe.runtime?.overlays?.find((overlay: Record<string, unknown>) => overlay.library === "php-ai-client")
const codexOverlay = codexRecipe.runtime?.overlays?.find((overlay: Record<string, unknown>) => overlay.library === "php-ai-client")
assert.ok(claudeOverlay, "Claude Code example should use a php-ai-client bundled-library overlay")
assert.equal(claudeOverlay.kind, codexOverlay?.kind, "Claude Code example should mirror the Codex php-ai-client overlay kind")
assert.equal(claudeOverlay.target, codexOverlay?.target, "Claude Code example should mount php-ai-client at the same target as the Codex example")
assert.equal(claudeOverlay.strategy, codexOverlay?.strategy, "Claude Code example should use the same php-ai-client overlay strategy as the Codex example")

const claudeProvider = claudeRecipe.inputs?.extra_plugins?.find((plugin: Record<string, unknown>) => plugin.slug === "ai-provider-for-claude-code")
assert.ok(claudeProvider, "Claude Code example should use the carried ai-provider-for-claude-code plugin")
assert.equal(claudeProvider.activate, false, "Claude Code provider plugin activation should follow the Codex example pattern")
assert.equal(claudeProvider.source, "/sample/prepared-provider-stack/ai-provider-for-claude-code")

const args = claudeRecipe.workflow?.steps?.[0]?.args ?? []
assert.ok(args.includes("provider=claude-code"), "Claude Code example should select the provider through the sandbox agent task")
assert.ok(args.includes("model=claude-code"), "Claude Code example should keep model selection at provider level")
assert.ok(args.includes("provider-plugin-slugs=ai-provider-for-claude-code"), "Claude Code example should pass provider plugin slugs like the Codex recipe")

assert.deepEqual(claudeRecipe.inputs?.secretEnv, [
  "AI_PROVIDER_CLAUDE_CODE_REFRESH_TOKEN",
  "AI_PROVIDER_CLAUDE_CODE_ACCESS_TOKEN",
  "AI_PROVIDER_CLAUDE_CODE_EXPIRES_AT",
], "Claude Code example should reference env names only, not auth/session values")

const root = mkdtempSync(join(tmpdir(), "wp-codebox-claude-recipe-"))
try {
  const materializedRecipePath = join(root, "recipe.json")
  const materializedRecipe = await materializeSampleProviderStack(claudeRecipe, root)
  writeFileSync(materializedRecipePath, JSON.stringify(materializedRecipe, null, 2))

  const dryRun = await dryRunRecipe({ recipePath: materializedRecipePath }, { defaultWordPressVersion: "trunk", resolveExecutionSpec: recipeExecutionSpec })
  assert.equal(dryRun.schema, "wp-codebox/recipe-run-dry-run/v1")
  assert.equal(dryRun.success, true, JSON.stringify(dryRun.validation?.issues ?? dryRun.error, null, 2))
  assert.equal(dryRun.valid, true, JSON.stringify(dryRun.validation?.issues ?? dryRun.error, null, 2))
  assert.equal(dryRun.plan?.runtime.backend, "wordpress-playground")
  assert.equal(dryRun.plan?.extra_plugins.length, 4)
  assert.equal(dryRun.plan?.secretEnv.map((entry) => entry.name).includes("AI_PROVIDER_CLAUDE_CODE_REFRESH_TOKEN"), true)
  const agentStep = dryRun.plan?.workflow.steps.find((step) => step.parsedArgs.provider === "claude-code")
  assert.ok(agentStep, "dry-run plan should include the Claude Code agent step")
  assert.equal(agentStep.resolvedCommand, "wordpress.run-php")
  assert.equal(agentStep.parsedArgs["provider-plugin-slugs"], "ai-provider-for-claude-code")
  assert.equal(agentStep.policy.status, "allowed")
  assert.equal(agentStep.policy.command, "wordpress.run-php")
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log("Claude Code agent recipe smoke passed")

async function materializeSampleProviderStack(sourceRecipe: Record<string, any>, root: string): Promise<Record<string, any>> {
  const recipe = structuredClone(sourceRecipe)
  const plugins = recipe.inputs.extra_plugins as Array<Record<string, any>>
  for (const plugin of plugins) {
    const source = join(root, plugin.slug)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, `${plugin.slug}.php`), `<?php\n/* Plugin Name: ${plugin.slug} */\n`)
    plugin.source = source
    plugin.pluginFile = `${plugin.slug}/${plugin.slug}.php`
  }

  const overlaySource = join(root, "php-ai-client")
  await mkdir(join(overlaySource, "vendor", "composer"), { recursive: true })
  await writeFile(join(overlaySource, "vendor", "composer", "installed.json"), "[]\n")
  recipe.runtime.overlays[0].source = overlaySource
  return recipe
}
