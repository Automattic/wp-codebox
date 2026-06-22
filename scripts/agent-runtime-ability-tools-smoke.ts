import { readFileSync } from "node:fs"

const source = [
  "packages/wordpress-plugin/src/class-wp-codebox-browser-runner-template.php",
  "packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-runner.php",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n")

const requiredSnippets = [
  "function wp_codebox_browser_runtime_ability_tool_declarations",
  "function wp_codebox_browser_runtime_resolve_ability_tools",
  "WP_Codebox_Agents_API_Adapter::legacy_resolved_tools_filter()",
  "apply_filters( \\'wp_codebox_browser_runtime_ability_tools\\'",
  "$task_input[\\'ability_tools\\']",
  "array_merge( $sandbox_tool_ids, $ability_tool_ids )",
  "'ability_tools' => \\$ability_tool_diagnostics",
  "'allowed_tool_ids' => \\$allowed_tool_ids",
]

for (const snippet of requiredSnippets) {
  if (!source.includes(snippet)) {
    throw new Error(`Missing ability_tools runtime bridge snippet: ${snippet}`)
  }
}

if (source.includes("datamachine_ability_tools")) {
  throw new Error("Browser runner must not hard-code Data Machine runtime tool hooks")
}

const preludeStart = source.indexOf("function wp_codebox_browser_runtime_ability_tool_declarations")
const preludeEnd = source.indexOf("function wp_codebox_browser_runtime_replay_ability_lifecycle")
if (preludeStart === -1 || preludeEnd === -1 || preludeEnd <= preludeStart) {
  throw new Error("Unable to isolate generated ability_tools bridge prelude")
}

const prelude = source.slice(preludeStart, preludeEnd)
if (prelude.includes("if ( ''") || prelude.includes("=> '") || prelude.includes("['")) {
  throw new Error("Generated PHP bridge prelude contains unescaped single-quoted literals")
}

console.log("agent-runtime-ability-tools-smoke: ok")
