import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
  PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
  PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
  PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  PROVIDER_RUNTIME_ABILITY_NAMES,
  PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
  PROVIDER_RUNTIME_TASK_NAMES,
  providerRuntimeInvocationContract,
} from "../packages/runtime-core/src/index.js"
import { phpCallBlock, phpFunctionBlock } from "../scripts/test-kit.js"

const contract = providerRuntimeInvocationContract()

assert.equal(contract.schema, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(contract.version, 1)
assert.deepEqual(contract.tasks, PROVIDER_RUNTIME_TASK_NAMES)
assert.deepEqual(contract.abilities, PROVIDER_RUNTIME_ABILITY_NAMES)
assert.equal(contract.tasks.workspacePrepare, "wp-codebox.runner-workspace.prepare")
assert.equal(contract.tasks.workspaceCapture, "wp-codebox.runner-workspace.capture")
assert.equal(contract.abilities.workspacePrepare, "wp-codebox/runner-workspace-prepare")
assert.equal(contract.abilities.workspaceCapture, "wp-codebox/runner-workspace-capture")
assert.equal(contract.abilities.workspaceCommand, "wp-codebox/runner-workspace-command")
assert.equal(contract.abilities.workspacePublish, "wp-codebox/runner-workspace-publish")
assert.equal(contract.result_schemas.workspace_prepare, "wp-codebox/runner-workspace-prepare-result/v1")
assert.equal(contract.result_schemas.workspace_capture, "wp-codebox/runner-workspace-capture-result/v1")
assert.equal(contract.result_schemas.workspace_command, "wp-codebox/runner-workspace-command-result/v1")
assert.equal(contract.result_schemas.workspace_publication, "wp-codebox/runner-workspace-publication-result/v1")
assert.equal(contract.result_schemas.tool_call_transcript, "wp-codebox/tool-call-transcript/v1")
assert.equal(contract.result_schemas.evidence_artifact_envelope, "wp-codebox/evidence-artifact-envelope/v1")
assert.equal(PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA, "wp-codebox/provider-credential-requirements/v1")
assert.equal(PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA, "wp-codebox/provider-credential-preflight/v1")
assert.equal(PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA, "wp-codebox/provider-credential-resolution/v1")

const credentialResolution = {
  schema: PROVIDER_CREDENTIAL_RESOLUTION_SCHEMA,
  requirements: {
    schema: PROVIDER_CREDENTIAL_REQUIREMENTS_SCHEMA,
    provider: "example-provider",
    requirements: [{ name: "primary_api_token", required: true, kind: "api-token", secretEnv: ["EXAMPLE_PROVIDER_TOKEN"] }],
    redacted: true,
  },
  preflight: {
    schema: PROVIDER_CREDENTIAL_PREFLIGHT_SCHEMA,
    provider: "example-provider",
    status: "available",
    requirements: [{ name: "primary_api_token", required: true, kind: "api-token", secretEnv: ["EXAMPLE_PROVIDER_TOKEN"] }],
    secret_env: ["EXAMPLE_PROVIDER_TOKEN"],
    diagnostics: [{ code: "resolved", severity: "info", message: "Credential resolved by provider-owned boundary." }],
    redacted: true,
  },
  secret_env: ["EXAMPLE_PROVIDER_TOKEN"],
  redacted: true,
}
assert.doesNotMatch(JSON.stringify(credentialResolution), /token-value|secret_env_values|credentials/i)

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const runnerWorkspacePhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-runner-publication.php", "utf8")
const runnerWorkspaceAdapterPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-runner-workspace-adapter.php", "utf8")
const providerCredentialsPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-provider-credentials.php", "utf8")
const registeredAbilityIds = [
  contract.abilities.workspacePrepare,
  contract.abilities.workspaceCapture,
  contract.abilities.workspaceCommand,
  contract.abilities.workspacePublish,
  "wp-codebox/prepare",
  "wp-codebox/capture",
  "wp-codebox/command",
  "wp-codebox/publish",
  "wp-codebox/prepare-runner-workspace",
  "wp-codebox/capture-runner-workspace",
  "wp-codebox/run-runner-workspace-command",
  "wp-codebox/publish-runner-workspace",
  "wp-codebox/runner-workspace-publish",
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

const aliasExpectations = new Map([
  ["wp-codebox/prepare", contract.abilities.workspacePrepare],
  ["wp-codebox/prepare-runner-workspace", contract.abilities.workspacePrepare],
  ["wp-codebox/capture", contract.abilities.workspaceCapture],
  ["wp-codebox/capture-runner-workspace", contract.abilities.workspaceCapture],
  ["wp-codebox/command", contract.abilities.workspaceCommand],
  ["wp-codebox/run-runner-workspace-command", contract.abilities.workspaceCommand],
  ["wp-codebox/publish", contract.abilities.workspacePublish],
  ["wp-codebox/publish-runner-workspace", contract.abilities.workspacePublish],
])

for (const [alias, canonical] of aliasExpectations) {
  const block = phpCallBlock(abilitiesPhp, "wp_register_ability", alias)
  assert.match(block, new RegExp(`'canonical_ability'\\s*=>\\s*'${canonical}'`))
  assert.match(block, new RegExp(`'alias_of'\\s*=>\\s*'${canonical}'`))
}

assert.match(runnerWorkspaceAdapterPhp, /apply_filters\(\s*'wp_codebox_runner_workspace_backend'/)
assert.match(providerCredentialsPhp, /wp_codebox_provider_credential_requirements/)
assert.match(providerCredentialsPhp, /wp_codebox_resolve_provider_credentials/)
assert.doesNotMatch(providerCredentialsPhp, /secret_env_values|access_token|refresh_token/i)
const serialized = JSON.stringify(contract)
assert.doesNotMatch(serialized, /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)
assert.doesNotMatch(phpFunctionBlock(runnerWorkspacePhp, "runner_workspace_prepare_output_schema"), /'backend'|'input'|'result'/)
assert.doesNotMatch(phpFunctionBlock(runnerWorkspacePhp, "runner_workspace_capture_output_schema"), /'backend'/)
assert.doesNotMatch(phpFunctionBlock(runnerWorkspacePhp, "runner_workspace_command_output_schema"), /'backend'/)
assert.doesNotMatch(phpFunctionBlock(runnerWorkspacePhp, "runner_workspace_publication_output_schema"), /'backend'/)
assert.match(runnerWorkspacePhp, /sanitize_runner_workspace_public_error/)

console.log("provider runtime contracts ok")
