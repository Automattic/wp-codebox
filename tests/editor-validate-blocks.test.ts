import assert from "node:assert/strict"
import { flattenBlockValidationNodes, summarizeBlockValidation, validateEditorBlocks, type BlockValidationNode } from "../packages/runtime-playground/src/editor-command-runners.js"
import { editorValidateContentFromArgs, editorValidateProviderFromArgs } from "../packages/runtime-playground/src/editor-actions.js"

// Argument parsing: inline content, default provider, and explicit provider.
assert.equal(await editorValidateContentFromArgs(["content=<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->"]), "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->")
assert.equal(await editorValidateContentFromArgs([]), undefined)
assert.equal(await editorValidateContentFromArgs(["content="]), "")
assert.equal(editorValidateProviderFromArgs([]), "wordpress-block-editor")
assert.equal(editorValidateProviderFromArgs(["validation-provider=custom-brain"]), "custom-brain")

// Recursion: innerBlocks are flattened depth-first.
const tree: BlockValidationNode[] = [
  {
    name: "core/columns",
    isValid: true,
    issues: [],
    innerBlocks: [
      { name: "core/column", isValid: true, issues: [], innerBlocks: [
        { name: "core/paragraph", isValid: true, issues: [] },
      ] },
    ],
  },
]
const flattened = flattenBlockValidationNodes(tree)
assert.deepEqual(flattened.map((entry) => entry.name), ["core/columns", "core/column", "core/paragraph"])

// A post with valid blocks: every block isValid, zero invalid.
const validResult = summarizeBlockValidation({
  validationProvider: "wordpress-block-editor",
  nodes: [
    { name: "core/heading", isValid: true, issues: [] },
    { name: "core/paragraph", isValid: true, issues: [], innerBlocks: [] },
  ],
})
assert.equal(validResult.total_blocks, 2)
assert.equal(validResult.valid_blocks, 2)
assert.equal(validResult.invalid_blocks, 0)
assert.equal(validResult.validation_method, "wp.blocks.validateBlock")
assert.equal(validResult.validation_provider, "wordpress-block-editor")
assert.ok(validResult.results.every((entry) => entry.isValid === true))

// A post with a deliberately corrupted (nested) block: counted invalid, keeps name + issues.
const corruptedResult = summarizeBlockValidation({
  validationProvider: "wordpress-block-editor",
  nodes: [
    { name: "core/group", isValid: true, issues: [], innerBlocks: [
      { name: "core/paragraph", isValid: false, issues: ["Block validation failed: expected <p> but found <div>"] },
    ] },
    { name: "core/heading", isValid: true, issues: [] },
  ],
})
assert.equal(corruptedResult.total_blocks, 3)
assert.equal(corruptedResult.valid_blocks, 2)
assert.equal(corruptedResult.invalid_blocks, 1)
const invalid = corruptedResult.results.find((entry) => !entry.isValid)
assert.ok(invalid, "expected an invalid block in results")
assert.equal(invalid?.name, "core/paragraph")
assert.deepEqual(invalid?.issues, ["Block validation failed: expected <p> but found <div>"])

// validateEditorBlocks shapes the verbatim envelope from a stubbed editor runtime evaluation.
const stubPage = {
  evaluate: async (_callback: unknown) => ({
    nodes: [
      { name: "core/paragraph", isValid: true, issues: [] },
      { name: "core/image", isValid: false, issues: ["This block contains unexpected or invalid content."] },
    ],
    validationProvider: "wordpress-block-editor",
    contentSource: "argument",
    blockTypesRegistered: 42,
  }),
}
const evaluated = await validateEditorBlocks(stubPage as never, { content: "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->", provider: "wordpress-block-editor" })
assert.equal(evaluated.result.validation_method, "wp.blocks.validateBlock")
assert.equal(evaluated.result.total_blocks, 2)
assert.equal(evaluated.result.valid_blocks, 1)
assert.equal(evaluated.result.invalid_blocks, 1)
assert.equal(evaluated.contentSource, "argument")
assert.equal(evaluated.blockTypesRegistered, 42)

console.log("editor validate blocks ok")
