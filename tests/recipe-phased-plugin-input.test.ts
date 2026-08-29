import assert from "node:assert/strict"

import { validateWorkspaceRecipeJsonSchema, type ExecutionResult, type MountSpec, type Runtime, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { collectPhasedPluginArtifact, projectPhasedPluginPackages, RecipePhasedPluginInputError, resolvePhasedPluginPackages } from "../packages/cli/src/commands/recipe-phased-plugin-input.js"
import { RecipeRunPhaseExecutor } from "../packages/cli/src/commands/recipe-run-phase-executor.js"
import { applyPhasedRecipePlugins } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import type { PreparedExtraPlugin } from "../packages/cli/src/recipe-sources.js"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import { evaluateSourcePolicy } from "../packages/cli/src/source-policy.js"

const payload = {
  schema: "example/provider-plan/v1",
  dependencies: [{ package: { url: "https://downloads.wordpress.org/plugin/example.1.2.3.zip", digest: "a".repeat(64) }, slug: "example", entrypoint: "example/example.php", required: true }],
}
const immutableProjection = {
  resolver: "immutable-archive" as const,
  items: "/dependencies",
  map: { source: "/package/url", sha256: "/package/digest", slug: "/slug", pluginFile: "/entrypoint", activate: "/required" },
}

assert.deepEqual(projectPhasedPluginPackages(payload, immutableProjection), [{
  source: "https://downloads.wordpress.org/plugin/example.1.2.3.zip",
  sha256: "a".repeat(64),
  slug: "example",
  pluginFile: "example/example.php",
  activate: true,
  loadAs: "plugin",
}])
assert.deepEqual(projectPhasedPluginPackages({ dependencies: [] }, immutableProjection), [])
assert.throws(() => projectPhasedPluginPackages({ dependencies: [{ ...payload.dependencies[0], package: { ...payload.dependencies[0].package, url: "/tmp/host-plugin" } }] }, immutableProjection), RecipePhasedPluginInputError)
assert.throws(() => projectPhasedPluginPackages({ dependencies: [payload.dependencies[0], payload.dependencies[0]] }, immutableProjection), /duplicates/)
assert.throws(() => projectPhasedPluginPackages({ dependencies: Array.from({ length: 21 }, (_, index) => ({ ...payload.dependencies[0], slug: `example-${index}`, entrypoint: `example-${index}/example.php` })) }, immutableProjection), /20-plugin bound/)

const registryProjection = { resolver: "wordpress.org-latest-stable" as const, items: "/entries", map: { slug: "/slug", pluginFile: "/plugin_file" } }
const registryDescriptors = projectPhasedPluginPackages({ entries: [{ slug: "woocommerce", plugin_file: "woocommerce/woocommerce.php" }] }, registryProjection)
const registryPlugins = await resolvePhasedPluginPackages(registryDescriptors, registryProjection, async () => new Response(JSON.stringify({ version: "10.1.2", download_link: "https://downloads.wordpress.org/plugin/woocommerce.10.1.2.zip" }), { headers: { "content-type": "application/json" } }))
assert.equal(registryPlugins[0]?.source, "https://downloads.wordpress.org/plugin/woocommerce.10.1.2.zip")
assert.deepEqual(registryPlugins[0]?.metadata, { phased_input: { resolver: "wordpress.org-latest-stable", version: "10.1.2", source_url: "https://downloads.wordpress.org/plugin/woocommerce.10.1.2.zip" } })
await assert.rejects(() => resolvePhasedPluginPackages(registryDescriptors, registryProjection, async () => new Response(JSON.stringify({ version: "10.1.2", download_link: "https://evil.example/plugin.zip" }), { headers: { "content-type": "application/json" } })), RecipePhasedPluginInputError)
assert.deepEqual(evaluateSourcePolicy({ type: "wporg_plugin_zip", host: "downloads.wordpress.org" }, undefined, { networkDownloadsAllowed: true }), [])

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [{ command: "wordpress.wp-cli", args: ["command=example discover"], pluginInput: { artifact: "provider-plugins", packages: immutableProjection } }],
  },
  artifacts: {
    typed: [{ name: "provider-plugins", type: "example/provider-plugins", path: "/wordpress/wp-content/uploads/provider-plugins.json", required: true, parseJson: true, contentType: "application/json", payloadSchema: "example/provider-plan/v1" }],
  },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)
assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, "/tmp/recipe.json"), [])
assert.ok((await validateWorkspaceRecipeSemantics({ ...recipe, artifacts: { typed: [] } }, "/tmp/recipe.json")).some((issue) => issue.code === "unknown-phased-plugin-artifact"))
assert.ok((await validateWorkspaceRecipeSemantics({ ...recipe, workflow: { steps: [{ ...recipe.workflow.steps[0], advisory: true }] } }, "/tmp/recipe.json")).some((issue) => issue.code === "optional-phased-plugin-step"))
assert.ok((await validateWorkspaceRecipeSemantics({ ...recipe, workflow: { steps: [{ ...recipe.workflow.steps[0], pluginInput: { artifact: "provider-plugins", packages: { ...immutableProjection, resolver: "wordpress.org-latest-stable" } } }] } }, "/tmp/recipe.json")).some((issue) => issue.code === "ambiguous-phased-plugin-projection"))

class ArtifactRuntime {
  async execute(): Promise<ExecutionResult> {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
    return { command: "wordpress.run-php", args: [], exitCode: 0, stdout: JSON.stringify({ exists: true, type: "file", size: encoded.length, sha256: "b".repeat(64), parsedJson: payload, contentBase64: encoded }), stderr: "" }
  }
}

const collected = await collectPhasedPluginArtifact(recipe, recipe.workflow.steps[0], new ArtifactRuntime() as unknown as Runtime)
assert.equal(collected.status, "collected")
assert.deepEqual(collected.parsedJson, payload)

class PluginRuntime {
  readonly mounts: MountSpec[] = []
  readonly materialized: MountSpec[][] = []
  async mount(spec: MountSpec): Promise<void> { this.mounts.push(spec) }
  async materializeStagedInputs(mounts: MountSpec[]): Promise<void> { this.materialized.push(mounts) }
  async execute(spec: { command: string; args?: string[] }): Promise<ExecutionResult> {
    const code = (spec.args ?? []).find((arg) => arg.startsWith("code=")) ?? ""
    return { command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: code.includes("get_option('active_plugins'") ? JSON.stringify(["example/example.php"]) : "{}", stderr: "" }
  }
}
const runtime = new PluginRuntime()
const phaseExecutor = new RecipeRunPhaseExecutor({ context: { startedAtMs: Date.now(), artifactPointer: { update: async () => undefined } } as never, timeoutMs: 10_000, destroyActiveRuntime: async () => undefined })
const preparedPlugin: PreparedExtraPlugin = { source: "/tmp/example", slug: "example", target: "/wordpress/wp-content/plugins/example", pluginFile: "example/example.php", activate: true, loadAs: "plugin", cleanupPaths: [], provenance: { kind: "local", original: "/tmp/example" }, metadata: {} }
const setupExecutions = await applyPhasedRecipePlugins({ plugins: [preparedPlugin], runtime: runtime as unknown as Runtime, phaseExecutor, recipePhase: "steps", recipeStepIndex: 0 })
assert.equal(runtime.mounts[0]?.target, "/wordpress/wp-content/plugins/example")
assert.equal(runtime.materialized.length, 1)
assert.deepEqual(phaseExecutor.tracker.list().map((phase) => phase.name), ["mount_phased_plugins", "activate_phased_plugins", "phased_plugin_readiness"])
assert.ok(setupExecutions.some((execution) => execution.recipeCommand === "extra-plugin.activate:example/example.php"))
assert.ok(setupExecutions.some((execution) => execution.recipeCommand === "phased-plugin.readiness:example/example.php"))

console.log("recipe phased plugin input contract ok")
