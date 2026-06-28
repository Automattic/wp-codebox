import assert from "node:assert/strict"
import { captureEditorValidity } from "../packages/runtime-playground/src/editor-command-runners.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs, resolveEditorOpenTarget } from "../packages/runtime-playground/src/editor-actions.js"

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

// target=front-page parses to a runtime-resolved target with an empty URL until
// resolveEditorOpenTarget pins it to the static front page.
const frontPageTarget = editorOpenTargetFromArgs(["target=front-page"])
assert.equal(frontPageTarget.kind, "front-page")
assert.equal(frontPageTarget.url, "")

// resolveEditorOpenTarget asks the running WordPress for page_on_front and rewrites
// the target to open that exact post in the editor.
const resolveCalls: string[] = []
const resolved = await resolveEditorOpenTarget(frontPageTarget, {
  command: "wordpress.editor-validate-blocks",
  runPlaygroundCommand: async (command) => {
    resolveCalls.push(command)
    return { ok: true, text: "57\n" } as never
  },
  runtimeSpec: { wp: "latest" } as never,
  server: { serverUrl: "http://localhost" } as never,
})
assert.equal(resolved.kind, "post")
assert.equal(resolved.postId, 57)
assert.equal(resolved.url, "/wp-admin/post.php?post=57&action=edit")
assert.deepEqual(resolveCalls, ["wordpress.editor-validate-blocks.resolve-front-page"])

// No static front page configured (page_on_front resolves to 0) is a real
// misconfiguration, not a silent empty-editor open.
await assert.rejects(
  resolveEditorOpenTarget(frontPageTarget, {
    command: "wordpress.editor-validate-blocks",
    runPlaygroundCommand: async () => ({ ok: true, text: "0" } as never),
    runtimeSpec: { wp: "latest" } as never,
    server: { serverUrl: "http://localhost" } as never,
  }),
  /no static front page/,
)

// Concrete targets pass through resolveEditorOpenTarget unchanged (no PHP call).
const postTarget = editorOpenTargetFromArgs(["post-id=12"])
const passthrough = await resolveEditorOpenTarget(postTarget, {
  command: "wordpress.editor-open",
  runPlaygroundCommand: async () => {
    throw new Error("resolveEditorOpenTarget should not run PHP for a concrete target")
  },
  runtimeSpec: { wp: "latest" } as never,
  server: { serverUrl: "http://localhost" } as never,
})
assert.equal(passthrough.url, "/wp-admin/post.php?post=12&action=edit")

console.log("editor actions ok")
