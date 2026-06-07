import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { normalizeTaskInput } from "@automattic/wp-codebox-core"
import { buildAgentTaskRecipe } from "../packages/cli/src/commands/agent-task-run.js"

const input = {
  goal: "Run a Data Machine bundle",
  provider: "openai",
  model: "gpt-5.5",
  runtime_component_paths: {
    agents_api: "/components/agents-api",
    agent_runtime: "/components/data-machine",
    agent_runtime_tools: "/components/data-machine-code",
  },
  provider_plugin_paths: ["/components/ai-provider-for-openai"],
  artifacts_path: "/tmp/wp-codebox-artifacts",
}

const recipe = buildAgentTaskRecipe(input, normalizeTaskInput(input), "trunk")
const extraPlugins = recipe.inputs?.extraPlugins ?? []

assert.equal(extraPlugins.find((plugin) => plugin?.slug === "agents-api")?.source, "/components/agents-api")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "data-machine")?.source, "/components/data-machine")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "data-machine-code")?.source, "/components/data-machine-code")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "ai-provider-for-openai")?.source, "/components/ai-provider-for-openai")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "agents-api")?.loadAs, "mu-plugin")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "data-machine")?.loadAs, "mu-plugin")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "data-machine-code")?.loadAs, "mu-plugin")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "ai-provider-for-openai")?.loadAs, undefined)
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "agents-api")?.activate, false)
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "data-machine")?.activate, false)
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "data-machine-code")?.activate, false)

const legacyInput = {
  goal: "Run a Data Machine bundle",
  agents_api_path: "/legacy/agents-api",
  data_machine_path: "/legacy/data-machine",
  data_machine_code_path: "/legacy/data-machine-code",
}
const legacyRecipe = buildAgentTaskRecipe(legacyInput, normalizeTaskInput(legacyInput), "trunk")
const legacyExtraPlugins = legacyRecipe.inputs?.extraPlugins ?? []

assert.equal(legacyExtraPlugins.find((plugin) => plugin?.slug === "agents-api")?.source, "/legacy/agents-api")
assert.equal(legacyExtraPlugins.find((plugin) => plugin?.slug === "data-machine")?.source, "/legacy/data-machine")
assert.equal(legacyExtraPlugins.find((plugin) => plugin?.slug === "data-machine-code")?.source, "/legacy/data-machine-code")
assert.equal(legacyExtraPlugins.find((plugin) => plugin?.slug === "data-machine")?.loadAs, "mu-plugin")

const profileRoot = mkdtempSync(join(tmpdir(), "wp-codebox-agent-task-profile-"))
const codexProviderPath = join(profileRoot, "ai-provider-for-openai@codex-oauth-provider")
const phpAiClientPath = join(profileRoot, "php-ai-client@custom-provider-auth")
mkdirSync(codexProviderPath, { recursive: true })
mkdirSync(phpAiClientPath, { recursive: true })
process.env.WP_CODEBOX_CODEX_PROVIDER_PLUGIN_PATH = codexProviderPath
process.env.WP_CODEBOX_PHP_AI_CLIENT_PATH = phpAiClientPath

const codexProfileInput = {
  goal: "Run a Codex subscription-backed agent",
  provider: "codex",
  model: "gpt-5.5",
  runtime_overlay_profiles: ["codex-subscription"],
  artifacts_path: "/tmp/wp-codebox-artifacts",
}
const codexProfileRecipe = buildAgentTaskRecipe(codexProfileInput, normalizeTaskInput(codexProfileInput), "trunk")
const codexPlugins = codexProfileRecipe.inputs?.extraPlugins ?? []
const codexOverlays = codexProfileRecipe.runtime?.overlays ?? []

assert.equal(codexPlugins.find((plugin) => plugin?.slug === "ai-provider-for-openai-codex-oauth-provider")?.source, codexProviderPath)
assert.equal(codexOverlays[0]?.kind, "bundled-library")
assert.equal(codexOverlays[0]?.library, "php-ai-client")
assert.equal(codexOverlays[0]?.source, phpAiClientPath)
assert.equal(codexOverlays[0]?.strategy, "wordpress-scoped-bundle")
