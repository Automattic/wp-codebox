import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chdir, cwd } from "node:process"
import { AGENT_TASK_RUN_REQUEST_SCHEMA, AGENT_TASK_RUN_RESULT_JSON_SCHEMA, AGENT_TASK_RUN_RESULT_SCHEMA, ARTIFACT_RESULT_ENVELOPE_SCHEMA, PREVIEW_LEASE_SCHEMA, buildAgentTaskRecipe, normalizeAgentRuntimeWorkload, normalizeAgentTaskRunResult, normalizeAgentTerminalResult, normalizeRecipeRunSummary, normalizeTaskInput } from "../packages/runtime-core/src/index.js"
import { effectivePolicyCommands } from "../packages/runtime-core/src/contracts.js"
import { commandCatalogOutput } from "../packages/cli/src/commands/discovery.js"
import { agentTaskRunExitCode, normalizeAgentTaskRunCliInput } from "../packages/cli/src/commands/agent-task-run.js"
import { agentSandboxRunCode, resolveSandboxTaskCode } from "../packages/cli/src/agent-code.js"
import { dryRunRecipe } from "../packages/cli/src/recipe-dry-run.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"

const succeeded = normalizeAgentTaskRunResult({ success: true, status: "completed" }, { exitStatus: 0 })
assert.equal(AGENT_TASK_RUN_RESULT_SCHEMA, "wp-codebox/agent-task-run-result/v1")
assert.equal(AGENT_TASK_RUN_RESULT_JSON_SCHEMA.properties.schema.const, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(succeeded.schema, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(succeeded.status, "succeeded")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: succeeded }), 0)

const succeededWithAccess = normalizeAgentTaskRunResult({ success: true, status: "completed", outputs: { preview_url: "https://preview.example.test", site_url: "https://site.example.test" } }, { exitStatus: 0 })
assert.equal(succeededWithAccess.runtime_access?.schema, "wp-codebox/runtime-access/v1")
assert.equal(succeededWithAccess.runtime_access?.preview_url, "https://preview.example.test")
assert.equal(succeededWithAccess.runtime_access?.site_url, "https://site.example.test")

const previewLease = {
  schema: PREVIEW_LEASE_SCHEMA,
  local_url: "http://127.0.0.1:9400/",
  lease: { status: "active", provider: "preview-runtime" },
}

const agentPreviewAccess = normalizeAgentTaskRunResult({
  success: true,
  status: "completed",
  preview: {
    url: "https://preview.example.test/",
    localUrl: "http://127.0.0.1:9400/",
    lease: previewLease,
  },
}, { exitStatus: 0 })
assert.equal(agentPreviewAccess.runtime_access?.preview_url, "https://preview.example.test/")
assert.equal(agentPreviewAccess.runtime_access?.local_url, "http://127.0.0.1:9400/")
assert.equal(agentPreviewAccess.runtime_access?.lease?.local_url, "http://127.0.0.1:9400/")

const agentLocalLeaseAccess = normalizeAgentTaskRunResult({
  success: true,
  status: "completed",
  preview: { localUrl: "http://127.0.0.1:9400/", lease: previewLease },
}, { exitStatus: 0 })
assert.equal(agentLocalLeaseAccess.runtime_access?.preview_url, "http://127.0.0.1:9400/")
assert.equal(agentLocalLeaseAccess.runtime_access?.local_url, "http://127.0.0.1:9400/")

const recipePreviewAccess = normalizeRecipeRunSummary({
  success: true,
  status: "completed",
  run: {
    preview: {
      url: "https://preview.example.test/",
      localUrl: "http://127.0.0.1:9400/",
      publicUrl: "https://review.example.test/",
      lease: previewLease,
    },
  },
}, { exitStatus: 0 })
assert.equal(recipePreviewAccess.runtime_access?.preview_url, "https://review.example.test/")
assert.equal(recipePreviewAccess.runtime_access?.public_url, "https://review.example.test/")
assert.equal(recipePreviewAccess.runtime_access?.local_url, "http://127.0.0.1:9400/")
assert.equal(recipePreviewAccess.preview?.runtime_access?.lease?.local_url, "http://127.0.0.1:9400/")

const stableRunRequestInput = normalizeAgentTaskRunCliInput({
  schema: AGENT_TASK_RUN_REQUEST_SCHEMA,
  task_id: "stable-run",
  task_input: {
    schema: "wp-codebox/task-input/v1",
    goal: "Run the delegated task.",
  },
  artifacts_path: "/tmp/stable-run-artifacts",
  callback_data: { source: "external-orchestrator" },
})
assert.equal(stableRunRequestInput.goal, "Run the delegated task.")
assert.equal(stableRunRequestInput.artifacts_path, "/tmp/stable-run-artifacts")
assert.deepEqual(stableRunRequestInput.callback_data, { source: "external-orchestrator" })

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

const failedBeforeArtifacts = normalizeAgentTaskRunResult({ success: false, status: "failed", summary: "Runtime failed before artifact capture." }, { exitStatus: 1 })
assert.equal(failedBeforeArtifacts.status, "failed")
assert.equal(failedBeforeArtifacts.success, false)
assert.deepEqual(failedBeforeArtifacts.refs.artifact_bundles, [])

const malformedProviderOutput = normalizeAgentTaskRunResult({ success: false, status: "failed", diagnostics: [{ code: "wp-codebox.output.invalid-json", message: "Invalid JSON" }] }, { exitStatus: 0 })
assert.equal(malformedProviderOutput.status, "failed")
assert.equal(malformedProviderOutput.diagnostics[0].code, "wp-codebox.output.invalid-json")

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

const normalizedWithEvidenceBundle = normalizeAgentTaskRunResult({
  success: true,
  evidence_refs: [{ id: "evidence-1", path: "artifacts/run-1/evidence.json", sha256: "abc" }],
}, { exitStatus: 0 })
assert.equal(normalizedWithEvidenceBundle.refs.evidence_bundles[0].kind, "codebox-evidence-bundle")

const catalog = commandCatalogOutput()
const agentSandboxRun = catalog.commands.find((command) => command.id === "wp-codebox.agent-sandbox-run")
assert.ok(agentSandboxRun, "catalog includes wp-codebox.agent-sandbox-run")
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code"), false)
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code-file"), false)
assert.deepEqual(agentSandboxRun.requiresPolicyCommands, ["wordpress.run-php", "wordpress.wp-cli"])

const wordpressBench = catalog.commands.find((command) => command.id === "wordpress.bench")
assert.ok(wordpressBench, "catalog includes wordpress.bench")
const workloadsJsonArg = wordpressBench.acceptedArgs.find((arg) => arg.name === "workloads-json")
assert.match(workloadsJsonArg?.description ?? "", /rest-db-query-profiler/)

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

const generatedAgentSandboxPhp = agentSandboxRunCode("Verify registry adapter", "echo 'ok';", [], [])
assert.doesNotMatch(generatedAgentSandboxPhp, /DataMachine\\Core\\Database\\Agents\\Agents|data_machine_agent_create_failed|agents-api\/agents-api\.php/)
const generatedDefaultAgentPhp = await resolveSandboxTaskCode({
  task: "Verify registry adapter",
  agent: "wp-codebox-sandbox",
  sandboxToolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
})
assert.doesNotMatch(generatedDefaultAgentPhp, /DataMachine\\Core\\Database\\Agents\\Agents|data_machine_agent_create_failed/)
assert.match(generatedDefaultAgentPhp, /wp_codebox_runtime_agent_registry_ensure_agent/)

const agentRecipeTemp = mkdtempSync(join(tmpdir(), "wp-codebox-agent-recipe-test-"))
const originalCwd = cwd()
const originalAgentsApiPath = process.env.WP_CODEBOX_AGENTS_API_PATH
const originalDataMachinePath = process.env.WP_CODEBOX_DATA_MACHINE_PATH
const originalDataMachineCodePath = process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH
const originalRuntimeComponentPaths = process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
const originalContainedRuntimeComponentPaths = process.env.CONTAINED_RUNTIME_COMPONENT_PATHS
try {
  const workspaceRoot = join(agentRecipeTemp, "workspace")
  mkdirSync(workspaceRoot)
  chdir(workspaceRoot)

  const agentsApiSource = join(agentRecipeTemp, "agents-api")
  mkdirSync(agentsApiSource)
  writeFileSync(join(agentsApiSource, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  const dataMachineSource = join(agentRecipeTemp, "data-machine")
  const bundledAgentsApiSource = join(dataMachineSource, "vendor", "wordpress", "agents-api")
  mkdirSync(bundledAgentsApiSource, { recursive: true })
  writeFileSync(join(dataMachineSource, "data-machine.php"), "<?php\n/* Plugin Name: Data Machine */\n")
  writeFileSync(join(bundledAgentsApiSource, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  const dataMachineCodeSource = join(agentRecipeTemp, "data-machine-code")
  mkdirSync(dataMachineCodeSource)
  writeFileSync(join(dataMachineCodeSource, "data-machine-code.php"), "<?php\n/* Plugin Name: Data Machine Code */\n")
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

  const genericRecipe = buildAgentTaskRecipe({
    goal: "Verify generic runtime propagation",
    artifacts_path: artifactsPath,
    provider_plugin_paths: [providerSource],
  }, normalizeTaskInput({ goal: "Verify generic runtime propagation" }), "latest")
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.pluginFile === "wordpress-plugin/wp-codebox.php"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.pluginFile === "wordpress-plugin/wp-codebox.php"), true)
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "agents-api"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.slug === "agents-api"), true)
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "data-machine"), true)
  assert.equal(genericRecipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "data-machine-code"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine"), true)
  assert.equal(genericRecipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine-code"), true)
  const genericSandboxStepArgs = genericRecipe.workflow.steps.find((step) => step.command === "wp-codebox.agent-sandbox-run")?.args ?? []
  const genericRuntimeComponentsArg = genericSandboxStepArgs.find((arg) => arg.startsWith("runtime-component-contracts-json=")) ?? "runtime-component-contracts-json=[]"
  const genericRuntimeComponents = JSON.parse(genericRuntimeComponentsArg.slice("runtime-component-contracts-json=".length)) as Array<{ slug?: string }>
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "wordpress-plugin"), true)
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "agents-api"), true)
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "data-machine"), true)
  assert.equal(genericRuntimeComponents.some((component) => component.slug === "data-machine-code"), true)

  const recipe = buildAgentTaskRecipe({
    goal: "Verify extra plugin propagation",
    artifacts_path: artifactsPath,
    provider_plugin_paths: [providerSource],
    component_contracts: [
      { slug: "agents-api", source: agentsApiSource, pluginFile: "agents-api/agents-api.php", loadAs: "mu-plugin" },
      { slug: "data-machine", source: dataMachineSource, pluginFile: "data-machine/data-machine.php", loadAs: "mu-plugin" },
      { slug: "data-machine-code", source: dataMachineCodeSource, pluginFile: "data-machine-code/data-machine-code.php", loadAs: "mu-plugin" },
    ],
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
  const agentsApiPlugin = extraPlugins.find((plugin) => plugin.slug === "agents-api")
  assert.equal(agentsApiPlugin?.pluginFile, "agents-api/agents-api.php")
  assert.equal(agentsApiPlugin?.activate, false)
  assert.equal(agentsApiPlugin?.loadAs, "mu-plugin")
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "agents-api" && component.loadAs === "mu-plugin"), true)
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine" && component.loadAs === "mu-plugin"), true)
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => component.slug === "data-machine-code" && component.loadAs === "mu-plugin"), true)
  assert.equal(recipe.inputs?.component_manifest?.components.some((component) => String(component.mountedPath).includes("/contained-runtime/")), true)
  assert.equal(JSON.stringify(recipe).includes("wp-codebox-default-agent-runtime-substrate"), false)
  assert.equal(JSON.stringify(recipe).includes("wp-codebox-runtime"), false)
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
  chdir(originalCwd)
  if (originalAgentsApiPath === undefined) {
    delete process.env.WP_CODEBOX_AGENTS_API_PATH
  } else {
    process.env.WP_CODEBOX_AGENTS_API_PATH = originalAgentsApiPath
  }
  if (originalDataMachinePath === undefined) {
    delete process.env.WP_CODEBOX_DATA_MACHINE_PATH
  } else {
    process.env.WP_CODEBOX_DATA_MACHINE_PATH = originalDataMachinePath
  }
  if (originalDataMachineCodePath === undefined) {
    delete process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH
  } else {
    process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH = originalDataMachineCodePath
  }
  if (originalRuntimeComponentPaths === undefined) {
    delete process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS = originalRuntimeComponentPaths
  }
  if (originalContainedRuntimeComponentPaths === undefined) {
    delete process.env.CONTAINED_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.CONTAINED_RUNTIME_COMPONENT_PATHS = originalContainedRuntimeComponentPaths
  }
  rmSync(agentRecipeTemp, { recursive: true, force: true })
}

console.log("agent task contracts passed")
