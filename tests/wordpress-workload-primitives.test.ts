import assert from "node:assert/strict"

import {
  PLAYGROUND_PREVIEW_URL_SCHEMA,
  WORDPRESS_WORKLOAD_RUN_SCHEMA,
  playgroundPreviewUrl,
  wordpressAbilityStep,
  wordpressWorkloadRunRecipe,
} from "../packages/runtime-core/src/index.js"

const abilityStep = wordpressAbilityStep({
  name: "example/do-work",
  input: { prompt: "collect evidence" },
  expectedResultSchema: "example/result/v1",
})

assert.equal(abilityStep.command, "wordpress.ability")
assert.ok(abilityStep.args?.includes("name=example/do-work"))
assert.ok(abilityStep.args?.includes('input={"prompt":"collect evidence"}'))
assert.ok(abilityStep.args?.includes('expected-result-schema="example/result/v1"'))

const recipe = wordpressWorkloadRunRecipe({
  preview: { publicUrl: "https://preview.example.test/run-1/" },
  capture: { queries: true },
  runtimeEnv: { EXAMPLE_FLAG: true, ignored: "nope" },
  secretEnv: ["EXAMPLE_TOKEN", "EXAMPLE_TOKEN"],
  mounts: [{ source: "/workspace/plugin", target: "/wordpress/wp-content/plugins/example" }],
  steps: [abilityStep],
})

assert.equal(recipe.schema, "wp-codebox/workspace-recipe/v1")
assert.equal(recipe.runtime?.backend, "wordpress-playground")
assert.deepEqual(recipe.runtime?.preview, { publicUrl: "https://preview.example.test/run-1/" })
assert.deepEqual(recipe.inputs?.runtimeEnv, { EXAMPLE_FLAG: "1" })
assert.deepEqual(recipe.inputs?.secretEnv, ["EXAMPLE_TOKEN"])
assert.equal(recipe.workflow.steps[0].command, "wordpress.ability")
assert.equal(recipe.metadata?.public_contract, WORDPRESS_WORKLOAD_RUN_SCHEMA)
assert.deepEqual(recipe.metadata?.capture, { queries: true })

assert.deepEqual(playgroundPreviewUrl({
  localUrl: "http://127.0.0.1:9400/",
  publicUrl: "https://preview.example.test/run-1/",
  path: "/wp-admin/",
  mode: "secure",
}), {
  schema: PLAYGROUND_PREVIEW_URL_SCHEMA,
  mode: "secure",
  localUrl: "http://127.0.0.1:9400/",
  publicUrl: "https://preview.example.test/run-1/",
  effectiveUrl: "https://preview.example.test/wp-admin/",
  diagnostics: [],
})

const missingPublic = playgroundPreviewUrl({ localUrl: "http://127.0.0.1:9400/", mode: "public" })
assert.equal(missingPublic.effectiveUrl, "http://127.0.0.1:9400/")
assert.equal(missingPublic.diagnostics[0].code, "preview-public-url-missing")

assert.throws(() => wordpressAbilityStep({ name: "" }), /requires name/)
assert.throws(() => wordpressWorkloadRunRecipe({ steps: [] }), /requires at least one step/)
assert.throws(() => playgroundPreviewUrl({ localUrl: "file:///tmp/site" }), /http\(s\) URL/)

console.log("wordpress workload primitives passed")
