import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dryRunRecipe } from "../packages/cli/src/recipe-dry-run.js"
import { recipeExecutionSpec } from "../packages/cli/src/agent-sandbox.js"

const recipe = JSON.parse(readFileSync("examples/recipes/cookbook/codex-agent-smoke.json", "utf8"))

const overlay = recipe.runtime?.overlays?.find((entry: Record<string, unknown>) => entry.library === "php-ai-client")
assert.ok(overlay, "Codex example should include a php-ai-client overlay")
assert.equal(overlay.kind, "bundled-library")
assert.equal(overlay.target, "/wordpress/wp-includes/php-ai-client")
assert.equal(overlay.strategy, "wordpress-scoped-bundle")

const providerPlugin = recipe.inputs?.extra_plugins?.find((entry: Record<string, unknown>) => entry.slug === "ai-provider-for-openai")
assert.ok(providerPlugin, "Codex example should include the OpenAI provider plugin")
assert.equal(providerPlugin.activate, false, "Codex provider plugin activation should be handled by the sandbox agent task")

const args = recipe.workflow?.steps?.[0]?.args ?? []
assert.ok(args.includes("provider=codex"), "Codex recipe should select the codex provider id")
assert.ok(args.includes("provider-plugin-slugs=ai-provider-for-openai"), "Codex recipe should pass the provider plugin slug")

const root = mkdtempSync(join(tmpdir(), "wp-codebox-codex-recipe-"))
try {
  const materializedRecipePath = join(root, "recipe.json")
  const materializedRecipe = await materializeSampleProviderStack(recipe, root)
  writeFileSync(materializedRecipePath, JSON.stringify(materializedRecipe, null, 2))

  const dryRun = await dryRunRecipe({ recipePath: materializedRecipePath }, { defaultWordPressVersion: "trunk", resolveExecutionSpec: recipeExecutionSpec })
  assert.equal(dryRun.schema, "wp-codebox/recipe-run-dry-run/v1")
  assert.equal(dryRun.success, true, JSON.stringify(dryRun.validation?.issues ?? dryRun.error, null, 2))
  assert.equal(dryRun.valid, true, JSON.stringify(dryRun.validation?.issues ?? dryRun.error, null, 2))
  assert.equal(dryRun.plan?.runtime.backend, "wordpress-playground")
  assert.equal(dryRun.plan?.extra_plugins.length, 4)
  assert.equal(dryRun.plan?.secretEnv.map((entry) => entry.name).includes("AI_PROVIDER_OPENAI_CODEX_ACCESS_TOKEN"), true)
  const agentStep = dryRun.plan?.workflow.steps.find((step) => step.parsedArgs.provider === "codex")
  assert.ok(agentStep, "dry-run plan should include the Codex agent step")
  assert.equal(agentStep.resolvedCommand, "wordpress.run-php")
  assert.equal(agentStep.parsedArgs["provider-plugin-slugs"], "ai-provider-for-openai")
  assert.equal(agentStep.policy.status, "allowed")
  assert.equal(agentStep.policy.command, "wordpress.run-php")
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log("Codex agent recipe smoke passed")

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
