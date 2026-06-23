import assert from "node:assert/strict"

import { wordpressBlockDiscoveryToCoveragePlan, wordpressBlockDiscoveryToFuzzSuite, type WordPressBlockEditorTargetDiscovery } from "../packages/runtime-core/src/index.js"

const discovery: WordPressBlockEditorTargetDiscovery = {
  schema: "wp-codebox/wordpress-block-editor-target-discovery/v1",
  blocks: [
    { name: "core/paragraph", title: "Paragraph", category: "text", supportsInserter: true, attributes: [{ name: "content", type: "string", defaultPresent: true, default: "Hello" }, { name: "dropCap", type: "boolean" }, { name: "align", type: "string", enum: ["wide", "full"] }] },
    { name: "core/image", title: "Image", category: "media", supportsInserter: true, attributes: [{ name: "id", type: "integer" }, { name: "caption", type: "string" }, { name: "url" }], exampleAttributes: { url: "https://example.com/image.jpg" } },
    { name: "core/template-part", title: "Template Part", category: "theme", supportsInserter: false, attributes: [{ name: "slug" }] },
  ],
  editorPostTypes: [
    { name: "page", label: "Pages", restBase: "pages", editorUrl: "https://example.com/wp-admin/post-new.php?post_type=page" },
    { name: "post", label: "Posts", restBase: "posts", editorUrl: "https://example.com/wp-admin/post-new.php?post_type=post" },
  ],
}

const suite = wordpressBlockDiscoveryToFuzzSuite(discovery, { id: "blocks", editorPostType: "page" })

assert.equal(suite.schema, "wp-codebox/fuzz-suite/v1")
assert.equal(suite.id, "blocks")
assert.deepEqual(suite.cases.map((fuzzCase) => fuzzCase.id), [
  "block-core-paragraph-server-render-sample-attributes",
  "block-core-paragraph-editor-insert-page-sample-attributes",
  "block-core-image-server-render-sample-attributes",
  "block-core-image-editor-insert-page-sample-attributes",
  "block-core-template-part-server-render-empty-attributes",
])
assert.equal(suite.metadata?.sourceSchema, "wp-codebox/wordpress-block-editor-target-discovery/v1")
assert.equal(suite.coveragePlan?.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.deepEqual(suite.coveragePlan?.summary.caseIds, [
  "block-core-paragraph-server-render-sample-attributes",
  "block-core-paragraph-editor-insert-page-sample-attributes",
  "block-core-image-server-render-sample-attributes",
  "block-core-image-editor-insert-page-sample-attributes",
  "block-core-template-part-server-render-empty-attributes",
  "block-core-template-part-editor-insert-page-empty-attributes",
])
assert.equal(suite.metadata?.editorPostType, "page")
assert.deepEqual(suite.metadata?.requiredRunnerCapabilities, {
  capabilities: ["target:runtime", "runtime", "runtime-action:editor_open"],
  targetKinds: ["runtime"],
  runtimeActionTypes: ["editor_open"],
  commands: ["wordpress.run-php", "wordpress.editor-open"],
})

const renderCase = suite.cases[0]
assert.deepEqual(renderCase?.target, { kind: "runtime", entrypoint: "wordpress.run-php" })
assert.deepEqual((renderCase?.input as { args: string[] }).args[1], "bootstrap=wordpress")
assert.match((renderCase?.input as { args: string[] }).args[0] ?? "", /render_block/)
assert.match((renderCase?.input as { args: string[] }).args[0] ?? "", /Hello/)
assert.deepEqual(renderCase?.metadata?.samples, { attributes: { content: "Hello", dropCap: true, align: "wide" } })

const editorCase = suite.cases[1]
assert.deepEqual(editorCase?.target, { kind: "runtime", entrypoint: "wordpress.editor-actions" })
assert.deepEqual((editorCase?.input as { args: string[] }).args, [
  "target=post-new",
  "post-type=page",
  'steps-json=[{"kind":"insertBlock","name":"core/paragraph","attributes":{"content":"Hello","dropCap":true,"align":"wide"}},{"kind":"inspectState"}]',
  "capture=editor-state,errors",
])
assert.deepEqual(editorCase?.metadata?.samples, { attributes: { content: "Hello", dropCap: true, align: "wide" }, editorPostType: "page" })

assert.deepEqual(suite.cases[2]?.metadata?.samples, { attributes: { id: 1, caption: "sample", url: "https://example.com/image.jpg" } })

const renderOnly = wordpressBlockDiscoveryToFuzzSuite(discovery, { includeEditorInsert: false })
assert.deepEqual(renderOnly.cases.map((fuzzCase) => fuzzCase.id), [
  "block-core-paragraph-server-render-sample-attributes",
  "block-core-image-server-render-sample-attributes",
  "block-core-template-part-server-render-empty-attributes",
])
assert.deepEqual(renderOnly.metadata?.requiredRunnerCapabilities, {
  capabilities: ["target:runtime", "runtime"],
  targetKinds: ["runtime"],
  commands: ["wordpress.run-php"],
})

const noEditorTargets = wordpressBlockDiscoveryToFuzzSuite({ ...discovery, editorPostTypes: [] })
assert.deepEqual(noEditorTargets.cases.map((fuzzCase) => fuzzCase.id), [
  "block-core-paragraph-server-render-sample-attributes",
  "block-core-image-server-render-sample-attributes",
  "block-core-template-part-server-render-empty-attributes",
])

const coveragePlan = wordpressBlockDiscoveryToCoveragePlan(discovery, { id: "blocks", editorPostType: "page" })
assert.equal(coveragePlan.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.deepEqual({ discovered: coveragePlan.summary.discovered, generated: coveragePlan.summary.generated, executable: coveragePlan.summary.executable, executed: coveragePlan.summary.executed, skipped: coveragePlan.summary.skipped, untested: coveragePlan.summary.untested }, { discovered: 6, generated: 6, executable: 5, executed: 0, skipped: 0, untested: 1 })
assert.equal(coveragePlan.untested[0]?.reason?.code, "block_inserter_unsupported")
assert.deepEqual(coveragePlan.untested[0]?.reason?.data?.unsupportedCapabilities, ["block:inserter"])
assert.equal(coveragePlan.parameterGenerationHooks?.[0]?.id, "wordpress.block-attribute-samples")

console.log("wordpress block fuzz suite ok")
