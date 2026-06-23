import assert from "node:assert/strict"

import { wordpressBlockDiscoveryToFuzzSuite, type WordPressBlockEditorTargetDiscovery } from "../packages/runtime-core/src/index.js"

const discovery: WordPressBlockEditorTargetDiscovery = {
  schema: "wp-codebox/wordpress-block-editor-target-discovery/v1",
  blocks: [
    { name: "core/paragraph", title: "Paragraph", category: "text", supportsInserter: true, attributes: ["content", "dropCap"] },
    { name: "core/template-part", title: "Template Part", category: "theme", supportsInserter: false, attributes: ["slug"] },
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
  "block-core-paragraph-server-render-empty-attributes",
  "block-core-paragraph-editor-insert-page-empty-attributes",
  "block-core-template-part-server-render-empty-attributes",
])
assert.equal(suite.metadata?.sourceSchema, "wp-codebox/wordpress-block-editor-target-discovery/v1")
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
assert.deepEqual(renderCase?.metadata?.samples, { emptyAttributes: {} })

const editorCase = suite.cases[1]
assert.deepEqual(editorCase?.target, { kind: "runtime", entrypoint: "wordpress.editor-actions" })
assert.deepEqual((editorCase?.input as { args: string[] }).args, [
  "target=post-new",
  "post-type=page",
  'steps-json=[{"kind":"insertBlock","name":"core/paragraph","attributes":{}},{"kind":"inspectState"}]',
  "capture=editor-state,errors",
])
assert.deepEqual(editorCase?.metadata?.samples, { emptyAttributes: {}, editorPostType: "page" })

const renderOnly = wordpressBlockDiscoveryToFuzzSuite(discovery, { includeEditorInsert: false })
assert.deepEqual(renderOnly.cases.map((fuzzCase) => fuzzCase.id), [
  "block-core-paragraph-server-render-empty-attributes",
  "block-core-template-part-server-render-empty-attributes",
])
assert.deepEqual(renderOnly.metadata?.requiredRunnerCapabilities, {
  capabilities: ["target:runtime", "runtime"],
  targetKinds: ["runtime"],
  commands: ["wordpress.run-php"],
})

const noEditorTargets = wordpressBlockDiscoveryToFuzzSuite({ ...discovery, editorPostTypes: [] })
assert.deepEqual(noEditorTargets.cases.map((fuzzCase) => fuzzCase.id), [
  "block-core-paragraph-server-render-empty-attributes",
  "block-core-template-part-server-render-empty-attributes",
])

console.log("wordpress block fuzz suite ok")
