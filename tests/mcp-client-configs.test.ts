import assert from "node:assert/strict"
import { assertMcpReviewerSafe, renderMcpClientConfigArtifacts } from "../packages/runtime-core/src/index.js"

const rendered = renderMcpClientConfigArtifacts({
  outputRoot: "generated/local-mcp-configs",
  serverName: "example-ai",
  command: "wp-codebox",
  args: ["mcp", "serve", "--recipe", "recipes/example-ai.yml"],
  env: { EXAMPLE_AUTH: "${EXAMPLE_AUTH}" },
  sourceRecipe: "recipes/example-ai.yml",
  clientRecipe: "recipes/example-local-mcp-clients.yml",
  capabilityGroups: ["default", "example-ai"],
  expectedTools: {
    default: ["mcp.initialize", "mcp.tools.list"],
    "example-ai": ["example-ai.describe"],
  },
  authBootstrap: {
    env: "EXAMPLE_AUTH",
    source: "a local test-user shim or hosted sandbox token provider",
    reviewerSafeValue: "${EXAMPLE_AUTH}",
  },
})

assert.equal(rendered.schema, "wp-codebox/local-mcp-client-configs/v1")
assert.equal(rendered.clients.length, 5)
assert.equal(rendered.artifacts.length, 9)
assert.deepEqual(
  rendered.clients.map((client) => client.id),
  ["cursor", "vscode", "goose", "claude-code", "codex"],
)
assert.equal(rendered.manifest.shared_server, "example-ai")

const cursor = rendered.artifacts.find((artifact) => artifact.clientId === "cursor")
assert.ok(cursor)
assert.equal(JSON.parse(cursor.contents).mcpServers["example-ai"].env.EXAMPLE_AUTH, "${EXAMPLE_AUTH}")

const vscode = rendered.artifacts.find((artifact) => artifact.clientId === "vscode")
assert.ok(vscode)
assert.equal(JSON.parse(vscode.contents).servers["example-ai"].type, "stdio")

const goose = rendered.artifacts.find((artifact) => artifact.clientId === "goose")
assert.ok(goose?.contents.includes("EXAMPLE_AUTH: ${EXAMPLE_AUTH}"))

const codex = rendered.artifacts.find((artifact) => artifact.clientId === "codex")
assert.ok(codex?.contents.includes('[mcp_servers.example-ai.env]'))

const manifest = rendered.artifacts.find((artifact) => artifact.path.endsWith("manifest.json"))
assert.ok(manifest)
assert.equal(JSON.parse(manifest.contents).auth_bootstrap.reviewer_safe_value, "${EXAMPLE_AUTH}")

assert.doesNotThrow(() => assertMcpReviewerSafe("token = ${EXAMPLE_AUTH}", "placeholder", ["${EXAMPLE_AUTH}"]))
assert.throws(() => assertMcpReviewerSafe("token = ghp_realvalue", "leak"), /Refusing secret-looking/)
assert.throws(() => assertMcpReviewerSafe("path = /Users/chris/site", "local path"), /Refusing secret-looking/)
assert.throws(
  () => renderMcpClientConfigArtifacts({ outputRoot: "generated", serverName: "example", command: "wp-codebox", args: [], env: { EXAMPLE_AUTH: "real-value" } }),
  /reviewer-safe placeholder/,
)
