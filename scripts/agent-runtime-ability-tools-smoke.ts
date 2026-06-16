import { readFileSync } from "node:fs"

const browserSource = readFileSync("packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runner.php", "utf8")
const cliSource = readFileSync("packages/cli/src/agent-code.ts", "utf8")

const browserSnippets = [
  "function wp_codebox_browser_runtime_ability_tool_declarations",
  "$task_input[\\'ability_tools\\']",
  "add_filter( \\'datamachine_ability_tools\\'",
  "array_merge( $sandbox_tool_ids, $ability_tool_ids )",
  "\\'ability_tools\\' => $ability_tool_diagnostics",
  "\\'allowed_tool_ids\\' => $allowed_tool_ids",
]

const cliSnippets = [
  "const runtimeTask = normalizeRuntimeTask(options.runtimeTask, input, agentBundles)",
  "nestedValue(spec, [\"metadata\", \"codebox\", \"agent_runtime\", \"bundle\", \"ability_tools\"])",
  "input.ability_tools = abilityTools",
  "nestedTaskInput.ability_tools = abilityTools",
  "function wp_codebox_runtime_ability_tools_from_input",
  "add_filter('datamachine_ability_tools'",
  "$sandbox_stack['ability_tools'] = wp_codebox_runtime_ability_tool_diagnostics($runtime_ability_tools)",
]

for (const snippet of browserSnippets) {
  if (!browserSource.includes(snippet)) {
    throw new Error(`Missing browser ability_tools runtime bridge snippet: ${snippet}`)
  }
}

for (const snippet of cliSnippets) {
  if (!cliSource.includes(snippet)) {
    throw new Error(`Missing CLI ability_tools runtime bridge snippet: ${snippet}`)
  }
}

const preludeStart = browserSource.indexOf("function wp_codebox_browser_runtime_ability_tool_declarations")
const preludeEnd = browserSource.indexOf("function wp_codebox_browser_runtime_replay_ability_lifecycle")
if (preludeStart === -1 || preludeEnd === -1 || preludeEnd <= preludeStart) {
  throw new Error("Unable to isolate generated ability_tools bridge prelude")
}

const prelude = browserSource.slice(preludeStart, preludeEnd)
if (prelude.includes("if ( ''") || prelude.includes("=> '") || prelude.includes("['")) {
  throw new Error("Generated PHP bridge prelude contains unescaped single-quoted literals")
}

console.log("agent-runtime-ability-tools-smoke: ok")
