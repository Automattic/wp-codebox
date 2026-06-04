import assert from "node:assert/strict"
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
