import assert from "node:assert/strict"

import {
  PROVIDER_RUNTIME_ABILITY_NAMES,
  PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA,
  PROVIDER_RUNTIME_TASK_NAMES,
  providerRuntimeInvocationContract,
} from "../packages/runtime-core/src/index.js"

const contract = providerRuntimeInvocationContract()

assert.equal(contract.schema, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
assert.equal(contract.version, 1)
assert.deepEqual(contract.tasks, PROVIDER_RUNTIME_TASK_NAMES)
assert.deepEqual(contract.abilities, PROVIDER_RUNTIME_ABILITY_NAMES)
assert.equal(contract.tasks.workspaceCapture, "wp-codebox.runner-workspace.capture")
assert.equal(contract.abilities.workspaceCapture, "wp-codebox/runner-workspace-capture")
assert.equal(contract.result_schemas.workspace_capture, "wp-codebox/runner-workspace-capture-result/v1")
assert.equal(contract.result_schemas.workspace_command, "wp-codebox/runner-workspace-command-result/v1")
assert.equal(contract.result_schemas.workspace_publication, "wp-codebox/runner-workspace-publication-result/v1")
assert.equal(contract.result_schemas.tool_call_transcript, "wp-codebox/tool-call-transcript/v1")
assert.equal(contract.result_schemas.evidence_artifact_envelope, "wp-codebox/evidence-artifact-envelope/v1")

const serialized = JSON.stringify(contract)
assert.doesNotMatch(serialized, /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)

console.log("provider runtime contracts ok")
