import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-component-contracts-smoke-"))

try {
  const domainPlugin = writePlugin(root, "domain-component", "Domain Component")
  const runtimePlugin = writePlugin(root, "runtime-component", "Runtime Component")
  const artifacts = join(root, "artifacts")
  mkdirSync(artifacts, { recursive: true })

  const recipe = buildAgentTaskRecipe({
    goal: "verify component contract staging",
    artifacts_path: artifacts,
    component_contracts: [
      { slug: "domain-component", path: domainPlugin, loadAs: "plugin", activate: true },
      { slug: "runtime-component", path: runtimePlugin, loadAs: "mu-plugin", activate: false },
    ],
  }, normalizeTaskInput({ goal: "verify component contract staging" }), "latest")

  const plugins = recipe.inputs?.extra_plugins ?? []
  assert.equal(plugins.length, 2, "component_contracts should become canonical staged plugin inputs")

  const domain = plugins.find((plugin) => plugin.slug === "domain-component")
  const runtime = plugins.find((plugin) => plugin.slug === "runtime-component")
  assert.ok(domain, "explicit domain component should be staged")
  assert.ok(runtime, "runtime component should coexist with explicit domain component")
  assert.equal(domain?.loadAs, "plugin")
  assert.equal(domain?.activate, true)
  assert.equal(runtime?.loadAs, "mu-plugin")
  assert.equal(runtime?.activate, false)
  assert.match(String(domain?.source), /prepared-plugins\/domain-component$/)
  assert.match(String(runtime?.source), /prepared-plugins\/runtime-component$/)
  assert.equal(domain?.metadata?.componentContract?.requestedPath, domainPlugin)
  assert.equal(domain?.metadata?.componentContract?.preparedPath, domain?.source)
  assert.equal(runtime?.metadata?.componentContract?.requestedPath, runtimePlugin)
  assert.equal(runtime?.metadata?.componentContract?.preparedPath, runtime?.source)

  const missingComponentSource = "https://example.com/missing-component.zip"
  const invalidRecipePath = join(root, "invalid-component-recipe.json")
  writeFileSync(invalidRecipePath, JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", blueprint: { steps: [] } },
    inputs: {
      extra_plugins: [{
        source: missingComponentSource,
        slug: "missing-component",
        activate: true,
        loadAs: "plugin",
        metadata: {
          componentContract: {
            index: 0,
            slug: "missing-component",
            requestedPath: missingComponentSource,
            preparedPath: missingComponentSource,
            loadAs: "plugin",
            activate: true,
          },
        },
      }],
    },
    workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 'unreachable';"] }] },
  }, null, 2))

  const output = await captureStdout(async () => await runRecipeRunCommand(["--recipe", invalidRecipePath, "--json"]))
  const parsed = JSON.parse(output) as { success: boolean; componentContracts?: Array<Record<string, unknown>> }
  assert.equal(parsed.success, false, "invalid component source should fail explicitly")
  assert.equal(parsed.componentContracts?.length, 1)
  assert.equal(parsed.componentContracts?.[0]?.requestedPath, missingComponentSource)
  assert.equal(parsed.componentContracts?.[0]?.preparedPath, missingComponentSource)
  assert.equal(parsed.componentContracts?.[0]?.loadAs, "plugin")
  assert.equal(parsed.componentContracts?.[0]?.activationStatus, "pending")
  assert.equal(parsed.componentContracts?.[0]?.status, "failed")
  assert.ok(Array.isArray(parsed.componentContracts?.[0]?.failures))
  assert.match(JSON.stringify(parsed.componentContracts?.[0]?.failures), /External recipe sources|missing-component/)

  console.log("component-contracts-agent-task-smoke: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

function writePlugin(rootPath: string, slug: string, name: string): string {
  const pluginPath = join(rootPath, slug)
  mkdirSync(pluginPath, { recursive: true })
  writeFileSync(join(pluginPath, `${slug}.php`), `<?php
/**
 * Plugin Name: ${name}
 */
defined( 'ABSPATH' ) || exit;
`)
  return pluginPath
}

async function captureStdout(callback: () => Promise<unknown>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  ;(process.stdout.write as typeof process.stdout.write) = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString()
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }
    return true
  }) as typeof process.stdout.write
  try {
    await callback()
    return stdout
  } finally {
    process.stdout.write = originalWrite
  }
}
