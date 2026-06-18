import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { buildGenericAbilityRuntimeRunRecipe, GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA } from "../packages/runtime-core/src/index.js"
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
  assert.equal(input.runtime_invocation.component_manifest.components[0].slug, "example-component")
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
