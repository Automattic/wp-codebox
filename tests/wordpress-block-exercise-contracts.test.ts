import assert from "node:assert/strict"
import {
  WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA,
  createUnsupportedWordPressBlockExerciseResult,
  normalizeWordPressBlockExerciseInput,
} from "../packages/runtime-core/src/index.js"
import { getCommandDefinition } from "../packages/runtime-core/src/contracts.js"
import { wordpressBlockExerciseInputFromArgs, wordpressBlockExercisePhpCode } from "../packages/runtime-playground/src/wordpress-block-exercise-command-handlers.js"

const renderInput = normalizeWordPressBlockExerciseInput({
  blockName: "core/paragraph",
  attrs: { align: "wide" },
  content: "Hello block",
  source: "test",
})

assert.deepEqual(renderInput, {
  blockName: "core/paragraph",
  attrs: { align: "wide" },
  content: "Hello block",
  mode: "render",
  source: "test",
})

assert.deepEqual(wordpressBlockExerciseInputFromArgs([
  "block-name=core/latest-posts",
  "attrs-json={\"postsToShow\":3}",
  "mode=serialize-parse",
], "wordpress.block-exercise"), {
  blockName: "core/latest-posts",
  attrs: { postsToShow: 3 },
  mode: "serialize-parse",
})

const unsupportedEditor = createUnsupportedWordPressBlockExerciseResult(normalizeWordPressBlockExerciseInput({
  blockName: "core/image",
  mode: "editor-insert-save",
}), "wordpress.block-exercise")
assert.equal(unsupportedEditor.schema, WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA)
assert.equal(unsupportedEditor.status, "unsupported")
assert.equal(unsupportedEditor.mode, "editor-insert-save")
assert.deepEqual(unsupportedEditor.artifactRefs, [])
assert.match(unsupportedEditor.diagnostics[0]?.message ?? "", /not implemented/)

const renderDefinition = getCommandDefinition("wordpress.block-render")
assert.equal(renderDefinition?.outputSchema?.id, WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA)
assert.equal(renderDefinition?.handler.kind === "playground" ? renderDefinition.handler.method : undefined, "runBlockRender")
assert.equal(renderDefinition?.acceptedArgs.some((arg) => arg.name === "block-name" && arg.required), true)

const exerciseDefinition = getCommandDefinition("wordpress.block-exercise")
assert.equal(exerciseDefinition?.outputSchema?.id, WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA)
assert.equal(exerciseDefinition?.handler.kind === "playground" ? exerciseDefinition.handler.method : undefined, "runBlockExercise")
assert.match(exerciseDefinition?.policyRequirement ?? "", /browser\/editor runtime capability/)

const renderPhp = wordpressBlockExercisePhpCode(renderInput, "wordpress.block-render")
assert.match(renderPhp, /render_block/)
assert.match(renderPhp, /parse_blocks/)
assert.match(renderPhp, /serialize_block/)
assert.match(renderPhp, /block-not-registered/)
assert.match(renderPhp, /wp-codebox\/wordpress-block-exercise-result\/v1/)
assert.match(renderPhp, /excerpt.*hash/s)
assert.match(renderPhp, /performance.*block-exercise/s)

const editorPhp = wordpressBlockExercisePhpCode(normalizeWordPressBlockExerciseInput({ blockName: "core/paragraph", mode: "editor-insert-save" }), "wordpress.block-exercise")
assert.match(editorPhp, /editor-runtime-required/)
assert.match(editorPhp, /status' => 'unsupported'/)

assert.throws(() => normalizeWordPressBlockExerciseInput({ blockName: "paragraph" }), /blockName must be a registered block name slug/)
assert.throws(() => normalizeWordPressBlockExerciseInput({ blockName: "core/paragraph", mode: "browser" }), /mode must be render, serialize-parse, or editor-insert-save/)
assert.throws(() => normalizeWordPressBlockExerciseInput({ blockName: "core/paragraph", attrs: [] }), /attrs must be a JSON object/)

console.log("wordpress block exercise contracts ok")
