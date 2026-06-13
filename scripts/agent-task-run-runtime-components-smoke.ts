import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { artifactManifestFile, normalizeTaskInput, type ArtifactBundle } from "@automattic/wp-codebox-core"
import { buildAgentTaskRecipe, runAgentTask } from "../packages/cli/src/commands/agent-task-run.js"
import { agentSandboxRunCode, resolveSandboxTaskCode } from "../packages/cli/src/agent-code.js"
import { installMuPluginsCode } from "../packages/cli/src/recipe-sources.js"
import { buildAgentTaskSingleResult, finalizeAgentSandboxEvidence } from "../packages/cli/src/recipe-evidence.js"

const input = {
  goal: "Run a caller runtime bundle",
  provider: "openai",
  model: "gpt-5.5",
  component_contracts: [
    { slug: "agents-api", path: "/components/agents-api", loadAs: "mu-plugin" },
    { slug: "caller-runtime", path: "/components/caller-runtime", loadAs: "mu-plugin" },
    { slug: "caller-runtime-tools", path: "/components/caller-runtime-tools", loadAs: "mu-plugin" },
  ],
  dependency_overlays: [{ kind: "composer-package", package: "acme/dependency", source: "/components/dependency", consumer: "caller-runtime" }],
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
assert.equal(extraPlugins.find((plugin) => plugin?.slug === "ai-provider-for-openai")?.activate, true)
assert.equal(recipe.inputs?.dependency_overlays?.[0]?.consumer, "caller-runtime")
assert.equal(recipe.inputs?.dependency_overlays?.[0]?.package, "acme/dependency")

const muPluginInstallCode = installMuPluginsCode(extraPlugins)
assert.ok(muPluginInstallCode?.includes("define( 'DATAMACHINE_WORKSPACE_PATH', '/workspace' );"))
assert.ok(!muPluginInstallCode?.includes('define( \'DATAMACHINE_WORKSPACE_PATH\', "/workspace" );'))

const agentTaskRunSource = readFileSync(new URL("../packages/cli/src/commands/agent-task-run.ts", import.meta.url), "utf8")
const agentCodeSource = readFileSync(new URL("../packages/cli/src/agent-code.ts", import.meta.url), "utf8")
const recipeEvidenceSource = readFileSync(new URL("../packages/cli/src/recipe-evidence.ts", import.meta.url), "utf8")
const sandboxCode = agentSandboxRunCode("Run a bundle", "echo json_encode(array('ok' => true));", [])
assert.ok(
  agentTaskRunSource.includes("diagnostics(run, success ? 0 : capture.exitCode, success, failureEvidence)"),
  "successful normalized agent-bundle workloads should not keep stale recipe-run failure diagnostics",
)
assert.ok(
  agentTaskRunSource.includes('stringValue(entry.class) !== "wp-codebox.agent_task_run_failed"'),
  "successful normalized agent-bundle workloads should filter stale agent-task failure diagnostics",
)
assert.ok(
  agentTaskRunSource.includes('runtime: { environment: "control_plane", capability_scope: "control_plane" }'),
  "default deny-all sandbox policy should satisfy required runtime metadata",
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

const failingOutput = await runAgentTask({
  goal: "Fail before runtime startup so callers still receive evidence",
  runtime_overlay_profiles: ["unknown-profile"],
  sandbox_session_id: "sandbox-failure-smoke",
  orchestrator: { agent_task_id: "agent-task-failure-smoke" },
  artifacts_path: mkdtempSync(join(tmpdir(), "wp-codebox-agent-task-failure-smoke-")),
}, { inputPath: "", json: true, previewHoldSeconds: "", previewPublicUrl: "" })
const failureEvidence = failingOutput.failure_evidence as Record<string, unknown>
assert.equal(failingOutput.success, false, "failing agent-task-run should return a failed JSON payload")
assert.equal(failingOutput.status, "failed", "failing agent-task-run status should be failed")
assert.equal(failureEvidence?.schema, "wp-codebox/agent-task-run-failure-evidence/v1", "failure evidence schema should be stable")
assert.equal(failureEvidence?.phase, "agent-task-run", "pre-runtime failures should still include a phase")
assert.equal(failureEvidence?.command, "wp-codebox recipe-run --json", "pre-runtime failures should still include a command")
assert.equal((failureEvidence?.sandbox as Record<string, unknown>)?.sandbox_session_id, "sandbox-failure-smoke", "failure evidence should include sandbox identifiers")
assert.equal(Array.isArray(failingOutput.diagnostics) && failingOutput.diagnostics.length > 0, true, "failure diagnostics should be emitted")
assert.equal(failingOutput.evidence_refs.some((ref) => ref.kind === "codebox-agent-task-failure-evidence"), true, "failure evidence ref should be emitted")

const semanticFailureOutput = await promiseMustSettle(runAgentTask({
  goal: "Fail recipe validation and still settle",
  dependency_overlays: [{ kind: "composer-package", package: "acme/missing", source: "/components/missing", consumer: "missing-consumer" }],
  sandbox_session_id: "sandbox-semantic-failure-smoke",
  artifacts_path: mkdtempSync(join(tmpdir(), "wp-codebox-agent-task-semantic-failure-smoke-")),
}, { inputPath: "", json: true, previewHoldSeconds: "", previewPublicUrl: "" }), 2_000)
assert.equal(semanticFailureOutput.success, false, "recipe validation failures should return a failed agent-task payload")
assert.equal(semanticFailureOutput.status, "failed", "recipe validation failures should report failed status")
assert.equal(semanticFailureOutput.failure_evidence?.schema, "wp-codebox/agent-task-run-failure-evidence/v1", "recipe validation failures should include failure evidence")
assert.equal(semanticFailureOutput.diagnostics.some((diagnostic) => diagnostic.class === "wp-codebox.agent_task_run_failed"), true, "recipe validation failures should include agent-task diagnostics")

const structuredInput = {
  goal: "Transform a concept packet into a design packet",
  provider: "openai",
  model: "gpt-5.5",
  artifacts_path: "/tmp/wp-codebox-artifacts",
  structured_artifacts: [
    {
      name: "ConceptPacket",
      type: "ssi.concept_packet",
      payload_schema: "https://schemas.example.test/concept-packet.json",
      payload: { site: "Evergreen Bakery" },
    },
  ],
}
const structuredTaskInput = normalizeTaskInput(structuredInput)
assert.equal(structuredTaskInput.structured_artifacts.length, 1, "structured input artifacts should normalize onto the task contract")
assert.equal(structuredTaskInput.structured_artifacts[0]?.provenance.direction, "input")
const structuredRecipe = buildAgentTaskRecipe(structuredInput, structuredTaskInput, "trunk")
const structuredArg = structuredRecipe.workflow.steps[0]?.args?.find((arg) => arg.startsWith("structured-artifacts-json="))
assert.ok(structuredArg, "agent-task recipe should pass structured artifacts to the sandbox step")
const structuredArgPayload = JSON.parse(structuredArg!.slice("structured-artifacts-json=".length))
assert.equal(structuredArgPayload[0]?.name, "ConceptPacket")
assert.equal(structuredArgPayload[0]?.payload?.site, "Evergreen Bakery")
const structuredTaskCode = await resolveSandboxTaskCode({
  task: structuredInput.goal,
  agent: "wp-codebox-sandbox",
  sandboxToolPolicy: {
    schema: "wp-codebox/sandbox-tool-policy/v1",
    version: 1,
    tools: [],
    metadata: { source: "structured-artifact-smoke" },
  },
  structuredArtifacts: structuredTaskInput.structured_artifacts,
})
assert.ok(structuredTaskCode.includes("structured_artifacts"), "sandbox agent input should include structured artifact context")
assert.ok(structuredTaskCode.includes("ConceptPacket"), "sandbox agent input should preserve structured artifact names")
const providerRegistryClassReference = String.raw`\WordPress\AiClient\Providers\ProviderRegistry::class`
assert.ok(
  structuredTaskCode.includes(providerRegistryClassReference),
  "generated sandbox PHP should preserve ProviderRegistry namespace separators",
)
assert.ok(
  !structuredTaskCode.includes("WordPressAiClientProvidersProviderRegistry"),
  "generated sandbox PHP should not flatten ProviderRegistry into an invalid class name",
)

const outputTaskResult = buildAgentTaskSingleResult({
  schema: "wp-codebox/agent-transcript/v1",
  executions: [
    {
      executionIndex: 0,
      command: "wordpress.run-php",
      exitCode: 0,
      recipeCommand: "wp-codebox.agent-sandbox-run",
      stdout: JSON.stringify({
        agent_runtime: {
          success: true,
          result: {
            outputs: {
              structured_artifacts: [
                {
                  name: "DesignPacket",
                  type: "ssi.design_packet",
                  payload_schema: "https://schemas.example.test/design-packet.json",
                  payload: { theme: "warm editorial" },
                },
              ],
            },
          },
        },
      }),
      stderr: "",
      parsed: {
        agent_runtime: {
          success: true,
          result: {
            outputs: {
              structured_artifacts: [
                {
                  name: "DesignPacket",
                  type: "ssi.design_packet",
                  payload_schema: "https://schemas.example.test/design-packet.json",
                  payload: { theme: "warm editorial" },
                },
              ],
            },
          },
        },
      },
    },
  ],
})
assert.equal(outputTaskResult?.outputs.structured_artifacts?.[0]?.name, "DesignPacket", "agent task result should preserve structured output candidates")

const artifactRoot = mkdtempSync(join(tmpdir(), "wp-codebox-structured-artifact-smoke-"))
const filesRoot = join(artifactRoot, "files")
mkdirSync(filesRoot, { recursive: true })
const fakeArtifacts: ArtifactBundle = {
  id: "artifact-bundle-smoke",
  directory: artifactRoot,
  manifestPath: join(artifactRoot, "manifest.json"),
  metadataPath: join(artifactRoot, "metadata.json"),
  blueprintAfterPath: join(artifactRoot, "blueprint.after.json"),
  blueprintAfterNotesPath: join(artifactRoot, "blueprint.after-notes.json"),
  eventsPath: join(artifactRoot, "events.jsonl"),
  commandsPath: join(artifactRoot, "commands.jsonl"),
  observationsPath: join(artifactRoot, "observations.jsonl"),
  runtimeLogPath: join(artifactRoot, "logs/runtime.log"),
  commandsLogPath: join(artifactRoot, "logs/commands.log"),
  mountsPath: join(filesRoot, "mounts.json"),
  capturedMountsPath: join(filesRoot, "mounted-files.json"),
  diffsPath: join(filesRoot, "diffs.json"),
  workspacePatchPath: join(filesRoot, "workspace-patch.json"),
  changedFilesPath: join(filesRoot, "changed-files.json"),
  patchPath: join(filesRoot, "patch.diff"),
  diagnosticsPath: join(filesRoot, "diagnostics.json"),
  testResultsPath: join(filesRoot, "test-results.json"),
  reviewPath: join(filesRoot, "review.json"),
  contentDigest: "0".repeat(64),
  createdAt: "2026-06-10T00:00:00.000Z",
}
writeFileSync(fakeArtifacts.metadataPath, JSON.stringify({ artifacts: {}, evidence: {} }, null, 2))
writeFileSync(fakeArtifacts.reviewPath, JSON.stringify({ evidence: {} }, null, 2))
writeFileSync(fakeArtifacts.changedFilesPath, JSON.stringify({ schema: "wp-codebox/changed-files/v1", files: [] }, null, 2))
writeFileSync(fakeArtifacts.patchPath, "")
writeFileSync(fakeArtifacts.manifestPath, JSON.stringify({
  id: fakeArtifacts.id,
  contentDigest: { algorithm: "sha256", inputs: [], value: fakeArtifacts.contentDigest },
  createdAt: fakeArtifacts.createdAt,
  runtime: { id: "runtime-smoke", backend: "wordpress-playground", status: "stopped" },
  files: [
    artifactManifestFile("manifest.json", "manifest", "application/json"),
    artifactManifestFile("metadata.json", "metadata", "application/json"),
    artifactManifestFile("files/review.json", "review", "application/json"),
    artifactManifestFile("files/changed-files.json", "changed-files", "application/json"),
    artifactManifestFile("files/patch.diff", "patch", "text/x-diff"),
  ],
}, null, 2))
const finalized = await finalizeAgentSandboxEvidence(fakeArtifacts, [
  {
    command: "wordpress.run-php",
    exitCode: 0,
    stdout: JSON.stringify({
      agent_runtime: {
        success: true,
        result: {
          outputs: {
            structured_artifacts: [
              {
                name: "DesignPacket",
                type: "ssi.design_packet",
                payload: { theme: "warm editorial" },
              },
            ],
          },
        },
      },
    }),
    stderr: "",
    recipeCommand: "wp-codebox.agent-sandbox-run",
  },
])
assert.equal(finalized.agentTaskResult?.structured_artifacts[0]?.artifact?.path, "files/structured-artifacts/designpacket-1.json")
const structuredIndex = JSON.parse(readFileSync(join(filesRoot, "structured-artifacts/index.json"), "utf8"))
assert.equal(structuredIndex.schema, "wp-codebox/structured-artifacts-index/v1")
assert.equal(structuredIndex.artifacts[0]?.payload?.theme, "warm editorial")

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
assert.equal(codexProviderPlugin?.activate, true, "codex profile provider plugin must activate before provider preflight")
assert.equal(codexOverlays[0]?.kind, "bundled-library")
assert.equal(codexOverlays[0]?.library, "php-ai-client")
assert.equal(codexOverlays[0]?.source, phpAiClientPath)
assert.equal(codexOverlays[0]?.strategy, "wordpress-scoped-bundle")
assert.ok(agentCodeSource.includes("wp_codebox_validate_requested_provider"))
assert.ok(agentCodeSource.includes("WordPress\\\\AiClient\\\\Providers\\\\ProviderRegistry"))
assert.ok(agentCodeSource.includes("wp_codebox_provider_not_registered"))
assert.ok(!agentTaskRunSource.includes("CodexProvider"))

async function promiseMustSettle<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
