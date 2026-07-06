import assert from "node:assert/strict"
import { captureEditorValidity, editorOpenArtifactFilesForCapture, editorOpenArtifactPathPrefixFromArgs } from "../packages/runtime-playground/src/editor-command-runners.js"
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

// post-slug targets are also runtime-resolved, allowing recipe authors to target
// imported pages by stable WordPress slug when the post id is created in an
// earlier recipe step.
const postSlugTarget = editorOpenTargetFromArgs(["post-type=page", "post-slug=contact"])
assert.equal(postSlugTarget.kind, "post-slug")
assert.equal(postSlugTarget.postType, "page")
assert.equal(postSlugTarget.postSlug, "contact")
assert.equal(postSlugTarget.url, "")
const postSlugCalls: string[] = []
const resolvedPostSlug = await resolveEditorOpenTarget(postSlugTarget, {
  command: "wordpress.editor-open",
  runPlaygroundCommand: async (command) => {
    postSlugCalls.push(command)
    return { ok: true, text: "91\n" } as never
  },
  runtimeSpec: { wp: "latest" } as never,
  server: { serverUrl: "http://localhost" } as never,
})
assert.equal(resolvedPostSlug.kind, "post")
assert.equal(resolvedPostSlug.postId, 91)
assert.equal(resolvedPostSlug.url, "/wp-admin/post.php?post=91&action=edit")
assert.deepEqual(postSlugCalls, ["wordpress.editor-open.resolve-post-slug"])

await assert.rejects(
  resolveEditorOpenTarget(postSlugTarget, {
    command: "wordpress.editor-open",
    runPlaygroundCommand: async () => ({ ok: true, text: "0" } as never),
    runtimeSpec: { wp: "latest" } as never,
    server: { serverUrl: "http://localhost" } as never,
  }),
  /resolved no editable post/,
)

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

// editor-open remains backward-compatible by default, but can namespace every
// artifact path for per-fixture batch evidence.
assert.equal(editorOpenArtifactPathPrefixFromArgs([]), "files/browser")
assert.equal(
  editorOpenArtifactPathPrefixFromArgs(["artifact-prefix=files/browser/editor-open/coffee-shop"]),
  "files/browser/editor-open/coffee-shop",
)
assert.deepEqual(editorOpenArtifactFilesForCapture(new Set(["steps", "console", "errors", "html", "screenshot", "editor-state", "editor-validity"])), {
  steps: "files/browser/editor-steps.jsonl",
  console: "files/browser/editor-console.jsonl",
  errors: "files/browser/editor-errors.jsonl",
  html: "files/browser/editor-snapshot.html",
  screenshot: "files/browser/editor-screenshot.png",
  editorState: "files/browser/editor-state.json",
  editorValidity: "files/browser/editor-validity.json",
  summary: "files/browser/editor-summary.json",
})
assert.deepEqual(editorOpenArtifactFilesForCapture(new Set(["screenshot", "editor-state"]), "files/browser/editor-open/coffee-shop"), {
  screenshot: "files/browser/editor-open/coffee-shop/editor-screenshot.png",
  editorState: "files/browser/editor-open/coffee-shop/editor-state.json",
  summary: "files/browser/editor-open/coffee-shop/editor-summary.json",
})
assert.throws(
  () => editorOpenArtifactPathPrefixFromArgs(["artifact-prefix=files/browser/../escape"]),
  /relative artifact directory/,
)

console.log("editor actions ok")
