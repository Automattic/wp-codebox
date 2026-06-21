import assert from "node:assert/strict"

import {
  parentToolBridgeContract,
  PARENT_TOOL_BRIDGE_JSON_SCHEMA,
  PARENT_TOOL_BRIDGE_SCHEMA,
  PARENT_TOOL_REQUEST_JSON_SCHEMA,
  PARENT_TOOL_REQUEST_SCHEMA,
  PARENT_TOOL_RESULT_JSON_SCHEMA,
  PARENT_TOOL_RESULT_SCHEMA,
} from "../packages/runtime-core/src/index.js"
import { evaluatePhpJson } from "../scripts/test-kit.js"

const phpContract = "packages/wordpress-plugin/src/class-wp-codebox-parent-tool-bridge-contract.php"

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value), null, 2)
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortObject(entry)]))
}

const bridge = parentToolBridgeContract({
  allowedTools: ["workspace.read", "workspace.read", "jobs.show"],
  bridgeRefEnv: "WP_CODEBOX_PARENT_TOOL_BRIDGE_REF",
  dispatcher: {
    mode: "host_endpoint",
    endpoint: {
      url_env: "WP_CODEBOX_PARENT_TOOL_ENDPOINT",
      method: "POST",
      token_env: "WP_CODEBOX_PARENT_TOOL_TOKEN",
    },
    timeout_ms: 30000,
  },
  transcriptArtifactRefs: [{ kind: "tool-call-transcript", path: "files/parent-tools/session.jsonl" }],
  metadata: { adapter: "example" },
})

assert.equal(bridge.schema, PARENT_TOOL_BRIDGE_SCHEMA)
assert.deepEqual(bridge.allowed_tools, ["workspace.read", "jobs.show"])
assert.equal(bridge.dispatcher.request_schema, PARENT_TOOL_REQUEST_SCHEMA)
assert.equal(bridge.dispatcher.result_schema, PARENT_TOOL_RESULT_SCHEMA)
assert.deepEqual(bridge.sandbox_env.secret_env, [])
assert.equal(bridge.redaction.transcript_artifact_refs[0]?.path, "files/parent-tools/session.jsonl")

const commandBridge = parentToolBridgeContract({
  allowedTools: ["workspace.read"],
  dispatcher: { mode: "host_command", command: { argv: ["wp-codebox-parent-dispatch"] } },
})
assert.equal(commandBridge.dispatcher.command?.argv[0], "wp-codebox-parent-dispatch")

const phpBridgeSchema = await evaluatePhpJson("WP_Codebox_Parent_Tool_Bridge_Contract::bridge_schema()", [phpContract])
assert.equal(canonicalJson(phpBridgeSchema), canonicalJson(PARENT_TOOL_BRIDGE_JSON_SCHEMA), "PHP parent bridge schema must match runtime-core schema")

const phpRequestSchema = await evaluatePhpJson("WP_Codebox_Parent_Tool_Bridge_Contract::request_schema()", [phpContract])
assert.equal(canonicalJson(phpRequestSchema), canonicalJson(PARENT_TOOL_REQUEST_JSON_SCHEMA), "PHP parent tool request schema must match runtime-core schema")

const phpResultSchema = await evaluatePhpJson("WP_Codebox_Parent_Tool_Bridge_Contract::result_schema()", [phpContract])
assert.equal(canonicalJson(phpResultSchema), canonicalJson(PARENT_TOOL_RESULT_JSON_SCHEMA), "PHP parent tool result schema must match runtime-core schema")

console.log("parent tool bridge contract ok")
