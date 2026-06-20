import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ARTIFACT_RESULT_ENVELOPE_SCHEMA, buildAgentTaskRecipe, normalizeAgentRuntimeWorkload, normalizeAgentTaskRunResult, normalizeAgentTerminalResult, normalizeTaskInput } from "../packages/runtime-core/src/index.js"
import { effectivePolicyCommands } from "../packages/runtime-core/src/contracts.js"
import { commandCatalogOutput } from "../packages/cli/src/commands/discovery.js"
import { agentTaskRunExitCode } from "../packages/cli/src/commands/agent-task-run.js"
import { dryRunRecipe } from "../packages/cli/src/recipe-dry-run.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"

const succeeded = normalizeAgentTaskRunResult({ success: true, status: "completed" }, { exitStatus: 0 })
assert.equal(succeeded.status, "succeeded")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: succeeded }), 0)

const noOp = normalizeAgentTaskRunResult({ success: true, no_op: true }, { exitStatus: 0 })
assert.equal(noOp.status, "no_op")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: noOp }), 0)

const timeout = normalizeAgentTaskRunResult({
  success: true,
  terminal_result: {
    schema: "wp-codebox/agent-terminal-result/v1",
    terminal: true,
    status: "max_turns",
    success: false,
  },
}, { exitStatus: 0 })
assert.equal(timeout.status, "timeout")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: timeout }), 1)

const failedExit = normalizeAgentTaskRunResult({ success: true, status: "completed" }, { exitStatus: 1 })
assert.equal(failedExit.status, "failed")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: failedExit }), 1)

const strictLegacyNoOp = normalizeAgentTaskRunResult({ success: true, agent_result: { noOpReason: "Nothing to do", changedFiles: { count: 0 }, patch: { bytes: 0 } } }, { exitStatus: 0 })
assert.equal(strictLegacyNoOp.status, "succeeded")
assert.equal(strictLegacyNoOp.diagnostics.some((diagnostic) => diagnostic.class === "wp-codebox.normalizer.compat_mode_used"), false)

const strictNestedTerminal = normalizeAgentTerminalResult({ agent_runtime: { success: true, result: { pending_tools: ["review"], completed: false } } })
assert.equal(strictNestedTerminal, undefined)

const strictRuntimeWorkload = normalizeAgentRuntimeWorkload({ outputs: { answer: "legacy" } })
assert.deepEqual(strictRuntimeWorkload.outputs, {})
assert.equal(strictRuntimeWorkload.diagnostics.some((diagnostic) => diagnostic.class === "wp-codebox.normalizer.compat_mode_used"), false)

const compatRuntimeWorkload = normalizeAgentRuntimeWorkload({ outputs: { answer: "legacy" } }, { compatMode: true })
assert.deepEqual(compatRuntimeWorkload.outputs, { answer: "legacy" })
assert.equal(compatRuntimeWorkload.diagnostics.some((diagnostic) => diagnostic.class === "wp-codebox.normalizer.compat_mode_used"), true)

const normalizedWithArtifactEnvelope = normalizeAgentTaskRunResult({
  success: true,
  run: { artifactRefs: [{ id: "bundle-1", kind: "artifact-bundle", directory: "artifacts/run-1" }] },
  agentResult: {
    artifacts: { directory: "artifacts/run-1" },
    summary: "Changed one file",
    transcript: { artifact: "files/transcript.json" },
  },
}, { exitStatus: 0 })
assert.equal(normalizedWithArtifactEnvelope.refs.artifact_bundles[0].path, "artifacts/run-1")
assert.equal(normalizedWithArtifactEnvelope.refs.transcripts[0].kind, "codebox-transcript")
assert.equal(ARTIFACT_RESULT_ENVELOPE_SCHEMA, "wp-codebox/artifact-result-envelope/v1")

const catalog = commandCatalogOutput()
const agentSandboxRun = catalog.commands.find((command) => command.id === "wp-codebox.agent-sandbox-run")
assert.ok(agentSandboxRun, "catalog includes wp-codebox.agent-sandbox-run")
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code"), false)
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code-file"), false)
assert.deepEqual(agentSandboxRun.requiresPolicyCommands, ["wordpress.run-php", "wordpress.wp-cli"])

assert.deepEqual(effectivePolicyCommands("wp-codebox.agent-sandbox-run"), ["wordpress.run-php", "wordpress.wp-cli"])
assert.deepEqual(effectivePolicyCommands("custom.wrapper", [
  {
    id: "custom.wrapper",
    description: "test wrapper",
    acceptedArgs: [],
    outputShape: "test",
    policyRequirement: "test",
    requiresPolicyCommands: ["custom.inner"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "custom.inner" },
  },
  {
    id: "custom.inner",
    description: "test inner",
    acceptedArgs: [],
    outputShape: "test",
    policyRequirement: "test",
    requiresPolicyCommands: ["wordpress.run-php"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "wordpress.run-php" },
  },
]), ["wordpress.run-php"])

const agentRecipePolicy = recipePolicy({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      { command: "wp-codebox.agent-sandbox-run", args: ["task=Verify policy dependencies"] },
    ],
  },
} as never)
assert.equal(agentRecipePolicy.commands.includes("wordpress.run-php"), true)
assert.equal(agentRecipePolicy.commands.includes("wordpress.wp-cli"), true)
assert.equal(agentRecipePolicy.commands.includes("wp-codebox.agent-sandbox-run"), false)

const agentRecipeTemp = mkdtempSync(join(tmpdir(), "wp-codebox-agent-recipe-test-"))
const originalAgentsApiPath = process.env.WP_CODEBOX_AGENTS_API_PATH
const originalRuntimeComponentPaths = process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
try {
  const agentsApiSource = join(agentRecipeTemp, "agents-api")
  mkdirSync(agentsApiSource)
  writeFileSync(join(agentsApiSource, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  process.env.WP_CODEBOX_AGENTS_API_PATH = agentsApiSource
  const runtimeEngineSource = join(agentRecipeTemp, "runtime-engine")
  mkdirSync(runtimeEngineSource)
  writeFileSync(join(runtimeEngineSource, "runtime-engine.php"), "<?php\n/* Plugin Name: Runtime Engine */\n")
  process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS = runtimeEngineSource
  const providerSource = join(agentRecipeTemp, "test-provider")
  mkdirSync(providerSource)
  writeFileSync(join(providerSource, "test-provider.php"), "<?php\n/* Plugin Name: Test Provider */\n")
  const bridgeSource = join(agentRecipeTemp, "agent-runtime-tool-bridge")
  mkdirSync(bridgeSource)
  writeFileSync(join(bridgeSource, "agent-runtime-tool-bridge.php"), "<?php\n/* Plugin Name: Agent Runtime Tool Bridge */\n")
  const helperSource = join(agentRecipeTemp, "agent-runtime-helper")
  mkdirSync(helperSource)
  writeFileSync(join(helperSource, "agent-runtime-helper.php"), "<?php\n/* Plugin Name: Agent Runtime Helper */\n")
  const artifactsPath = join(agentRecipeTemp, "artifacts")
  mkdirSync(artifactsPath)

  const recipe = buildAgentTaskRecipe({
    goal: "Verify extra plugin propagation",
    artifacts_path: artifactsPath,
    provider_plugin_paths: [providerSource],
    extra_plugins: [{
      source: bridgeSource,
      slug: "agent-runtime-tool-bridge",
      loadAs: "mu-plugin",
      activate: false,
      pluginFile: "agent-runtime-tool-bridge/agent-runtime-tool-bridge.php",
      metadata: { source: "agent-task-input" },
    }],
    extraPlugins: [{
      source: providerSource,
      slug: "test-provider",
      loadAs: "plugin",
      activate: true,
    }, {
      source: helperSource,
      slug: "agent-runtime-helper",
      loadAs: "plugin",
      activate: true,
      pluginFile: "agent-runtime-helper/agent-runtime-helper.php",
    }],
  }, normalizeTaskInput({ goal: "Verify extra plugin propagation" }), "latest")
  const extraPlugins = recipe.inputs?.extra_plugins ?? []
  assert.deepEqual(extraPlugins.find((plugin) => plugin.slug === "agents-api"), {
    source: agentsApiSource,
    slug: "agents-api",
    pluginFile: "agents-api/agents-api.php",
    activate: false,
    loadAs: "mu-plugin",
    metadata: { source: "wp-codebox-default-agent-runtime-substrate" },
  })
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "agents-api" && component.loadAs === "mu-plugin"), true)
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "runtime-engine" && component.loadAs === "mu-plugin"), true)
  assert.equal(extraPlugins.some((plugin) => plugin.slug === "test-provider" && plugin.activate === true && plugin.loadAs === "plugin"), true)
  assert.equal(extraPlugins.filter((plugin) => plugin.slug === "test-provider" && plugin.loadAs === "plugin").length, 1)
  assert.deepEqual(extraPlugins.find((plugin) => plugin.slug === "agent-runtime-tool-bridge"), {
    source: bridgeSource,
    slug: "agent-runtime-tool-bridge",
    pluginFile: "agent-runtime-tool-bridge/agent-runtime-tool-bridge.php",
    activate: false,
    loadAs: "mu-plugin",
    metadata: { source: "agent-task-input" },
  })
  assert.deepEqual(extraPlugins.find((plugin) => plugin.slug === "agent-runtime-helper"), {
    source: helperSource,
    slug: "agent-runtime-helper",
    pluginFile: "agent-runtime-helper/agent-runtime-helper.php",
    activate: true,
    loadAs: "plugin",
  })

  const recipePath = join(agentRecipeTemp, "recipe.json")
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2))
  const dryRun = await dryRunRecipe({ recipePath, artifactsDirectory: artifactsPath }, {
    defaultWordPressVersion: "latest",
    resolveExecutionSpec: async (step) => ({ command: step.command, args: step.args ?? [] }),
  })
  assert.equal(dryRun.success, true)
  assert.deepEqual(dryRun.plan?.runtime.blueprint, { steps: [] })
} finally {
  if (originalAgentsApiPath === undefined) {
    delete process.env.WP_CODEBOX_AGENTS_API_PATH
  } else {
    process.env.WP_CODEBOX_AGENTS_API_PATH = originalAgentsApiPath
  }
  if (originalRuntimeComponentPaths === undefined) {
    delete process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS = originalRuntimeComponentPaths
  }
  rmSync(agentRecipeTemp, { recursive: true, force: true })
}

console.log("agent task contracts passed")
