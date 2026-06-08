import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { normalizeTaskInput } from "@automattic/wp-codebox-core"
import { buildAgentTaskRecipe } from "../packages/cli/src/commands/agent-task-run.js"
import { agentSandboxRunCode } from "../packages/cli/src/agent-code.js"
import { installMuPluginsCode } from "../packages/cli/src/recipe-sources.js"

const input = {
  goal: "Run a caller runtime bundle",
  provider: "openai",
  model: "gpt-5.5",
  component_contracts: [
    { slug: "agents-api", path: "/components/agents-api", loadAs: "mu-plugin" },
    { slug: "caller-runtime", path: "/components/caller-runtime", loadAs: "mu-plugin" },
    { slug: "caller-runtime-tools", path: "/components/caller-runtime-tools", loadAs: "mu-plugin" },
  ],
  provider_plugin_paths: ["/components/ai-provider-for-openai"],
  artifacts_path: "/tmp/wp-codebox-artifacts",
}

const recipe = buildAgentTaskRecipe(input, normalizeTaskInput(input), "trunk")
const extraPlugins = recipe.inputs?.extra_plugins ?? []

assert.equal(extraPlugins.find((plugin) => plugin?.slug === "agents-api")?.source, "/components/agents-api")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "caller-runtime")?.source, "/components/caller-runtime")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "caller-runtime-tools")?.source, "/components/caller-runtime-tools")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "ai-provider-for-openai")?.source, "/components/ai-provider-for-openai")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "agents-api")?.loadAs, "mu-plugin")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "caller-runtime")?.loadAs, "mu-plugin")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "caller-runtime-tools")?.loadAs, "mu-plugin")
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "ai-provider-for-openai")?.loadAs, undefined)
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "agents-api")?.activate, false)
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "caller-runtime")?.activate, false)
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "caller-runtime-tools")?.activate, false)

const muPluginInstallCode = installMuPluginsCode(extraPlugins)
assert.ok(muPluginInstallCode?.includes("define( 'DATAMACHINE_WORKSPACE_PATH', '/workspace' );"))
assert.ok(!muPluginInstallCode?.includes('define( \'DATAMACHINE_WORKSPACE_PATH\', "/workspace" );'))

const agentTaskRunSource = readFileSync(new URL("../packages/cli/src/commands/agent-task-run.ts", import.meta.url), "utf8")
const agentCodeSource = readFileSync(new URL("../packages/cli/src/agent-code.ts", import.meta.url), "utf8")
const recipeEvidenceSource = readFileSync(new URL("../packages/cli/src/recipe-evidence.ts", import.meta.url), "utf8")
const sandboxCode = agentSandboxRunCode("Run a bundle", "echo json_encode(array('ok' => true));", [])
assert.ok(
  agentTaskRunSource.includes("diagnostics(run, success ? 0 : capture.exitCode, success)"),
  "successful normalized agent-bundle workloads should not keep stale recipe-run failure diagnostics",
)
assert.ok(
  agentTaskRunSource.includes('stringValue(entry.class) !== "wp-codebox.agent_task_run_failed"'),
  "successful normalized agent-bundle workloads should filter stale agent-task failure diagnostics",
)
assert.ok(
  recipeEvidenceSource.includes("reconcileAgentSandboxResult("),
  "successful agent task results should reconcile stale failed sandbox summaries",
)
assert.ok(
  recipeEvidenceSource.includes('agentTaskResult?.success !== true || agentResult.status !== "failed"'),
  "only successful agent task results should override failed sandbox evidence",
)
assert.ok(
  sandboxCode.includes("JSON_INVALID_UTF8_SUBSTITUTE"),
  "sandbox runtime payload encoding should preserve results with invalid UTF-8 instead of returning an empty output",
)
assert.ok(
  sandboxCode.includes("runtime_payload_json_encode_failed"),
  "sandbox runtime payload encoding failures should surface as structured diagnostics",
)
assert.ok(
  agentCodeSource.includes("wp_codebox_json_encode_agent_runtime_payload"),
  "nested agent runtime payloads should use their own encoder helper",
)
assert.ok(
  agentCodeSource.includes("wp_codebox_json_encode_sandbox_payload"),
  "outer sandbox payloads should use a distinct encoder helper",
)

// Verify steps are emitted into workflow.after so a post-agent test gate runs
// after the agent finishes editing.
const verifyInput = {
  goal: "Fix a bug and prove it with the smoke suite",
  provider: "openai",
  model: "gpt-5.5",
  artifacts_path: "/tmp/wp-codebox-artifacts",
  verify_steps: [
    { command: "wordpress.phpunit", args: ["plugin-slug=data-machine"] },
  ],
}
const verifyRecipe = buildAgentTaskRecipe(verifyInput, normalizeTaskInput(verifyInput), "trunk")
assert.equal(verifyRecipe.workflow.steps[0]?.command, "wp-codebox.agent-sandbox-run", "agent run remains the primary workflow step")
assert.equal(verifyRecipe.workflow.after?.length, 1, "verify_steps should be emitted as workflow.after")
assert.equal(verifyRecipe.workflow.after?.[0]?.command, "wordpress.phpunit", "after step should be the supplied verify command")

// Without verify_steps, no after phase is emitted (back-compat with current runs).
const noVerifyRecipe = buildAgentTaskRecipe(input, normalizeTaskInput(input), "trunk")
assert.equal(noVerifyRecipe.workflow.after, undefined, "no verify_steps should leave workflow.after unset")

const profileRoot = mkdtempSync(join(tmpdir(), "wp-codebox-agent-task-profile-"))
const codexProviderPath = join(profileRoot, "ai-provider-for-openai@codex-oauth-provider")
const phpAiClientPath = join(profileRoot, "php-ai-client@custom-provider-auth")
mkdirSync(codexProviderPath, { recursive: true })
mkdirSync(join(phpAiClientPath, "vendor"), { recursive: true })
writeFileSync(join(codexProviderPath, "composer.json"), "{}\n")
writeFileSync(join(phpAiClientPath, "composer.json"), "{}\n")
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
const codexPlugins = codexProfileRecipe.inputs?.extra_plugins ?? []
const codexOverlays = codexProfileRecipe.runtime?.overlays ?? []

const codexProviderPlugin = codexPlugins.find((plugin) => plugin?.slug === "ai-provider-for-openai-codex-oauth-provider")
assert.equal(codexProviderPlugin?.source, "/tmp/wp-codebox-artifacts/prepared-plugins/ai-provider-for-openai-codex-oauth-provider")
assert.equal(codexOverlays[0]?.kind, "bundled-library")
assert.equal(codexOverlays[0]?.library, "php-ai-client")
assert.equal(codexOverlays[0]?.source, phpAiClientPath)
assert.equal(codexOverlays[0]?.strategy, "wordpress-scoped-bundle")
