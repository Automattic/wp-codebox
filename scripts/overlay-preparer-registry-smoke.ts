import assert from "node:assert/strict"
import { OverlayPreparerRegistry } from "../packages/cli/src/overlay-preparers.js"

interface Overlay {
  kind: string
}

interface PreparedOverlay {
  target: string
}

const registry = new OverlayPreparerRegistry<Overlay, PreparedOverlay>()
const key = "bundled-library/php-ai-client/wordpress-scoped-bundle"

assert.equal(registry.has(key), false)

registry.register(key, async (overlay, context) => {
  assert.equal(overlay.kind, "bundled-library")
  assert.equal(context.index, 0)
  assert.equal(context.recipeDirectory, "/recipe")
  return context.prepare()
})

assert.equal(registry.has(key), true)
assert.deepEqual(await registry.prepare(key, { kind: "bundled-library" }, {
  index: 0,
  recipeDirectory: "/recipe",
  prepare: async () => ({ target: "/wordpress/wp-includes/php-ai-client" }),
}), { target: "/wordpress/wp-includes/php-ai-client" })

await assert.rejects(
  () => registry.prepare("unsupported/library/strategy", { kind: "unsupported" }, {
    index: 1,
    recipeDirectory: "/recipe",
    prepare: async () => ({ target: "/unused" }),
  }),
  /Unsupported runtime overlay: unsupported\/library\/strategy/,
)

console.log("Overlay preparer registry smoke passed")
