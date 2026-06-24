import assert from "node:assert/strict"
import { captureEditorValidity } from "../packages/runtime-playground/src/editor-command-runners.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs } from "../packages/runtime-playground/src/editor-actions.js"

const steps = await editorActionStepsFromArgs([
  `steps-json=${JSON.stringify([
    { kind: "waitForReady", timeout: "30s" },
    { kind: "insertBlock", name: "core/paragraph", content: "Editor save marker" },
    { kind: "savePost", marker: "Editor save marker", timeout: "45s" },
    { kind: "inspectState" },
  ])}`,
])

assert.deepEqual(steps, [
  { kind: "waitForReady", timeout: "30s" },
  { kind: "insertBlock", name: "core/paragraph", content: "Editor save marker" },
  { kind: "savePost", marker: "Editor save marker", timeout: "45s" },
  { kind: "inspectState" },
])

await assert.rejects(
  () => editorActionStepsFromArgs([`steps-json=${JSON.stringify([{ kind: "savePost", marker: 123 }])}`]),
  /marker must be a string/,
)

const target = editorOpenTargetFromArgs(["target=post-new"])
const validity = await captureEditorValidity({
  evaluate: async (_callback: unknown, selectors: string[]) => ([{
    source: "dom",
    selector: selectors[0],
    path: "div.block-editor-warning",
    message: "This block contains unexpected or invalid content.",
    blockName: "core/paragraph",
    clientId: "block-1",
  }]),
} as never, target)

assert.equal(validity.schema, "wp-codebox/editor-validity/v1")
assert.equal(validity.summary.status, "warnings")
assert.equal(validity.summary.warningCount, 1)
assert.deepEqual(validity.summary.messages, ["This block contains unexpected or invalid content."])

console.log("editor actions ok")
