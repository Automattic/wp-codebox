import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentTaskRecipe, resolvePluginEntrypointContract } from "../packages/runtime-core/src/index.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"
import { parseAgentRuntimeProbeOptions } from "../packages/cli/src/agent-sandbox.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-plugin-entrypoint-contract-smoke-"))

try {
  const explicitSource = join(root, "explicit-component")
  mkdirSync(explicitSource, { recursive: true })
  writeFileSync(join(explicitSource, "custom-entry.php"), `<?php
throw new RuntimeException('explicit pluginFile resolution must not read plugin contents');
`)

  const explicit = resolvePluginEntrypointContract({
    source: explicitSource,
    slug: "explicit-component",
    pluginFile: "explicit-component/custom-entry.php",
    loadAs: "plugin",
  })
  assert.equal(explicit.pluginFile, "explicit-component/custom-entry.php")
  assert.equal(explicit.fallback, "explicit")

  const providerSource = join(root, "renamed-provider-worktree")
  mkdirSync(providerSource, { recursive: true })
  writeFileSync(join(providerSource, "ai-provider-for-opencode.php"), `<?php
/**
 * Plugin Name: AI Provider for OpenCode
 */
`)
  writeFileSync(join(providerSource, "composer.json"), JSON.stringify({ name: "chubes4/ai-provider-for-opencode" }))

  const recipe = buildAgentTaskRecipe({
    goal: "verify renamed provider plugin",
    provider_plugin_paths: [providerSource],
    artifacts_path: join(root, "artifacts"),
  }, normalizeTaskInput({ goal: "verify renamed provider plugin" }), "latest")

  const providerPlugin = recipe.inputs?.extra_plugins?.find((plugin) => plugin.slug === "ai-provider-for-opencode")
  assert.ok(providerPlugin, "provider plugin should be staged from provider_plugin_paths")
  assert.equal(providerPlugin?.pluginFile, "ai-provider-for-opencode/ai-provider-for-opencode.php")

  const providerManifest = recipe.inputs?.component_manifest?.providers?.find((plugin) => plugin.slug === "ai-provider-for-opencode")
  assert.ok(providerManifest, "provider plugin should be present in the authoritative component manifest")
  assert.equal(providerManifest?.entrypoint, "ai-provider-for-opencode/ai-provider-for-opencode.php")
  assert.equal(providerManifest?.pluginFile, "ai-provider-for-opencode/ai-provider-for-opencode.php")
  assert.equal(providerManifest?.mountedPath, "/wordpress/wp-content/plugins/ai-provider-for-opencode")

  const componentRecipe = buildAgentTaskRecipe({
    goal: "verify explicit component entrypoint",
    component_contracts: [{ slug: "explicit-component", path: explicitSource, pluginFile: "explicit-component/custom-entry.php", loadAs: "plugin", activate: true }],
    artifacts_path: join(root, "component-artifacts"),
  }, normalizeTaskInput({ goal: "verify explicit component entrypoint" }), "latest")
  const componentManifest = componentRecipe.inputs?.component_manifest?.components?.find((plugin) => plugin.slug === "explicit-component")
  assert.ok(componentManifest, "component plugin should be present in the authoritative component manifest")
  assert.equal(componentManifest?.entrypoint, "explicit-component/custom-entry.php")
  assert.equal(componentManifest?.mountedPath, "/wordpress/wp-content/plugins/explicit-component")
  assert.equal(componentManifest?.activate, true)

  const sandboxStep = recipe.workflow.steps.find((step) => step.command === "wp-codebox.agent-sandbox-run")
  const contractsArg = sandboxStep?.args?.find((arg) => arg.startsWith("provider-plugin-contracts-json="))
  assert.ok(contractsArg, "agent sandbox step should receive provider plugin contracts")
  assert.match(contractsArg || "", /ai-provider-for-opencode\/ai-provider-for-opencode\.php/)

  const sandboxOptions = parseAgentRuntimeProbeOptions([
    "--component", `agents-api=${explicitSource}`,
    "--component", `runtime-engine=${explicitSource}`,
    "--component", `runtime-tools=${explicitSource}`,
  ], (value) => JSON.parse(value))
  assert.deepEqual(sandboxOptions.components.map((component) => component.slug), ["agents-api", "runtime-engine", "runtime-tools"])

  const portableOptions = parseAgentRuntimeProbeOptions([
    "--component", `custom-runtime=${explicitSource}`,
  ], (value) => JSON.parse(value))
  assert.deepEqual(portableOptions.components.map((component) => component.slug), ["custom-runtime"])

  const compatibilityOptions = parseAgentRuntimeProbeOptions([
    "--agents-api", explicitSource,
  ], (value) => JSON.parse(value))
  assert.deepEqual(compatibilityOptions.components.map((component) => component.slug), ["agents-api"])

  assert.throws(() => parseAgentRuntimeProbeOptions([
    "--runtime-engine", explicitSource,
  ], (value) => JSON.parse(value)), /Unknown option: --runtime-engine/)

  const explicitFile = readFileSync(join(explicitSource, "custom-entry.php"), "utf8")
  assert.match(explicitFile, /must not read plugin contents/)

  console.log("component-plugin-entrypoint-contract-smoke: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
