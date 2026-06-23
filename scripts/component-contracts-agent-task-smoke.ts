import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-component-contracts-smoke-"))

try {
  const domainPlugin = writePlugin(root, "domain-component", "Domain Component")
  const runtimePlugin = writePlugin(root, "runtime-component", "Runtime Component")
  const dedupePlugin = writePlugin(root, "dedupe-component", "Dedupe Component")
  const requirementsPlugin = writePlugin(root, "requirements-component", "Requirements Component")
  const monorepo = writeMonorepoPlugin(root, "monorepo-component", "Monorepo Component")
  const artifacts = join(root, "artifacts")
  mkdirSync(artifacts, { recursive: true })

  const recipe = buildAgentTaskRecipe({
    goal: "verify component contract staging",
    artifacts_path: artifacts,
    component_contracts: [
      { slug: "domain-component", path: domainPlugin, loadAs: "plugin", activate: true },
      { slug: "runtime-component", path: runtimePlugin, loadAs: "mu-plugin", activate: false },
      { slug: "dedupe-component", path: dedupePlugin, loadAs: "plugin" },
      { slug: "monorepo-component", path: monorepo.pluginPath, sourceRoot: monorepo.rootPath, sourceSubpath: monorepo.sourceSubpath, loadAs: "plugin" },
    ],
    runtime_requirements: {
      extra_plugins: [
        { slug: "requirements-component", source: requirementsPlugin, pluginFile: "requirements-component/requirements-component.php", loadAs: "plugin", activate: true },
        { slug: "dedupe-component", source: dedupePlugin, pluginFile: "dedupe-component/dedupe-component.php", loadAs: "plugin", activate: true },
      ],
    },
  }, normalizeTaskInput({ goal: "verify component contract staging" }), "latest")

  const plugins = recipe.inputs?.extra_plugins ?? []
  const componentPlugins = plugins.filter((plugin) => plugin.metadata?.componentContract)
  assert.equal(componentPlugins.length, 4, "component_contracts should become canonical staged plugin inputs")

  const domain = componentPlugins.find((plugin) => plugin.slug === "domain-component")
  const runtime = componentPlugins.find((plugin) => plugin.slug === "runtime-component")
  const dedupe = componentPlugins.find((plugin) => plugin.slug === "dedupe-component")
  const monorepoComponent = componentPlugins.find((plugin) => plugin.slug === "monorepo-component")
  const requirements = plugins.find((plugin) => plugin.slug === "requirements-component")
  assert.ok(domain, "explicit domain component should be staged")
  assert.ok(runtime, "runtime component should coexist with explicit domain component")
  assert.ok(dedupe, "component contract duplicate should remain staged")
  assert.ok(monorepoComponent, "component contract should stage monorepo source roots")
  assert.ok(requirements, "runtime_requirements.extra_plugins should become recipe extra plugins")
  assert.equal(domain?.loadAs, "plugin")
  assert.equal(domain?.activate, true)
  assert.equal(runtime?.loadAs, "mu-plugin")
  assert.equal(runtime?.activate, false)
  assert.equal(dedupe?.loadAs, "plugin")
  assert.equal(dedupe?.activate, true)
  assert.equal(requirements?.loadAs, "plugin")
  assert.equal(requirements?.activate, true)
  assert.equal(requirements?.pluginFile, "requirements-component/requirements-component.php")
  assert.match(String(domain?.source), /prepared-plugins\/domain-component$/)
  assert.match(String(runtime?.source), /prepared-plugins\/runtime-component$/)
  assert.equal(domain?.metadata?.componentContract?.requestedPath, domainPlugin)
  assert.equal(domain?.metadata?.componentContract?.preparedPath, domain?.source)
  assert.equal(domain?.metadata?.componentContract?.pluginFile, "domain-component/domain-component.php")
  assert.equal(existsSync(join(String(domain?.source), ".git")), false, "prepared component source should exclude VCS metadata")
  assert.equal(existsSync(join(String(domain?.source), "node_modules")), false, "prepared component source should exclude Node dependencies")
  assert.equal(existsSync(join(String(domain?.source), "vendor")), false, "prepared component source should exclude Composer dependencies before hydration")
  assert.equal(runtime?.metadata?.componentContract?.requestedPath, runtimePlugin)
  assert.equal(runtime?.metadata?.componentContract?.preparedPath, runtime?.source)
  assert.equal(runtime?.metadata?.componentContract?.pluginFile, "runtime-component/runtime-component.php")
  assert.match(String(monorepoComponent?.source), /prepared-plugins\/monorepo-component\/plugins\/monorepo-component$/)
  assert.equal(monorepoComponent?.metadata?.componentContract?.requestedPath, monorepo.pluginPath)
  assert.equal(monorepoComponent?.metadata?.componentContract?.sourceRoot, monorepo.rootPath)
  assert.equal(monorepoComponent?.metadata?.componentContract?.sourceSubpath, monorepo.sourceSubpath)
  assert.equal(existsSync(join(String(monorepoComponent?.source), "monorepo-component.php")), true)
  assert.equal(existsSync(join(String(monorepoComponent?.source), "..", "..", "packages", "php", "shared", "composer.json")), true)
  assert.equal(existsSync(join(String(monorepoComponent?.source), "vendor", "autoload_packages.php")), true)
  assert.equal(existsSync(join(String(monorepoComponent?.source), "vendor", "jetpack-autoloader", "class-autoloader.php")), true)

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
  mkdirSync(join(pluginPath, ".git"), { recursive: true })
  mkdirSync(join(pluginPath, "node_modules"), { recursive: true })
  mkdirSync(join(pluginPath, "vendor"), { recursive: true })
  writeFileSync(join(pluginPath, `${slug}.php`), `<?php
/**
 * Plugin Name: ${name}
 */
defined( 'ABSPATH' ) || exit;
`)
  return pluginPath
}

function writeMonorepoPlugin(rootPath: string, slug: string, name: string): { rootPath: string; pluginPath: string; sourceSubpath: string } {
  const monorepoRoot = join(rootPath, `${slug}-repo`)
  const sourceSubpath = join("plugins", slug)
  const pluginPath = join(monorepoRoot, sourceSubpath)
  mkdirSync(pluginPath, { recursive: true })
  mkdirSync(join(pluginPath, "vendor", "jetpack-autoloader"), { recursive: true })
  mkdirSync(join(monorepoRoot, "packages", "php", "shared"), { recursive: true })
  writeFileSync(join(monorepoRoot, "packages", "php", "shared", "composer.json"), "{}\n")
  writeFileSync(join(pluginPath, "vendor", "autoload_packages.php"), "<?php // generated package autoloader\n")
  writeFileSync(join(pluginPath, "vendor", "jetpack-autoloader", "class-autoloader.php"), "<?php // package autoloader runtime\n")
  writeFileSync(join(pluginPath, `${slug}.php`), `<?php
/**
 * Plugin Name: ${name}
 */
defined( 'ABSPATH' ) || exit;
`)
  return { rootPath: monorepoRoot, pluginPath, sourceSubpath }
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
