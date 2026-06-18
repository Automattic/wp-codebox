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
assert.equal(contract.tasks.workspaceCapture, "wp-codebox.runner-workspace.capture")
assert.equal(contract.abilities.workspaceCapture, "wp-codebox/runner-workspace-capture")
assert.equal(contract.abilities.workspaceCommand, "wp-codebox/runner-workspace-command")
assert.equal(contract.abilities.workspacePublish, "wp-codebox/runner-workspace-publish")
assert.equal(contract.result_schemas.workspace_capture, "wp-codebox/runner-workspace-capture-result/v1")
assert.equal(contract.result_schemas.workspace_command, "wp-codebox/runner-workspace-command-result/v1")
assert.equal(contract.result_schemas.workspace_publication, "wp-codebox/runner-workspace-publication-result/v1")
assert.equal(contract.result_schemas.tool_call_transcript, "wp-codebox/tool-call-transcript/v1")
assert.equal(contract.result_schemas.evidence_artifact_envelope, "wp-codebox/evidence-artifact-envelope/v1")

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const registeredAbilityIds = [
  contract.abilities.workspaceCommand,
  contract.abilities.workspacePublish,
  "wp-codebox/run-runner-workspace-command",
  "wp-codebox/publish-runner-workspace",
]

for (const abilityId of registeredAbilityIds) {
  assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", abilityId), new RegExp(`'${abilityId}'`))
}

assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspaceCommand), /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'run_runner_workspace_command'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspaceCommand), /'permission_callback'\s*=>\s*array\(\s*self::class,\s*'can_run_agent_task'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspacePublish), /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'publish_runner_workspace'\s*\)/)
assert.match(phpCallBlock(abilitiesPhp, "wp_register_ability", contract.abilities.workspacePublish), /'permission_callback'\s*=>\s*array\(\s*self::class,\s*'can_run_agent_task'\s*\)/)

const serialized = JSON.stringify(contract)
assert.doesNotMatch(serialized, /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)

console.log("provider runtime contracts ok")
