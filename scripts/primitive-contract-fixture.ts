import { writeFile } from "node:fs/promises"

import {
  componentManifestForRuntimePlugins,
  countRunPlanChildResults,
  normalizeRunPlanConcurrency,
  normalizeRuntimeMountTarget,
  redactJsonValue,
  resolveEffectiveRuntimeToolPolicy,
  resolveRuntimeToolAlias,
  runPlanSucceeded,
  runtimeDependencyPlanContract,
  RUN_PLAN_EVENT_SCHEMA,
  RUN_PLAN_RESULT_SCHEMA,
  RUN_PLAN_SCHEMA,
  safeArtifactRelativePath,
  type SandboxToolPolicySnapshot,
  type WorkspaceRecipeExtraPlugin,
} from "../packages/runtime-core/src/index.js"

type PathContract = { input: string; expected?: string; error?: boolean }

const redactionProfiles = {
  provider_proxy: {
    input: {
      provider: "generic",
      request: {
        authorization: "Bearer abc",
        model: "example",
        messages: [{ role: "user", content: "visible" }],
      },
    },
  },
}

const mountTargetCases: PathContract[] = [
  { input: "//wordpress//wp-content/plugins/plugin" },
  { input: " \\wordpress\\wp-content\\mu-plugins\\runtime " },
  { input: "/" },
  { input: "/wordpress/../escape", error: true },
  { input: "relative/runtime", error: true },
]

const artifactPathCases: PathContract[] = [
  { input: "/files//output.json" },
  { input: " logs\\run.json " },
  { input: "files/../secret.txt", error: true },
  { input: "C:/secret.txt", error: true },
]

const toolPolicySnapshot: SandboxToolPolicySnapshot = {
  schema: "wp-codebox/sandbox-tool-policy/v1",
  version: 1,
  tools: [
    {
      id: "filesystem-write",
      runtime_tool_id: "client/filesystem-write",
      aliases: ["filesystem_write"],
      execution_location: "sandbox",
      transport_visibility: "sandbox",
      allowed: true,
      runtime: { environment: "runtime_local", capability_scope: "runtime_local" },
      metadata: { schema: "example/input/v1", aliases: ["write_file"], policy: { permission: "write" } },
    },
    {
      id: "browser-review",
      runtime_tool_id: "client/browser-review",
      execution_location: "parent",
      transport_visibility: "parent",
      allowed: true,
      runtime: { environment: "control_plane", capability_scope: "control_plane" },
    },
    {
      id: "internal-token",
      runtime_tool_id: "client/internal-token",
      execution_location: "sandbox",
      transport_visibility: "hidden",
      allowed: true,
      runtime: { environment: "runtime_local", capability_scope: "runtime_local" },
    },
  ],
  metadata: { source: "primitive-contracts" },
}

const statusTaxonomy = [
  { input: { status: "succeeded" }, command: "completed", phase: "succeeded", agentTask: "succeeded", check: "passed" },
  { input: { status: "timed_out" }, command: "timed_out", phase: "failed", agentTask: "timeout", check: "failed" },
  { input: { status: "blocked" }, command: "failed", phase: "blocked", agentTask: "unable_to_remediate", check: "warning" },
]

const runtimeDependencyPlanInput = {
  selection: { agent: "wp-codebox-sandbox", mode: "sandbox", provider: "openai", model: "gpt-test", empty: "" },
  provider_plugin_paths: ["/runtime/providers/openai", "/runtime/providers/openai", ""],
  provider_plugins: [{ source: "/runtime/providers/openai", slug: "ai-provider-for-openai", activate: false }],
  component_plugins: [
    {
      source: "/workspace/plugin",
      slug: "demo-plugin",
      pluginFile: "demo-plugin/demo.php",
      loadAs: "plugin",
      activate: true,
      metadata: { componentContract: { index: 2, requestedPath: "/workspace/plugin" } },
    },
  ],
  runtime_overlays: [{ kind: "composer-package", source: "/runtime/overlays/pkg" }],
  inheritance_request: { connectors: ["openai", "openai", ""], settings: ["model"] },
  inheritance: { connectors: [{ id: "openai", status: "available" }], settings: [{ name: "model", status: "resolved" }] },
  agent_bundles: [{ source: "/workspace/agent-bundle" }],
  secret_env: ["OPENAI_API_KEY", "bad-name", "OPENAI_API_KEY"],
  runtime_env: { WP_ENVIRONMENT_TYPE: "local", badName: "ignored", WP_DEBUG: true },
}

const componentManifestComponents: WorkspaceRecipeExtraPlugin[] = [
  {
    source: "/workspace/plugin",
    slug: "demo-plugin",
    pluginFile: "demo-plugin/demo.php",
    loadAs: "plugin",
    activate: true,
    metadata: { componentContract: { index: 2, requestedPath: "/workspace/plugin" }, sourceKind: "local" },
  },
  { source: "/workspace/mu", slug: "demo-mu", pluginFile: "demo-mu/demo-mu.php", loadAs: "mu-plugin", activate: false },
]

const componentManifestProviders: WorkspaceRecipeExtraPlugin[] = [
  { source: "/runtime/providers/openai", slug: "ai-provider-for-openai", pluginFile: "ai-provider-for-openai/provider.php", loadAs: "plugin", activate: false },
]

const runPlanChildren = [
  { success: true, status: "succeeded" },
  { success: false, status: "failed" },
  { success: false, status: "cancelled" },
]

export function primitiveContractsFixture(): Record<string, unknown> {
  const effectiveToolPolicy = resolveEffectiveRuntimeToolPolicy(toolPolicySnapshot)
  const runPlanCounts = countRunPlanChildResults(runPlanChildren)

  return {
    generatedBy: "scripts/primitive-contract-fixture.ts",
    redaction: {
      profiles: Object.fromEntries(Object.entries(redactionProfiles).map(([profile, contract]) => [
        profile,
        { ...contract, expected: redactJsonValue(contract.input, { profile: profile as never, redactStrings: false }) },
      ])),
    },
    pathPolicy: {
      mountTargets: mountTargetCases.map((contract) => contract.error ? contract : { ...contract, expected: normalizeRuntimeMountTarget(contract.input) }),
      artifactPaths: artifactPathCases.map((contract) => contract.error ? contract : { ...contract, expected: safeArtifactRelativePath(contract.input) }),
    },
    toolPolicy: {
      snapshot: toolPolicySnapshot,
      effective: {
        schema: effectiveToolPolicy.schema,
        version: effectiveToolPolicy.version,
        allowedRuntimeToolIds: effectiveToolPolicy.allowedRuntimeToolIds,
        visibleRuntimeToolIds: effectiveToolPolicy.visibleRuntimeToolIds,
        parentOnlyRuntimeToolIds: effectiveToolPolicy.parentOnlyRuntimeToolIds,
        hiddenRuntimeToolIds: effectiveToolPolicy.hiddenRuntimeToolIds,
        metadata: effectiveToolPolicy.metadata,
      },
      aliases: Object.fromEntries(["filesystem_write", "write_file", "client/browser-review"].map((alias) => [alias, resolveRuntimeToolAlias(effectiveToolPolicy, alias)?.runtimeToolId])),
    },
    statusTaxonomy,
    jsonCodec: {
      prettyValue: { path: "files/result.json" },
      prettyExpected: '{\n    "path": "files/result.json"\n}',
      object: '{"ok":true}',
      list: '["a","b"]',
      trailing: 'warning\n{"status":"ok"}',
      fragment: 'prefix {"result":{"ok":true}} suffix',
      expected: { object: { ok: true }, list: ["a", "b"], trailing: { status: "ok" }, fragment: { result: { ok: true } } },
    },
    runtimeDependencyPlan: {
      input: runtimeDependencyPlanInput,
      expected: runtimeDependencyPlanContract(runtimeDependencyPlanInput),
    },
    componentManifest: {
      components: componentManifestComponents,
      providers: componentManifestProviders,
      expected: componentManifestForRuntimePlugins(componentManifestComponents, componentManifestProviders),
    },
    runPlan: {
      children: runPlanChildren,
      counts: runPlanCounts,
      succeeded: runPlanSucceeded(runPlanCounts),
      concurrency: {
        defaulted: normalizeRunPlanConcurrency("", { defaultConcurrency: 3, maxConcurrency: 5 }),
        clamped: normalizeRunPlanConcurrency(99, { maxConcurrency: 2 }),
      },
      schemas: { plan: RUN_PLAN_SCHEMA, event: RUN_PLAN_EVENT_SCHEMA, result: RUN_PLAN_RESULT_SCHEMA },
    },
  }
}

if (process.argv.includes("--write")) {
  await writeFile(new URL("../tests/fixtures/primitive-contracts.json", import.meta.url), `${JSON.stringify(primitiveContractsFixture(), null, 2)}\n`)
}
