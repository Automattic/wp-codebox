import assert from "node:assert/strict"
import test from "node:test"
import { validateBrowserInteractionScript } from "../packages/runtime-core/src/browser-interaction.js"
import { validateBrowserPresentation } from "../packages/runtime-playground/src/browser-presentation.js"

test("scroll steps validate supported destinations, offsets, and options", () => {
  assert.equal(validateBrowserInteractionScript([{ kind: "scroll", selector: "#target", behavior: "smooth", durationMs: 300, block: "center" }]).valid, true)
  assert.equal(validateBrowserInteractionScript([{ kind: "scroll", by: { x: 0, y: 400 }, behavior: "instant" }]).valid, true)
  assert.equal(validateBrowserInteractionScript([{ kind: "scroll", position: "sideways" }]).valid, false)
  assert.equal(validateBrowserInteractionScript([{ kind: "scroll", position: "bottom" }]).valid, true)
  assert.equal(validateBrowserInteractionScript([{ kind: "scroll", by: { x: "0", y: 2 } }]).valid, false)
})

test("presentation-json accepts an object and rejects non-objects", () => {
  assert.deepEqual(validateBrowserPresentation({ pointer: { enabled: true }, typing: { delayMs: 20 } }), { pointer: { enabled: true }, typing: { delayMs: 20 } })
  assert.throws(() => validateBrowserPresentation([]), /must be an object/)
})
