import assert from "node:assert/strict"
import { editorActionStepsFromArgs } from "../packages/runtime-playground/src/editor-actions.js"

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

console.log("editor actions ok")
