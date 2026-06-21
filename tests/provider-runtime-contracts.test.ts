import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  PROVIDER_RUNTIME_ABILITY_NAMES,
  PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
  PROVIDER_RUNTIME_TASK_NAMES,
  providerRuntimeInvocationContract,
} from "../packages/runtime-core/src/index.js"
import { phpCallBlock } from "../scripts/test-kit.js"

const contract = providerRuntimeInvocationContract()

assert.equal(contract.schema, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(contract.version, 1)
assert.deepEqual(contract.tasks, PROVIDER_RUNTIME_TASK_NAMES)
assert.deepEqual(contract.abilities, PROVIDER_RUNTIME_ABILITY_NAMES)
assert.equal(contract.tasks.workspacePrepare, "wp-codebox.runner-workspace.prepare")
assert.equal(contract.tasks.workspaceCapture, "wp-codebox.runner-workspace.capture")
assert.equal(contract.abilities.workspacePrepare, "wp-codebox/prepare")
assert.equal(contract.abilities.workspaceCapture, "wp-codebox/capture")
assert.equal(contract.abilities.workspaceCommand, "wp-codebox/command")
assert.equal(contract.abilities.workspacePublish, "wp-codebox/publish")
assert.equal(contract.result_schemas.workspace_prepare, "wp-codebox/runner-workspace-prepare-result/v1")
assert.equal(contract.result_schemas.workspace_capture, "wp-codebox/runner-workspace-capture-result/v1")
assert.equal(contract.result_schemas.workspace_command, "wp-codebox/runner-workspace-command-result/v1")
assert.equal(contract.result_schemas.workspace_publication, "wp-codebox/runner-workspace-publication-result/v1")
assert.equal(contract.result_schemas.tool_call_transcript, "wp-codebox/tool-call-transcript/v1")
assert.equal(contract.result_schemas.evidence_artifact_envelope, "wp-codebox/evidence-artifact-envelope/v1")

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const runnerWorkspacePhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-runner-publication.php", "utf8")
const registeredAbilityIds = [
  contract.abilities.workspacePrepare,
  contract.abilities.workspaceCapture,
  contract.abilities.workspaceCommand,
  contract.abilities.workspacePublish,
  "wp-codebox/prepare-runner-workspace",
  "wp-codebox/capture-runner-workspace",
  "wp-codebox/run-runner-workspace-command",
  "wp-codebox/publish-runner-workspace",
]

for (const abilityId of registeredAbilityIds) {
  assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", abilityId), new RegExp(`'${abilityId}'`))
}

assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspacePrepare), /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'prepare_runner_workspace'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspaceCapture), /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'capture_runner_workspace'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspaceCommand), /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'run_runner_workspace_command'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspaceCommand), /'permission_callback'\s*=>\s*array\(\s*self::class,\s*'can_run_agent_task'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspacePublish), /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'publish_runner_workspace'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspacePublish), /'permission_callback'\s*=>\s*array\(\s*self::class,\s*'can_run_agent_task'\s*\)/)

assert.match(runnerWorkspacePhp, /apply_filters\(\s*'wp_codebox_runner_workspace_backend'/)
assert.doesNotMatch(runnerWorkspacePhp, /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)

const serialized = JSON.stringify(contract)
assert.doesNotMatch(serialized, /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)

console.log("provider runtime contracts ok")
