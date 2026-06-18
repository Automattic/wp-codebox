import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runRecipeBuildCommand } from "../packages/cli/src/commands/recipe-build.js"
import { buildGenericAbilityRuntimeRunRecipe, GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA } from "../packages/runtime-core/src/index.js"
import { buildGenericAbilityRuntimeRunRecipe as buildGenericAbilityRuntimeRunRecipeFromStableSubpath } from "../packages/runtime-core/src/recipe-builders.js"
import { abilityResponseToCommandEnvelope, expectedAbilityResultSchemaFromArgs } from "../packages/runtime-playground/src/commands.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-generic-ability-runtime-run-", async (root) => {
  const component = join(root, "example-component")
  const provider = join(root, "example-provider")
  await mkdir(component)
  await mkdir(provider)
  await writeFile(join(component, "example-component.php"), "<?php\n/* Plugin Name: Example Component */\n")
  await writeFile(join(provider, "provider.php"), "<?php\n/* Plugin Name: Example Provider */\n")

  const recipe = buildGenericAbilityRuntimeRunRecipe({
    abilityId: "example/runtime-run",
    expectedResultSchema: "example/result/v1",
    components: [{ source: component, activate: true }],
    providerPlugins: [{ source: provider, slug: "example-provider" }],
    runtimeOverlays: [{ kind: "wordpress-plugin", library: "example-runtime", source: provider, strategy: "copy" }],
    runtimeEnv: { EXAMPLE_FLAG: true, ignored: "nope" },
    secretEnv: ["EXAMPLE_TOKEN"],
    toolPolicy: {
      schema: "wp-codebox/sandbox-tool-policy/v1",
      version: 1,
      tools: [{ id: "local", runtime_tool_id: "local", aliases: ["local-alias"], execution_location: "sandbox", transport_visibility: "sandbox", allowed: true, runtime: { environment: "runtime_local", capability_scope: "runtime_local" } }],
      metadata: { source: "test" },
    },
  })

  assert.equal(recipe.workflow.steps[0].command, "wordpress.ability")
  assert.ok(recipe.workflow.steps[0].args?.includes("name=example/runtime-run"))
  assert.ok(recipe.workflow.steps[0].args?.includes("expected-result-schema=\"example/result/v1\""))
  assert.equal(recipe.inputs?.extra_plugins?.length, 2)
  assert.equal(recipe.inputs?.component_manifest?.components.length, 1)
  assert.equal(recipe.inputs?.component_manifest?.providers.length, 1)
  assert.deepEqual(recipe.inputs?.runtimeEnv, { EXAMPLE_FLAG: "1" })
  assert.deepEqual(recipe.inputs?.secretEnv, ["EXAMPLE_TOKEN"])
  assert.equal(recipe.runtime?.overlays?.[0]?.library, "example-runtime")

  const inputArg = recipe.workflow.steps[0].args?.find((arg) => arg.startsWith("input="))
  assert.ok(inputArg)
  const input = JSON.parse(inputArg.slice("input=".length))
  assert.equal(input.runtime_invocation.schema, GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA)
  assert.equal(input.runtime_invocation.ability_id, "example/runtime-run")
  assert.equal(input.runtime_invocation.expected_result_schema, "example/result/v1")
  assert.equal(input.runtime_invocation.provider_runtime_contract.schema, PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA)
  assert.equal(input.runtime_invocation.provider_runtime_contract.tasks.workspaceCapture, "wp-codebox.runner-workspace.capture")
  assert.equal(input.runtime_invocation.provider_runtime_contract.tasks.workspaceCommand, "wp-codebox.runner-workspace.command")
  assert.equal(input.runtime_invocation.provider_runtime_contract.tasks.workspacePublish, "wp-codebox.runner-workspace.publish")
  assert.equal(input.runtime_invocation.provider_runtime_contract.tasks.toolCallTranscriptRecord, "wp-codebox.tool-call-transcript.record")
  assert.equal(input.runtime_invocation.provider_runtime_contract.tasks.artifactHandoff, "wp-codebox.artifact-handoff")
  assert.equal(input.runtime_invocation.provider_runtime_contract.result_schemas.workspace_capture, "wp-codebox/runner-workspace-capture-result/v1")
  assert.equal(input.runtime_invocation.provider_runtime_contract.result_schemas.workspace_command, "wp-codebox/runner-workspace-command-result/v1")
  assert.equal(input.runtime_invocation.provider_runtime_contract.result_schemas.workspace_publication, "wp-codebox/runner-workspace-publication-result/v1")
  assert.equal(input.runtime_invocation.provider_runtime_contract.result_schemas.tool_call_transcript, "wp-codebox/tool-call-transcript/v1")
  assert.equal(input.runtime_invocation.provider_runtime_contract.result_schemas.evidence_artifact_envelope, "wp-codebox/evidence-artifact-envelope/v1")
  assert.equal(input.runtime_invocation.component_manifest.components[0].slug, "example-component")
  assert.doesNotMatch(JSON.stringify(input.runtime_invocation), /datamachine|data machine|homeboy|wpsg|wp-site-generator|wp site generator/i)

  const cliOptionsPath = join(root, "generic-ability-runtime-options.json")
  const cliRecipePath = join(root, "generic-ability-runtime.recipe.json")
  await writeFile(cliOptionsPath, JSON.stringify({
    abilityId: "example/runtime-run",
    abilityInput: { prompt: "collect evidence" },
    expectedResultSchema: "example/result/v1",
    components: [{ source: component, activate: true }],
    providerPlugins: [{ source: provider, slug: "example-provider" }],
    runtimeOverlays: [{ kind: "wordpress-plugin", library: "example-runtime", source: provider, strategy: "copy" }],
    toolPolicy: { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] },
  }))

  assert.equal(await runRecipeBuildCommand(["generic-ability-runtime-run", "--options", cliOptionsPath, "--output", cliRecipePath]), 0)
  const cliRecipe = JSON.parse(await readFile(cliRecipePath, "utf8"))
  assert.equal(cliRecipe.workflow.steps[0].command, "wordpress.ability")
  assert.ok(cliRecipe.workflow.steps[0].args.includes("name=example/runtime-run"))
  assert.equal(cliRecipe.inputs.extra_plugins.length, 2)
  assert.equal(cliRecipe.runtime.overlays[0].library, "example-runtime")

  const stableSubpathRecipe = buildGenericAbilityRuntimeRunRecipeFromStableSubpath({ abilityId: "example/runtime-run" })
  assert.equal(stableSubpathRecipe.workflow.steps[0].command, "wordpress.ability")
})

assert.equal(expectedAbilityResultSchemaFromArgs(["expected-result-schema=\"example/result/v1\""]), "example/result/v1")

const okEnvelope = abilityResponseToCommandEnvelope(JSON.stringify({
  schema: "wp-codebox/wordpress-ability-result/v1",
  command: "wordpress.ability",
  status: "ok",
  name: "example/runtime-run",
  result: { schema: "example/result/v1", evidenceEnvelope: { schema: "wp-codebox/evidence-artifact-envelope/v1" } },
}), "example/runtime-run", {}, "example/result/v1")

assert.equal(okEnvelope.status, "ok")
assert.equal(okEnvelope.json?.schema, GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA)
assert.deepEqual((okEnvelope.json as Record<string, unknown>).evidenceEnvelope, { schema: "wp-codebox/evidence-artifact-envelope/v1" })

const mismatchEnvelope = abilityResponseToCommandEnvelope(JSON.stringify({
  schema: "wp-codebox/wordpress-ability-result/v1",
  command: "wordpress.ability",
  status: "ok",
  name: "example/runtime-run",
  result: { schema: "other/v1" },
}), "example/runtime-run", {}, "example/result/v1")

assert.equal(mismatchEnvelope.status, "error")
assert.equal(mismatchEnvelope.error?.code, "unexpected-result-schema")

console.log("generic ability runtime run ok")
