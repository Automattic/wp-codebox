import assert from "node:assert/strict"
import { assertEditorMutationPostcondition, captureEditorState, captureEditorValidity, editorOpenArtifactError, editorOpenArtifactFilesForCapture, editorOpenArtifactPathPrefixFromArgs, executeEditorActionStep, type EditorStateSnapshot, waitForEditorOpenReadiness } from "../packages/runtime-playground/src/editor-command-runners.js"
import { isBrowserCommandArtifactError } from "../packages/runtime-playground/src/browser-command-artifact-error.js"
import { editorActionStepsFromArgs, editorOpenTargetFromArgs, resolveEditorOpenTarget } from "../packages/runtime-playground/src/editor-actions.js"

const steps = await editorActionStepsFromArgs([
  `steps-json=${JSON.stringify([
    { kind: "waitForReady", timeout: "30s" },
    { kind: "insertBlock", name: "core/paragraph", content: "Editor save marker" },
    { kind: "updateBlockAttributes", path: [0], attributes: { content: "Updated" } },
    { kind: "replaceInnerBlocks", index: 0, blocks: [{ name: "example/container-child" }] },
    { kind: "moveBlock", clientId: "block-1", position: 0 },
    { kind: "undo" },
    { kind: "redo" },
    { kind: "reload" },
    { kind: "reopen" },
    { kind: "savePost", marker: "Editor save marker", timeout: "45s" },
    { kind: "inspectState" },
  ])}`,
])

assert.deepEqual(steps, [
  { kind: "waitForReady", timeout: "30s" },
  { kind: "insertBlock", name: "core/paragraph", content: "Editor save marker" },
  { kind: "updateBlockAttributes", path: [0], attributes: { content: "Updated" } },
  { kind: "replaceInnerBlocks", index: 0, blocks: [{ name: "example/container-child" }] },
  { kind: "moveBlock", clientId: "block-1", position: 0 },
  { kind: "undo" },
  { kind: "redo" },
  { kind: "reload" },
  { kind: "reopen" },
  { kind: "savePost", marker: "Editor save marker", timeout: "45s" },
  { kind: "inspectState" },
])

await assert.rejects(
  () => editorActionStepsFromArgs([`steps-json=${JSON.stringify([{ kind: "savePost", marker: 123 }])}`]),
  /marker must be a string/,
)

await assert.rejects(
  () => editorActionStepsFromArgs([`steps-json=${JSON.stringify([{ kind: "removeBlock", index: 0, clientId: "also-set" }])}`]),
  /exactly one target/,
)
await assert.rejects(
  () => editorActionStepsFromArgs([`steps-json=${JSON.stringify([{ kind: "replaceBlock", path: [], block: { attributes: {} } }])}`]),
  /target must be a non-empty|name must be a block name/,
)

const target = editorOpenTargetFromArgs(["target=post-new"])
assert.equal(target.waitSelector, undefined)
const unavailableEditorState = await captureEditorState({
  evaluate: async (callback: () => unknown) => {
    const globals = globalThis as typeof globalThis & { window?: unknown }
    const previousWindow = globals.window
    globals.window = {
      data: {
        select: (store: string) => store === "core/block-editor" ? { getBlocks: () => [] } : undefined,
      },
    }
    globals.window = { wp: globals.window }
    try {
      return callback()
    } finally {
      globals.window = previousWindow
    }
  },
} as never, target)
assert.equal(unavailableEditorState.storesAvailable, false)

// Runner mutations use only the generic data/block APIs, resolve nested paths,
// and fail closed when the required store action is unavailable.
const runnerCalls: Array<{ action: string; args: unknown[] }> = []
const runnerBlock = { clientId: "parent", innerBlocks: [{ clientId: "child", innerBlocks: [] }] }
const runnerActions = new Proxy({
  updateBlockAttributes: (...args: unknown[]) => runnerCalls.push({ action: "updateBlockAttributes", args }),
  moveBlocksToPosition: (...args: unknown[]) => runnerCalls.push({ action: "moveBlocksToPosition", args }),
  replaceInnerBlocks: (...args: unknown[]) => runnerCalls.push({ action: "replaceInnerBlocks", args }),
  removeBlocks: (...args: unknown[]) => runnerCalls.push({ action: "removeBlocks", args }),
  duplicateBlocks: (...args: unknown[]) => runnerCalls.push({ action: "duplicateBlocks", args }),
  replaceBlock: (...args: unknown[]) => runnerCalls.push({ action: "replaceBlock", args }),
  selectBlock: (...args: unknown[]) => runnerCalls.push({ action: "selectBlock", args }),
} as Record<string, (...args: unknown[]) => void>, {
  get(target, key) { return target[key as string] },
})
const runnerWindow = {
  setInterval,
  clearInterval,
  wp: {
    blocks: { createBlock: (name: string, attributes: Record<string, unknown>, innerBlocks: unknown[]) => ({ name, attributes, innerBlocks }) },
    data: {
      select: (store: string) => store === "core/block-editor" ? { getBlocks: () => [runnerBlock] } : store === "core/editor" ? {
        getCurrentPostId: () => 7,
        getCurrentPostType: () => "post",
        getCurrentPost: () => ({ id: 7, type: "post", content: { raw: "<!-- wp:example/parent /-->" } }),
        getEditedPostContent: () => "<!-- wp:example/parent /-->",
        isEditedPostDirty: () => false,
        isSavingPost: () => false,
        didPostSaveRequestSucceed: () => true,
        didPostSaveRequestFail: () => false,
      } : undefined,
      dispatch: (store: string) => store === "core/block-editor" ? runnerActions : store === "core/editor" ? { savePost: () => undefined, undo: () => runnerCalls.push({ action: "undo", args: [] }), redo: () => runnerCalls.push({ action: "redo", args: [] }) } : {},
    },
  },
}
const runnerPage = {
  evaluate: async (callback: (...args: never[]) => unknown, input?: never) => {
    const globals = globalThis as typeof globalThis & { window?: unknown }
    const previous = globals.window
    globals.window = runnerWindow
    try { return await callback(input as never) } finally { globals.window = previous }
  },
  reload: async () => undefined,
  goto: async () => undefined,
  waitForFunction: async (predicate: () => unknown) => {
    const globals = globalThis as typeof globalThis & { window?: unknown }
    const previous = globals.window
    globals.window = runnerWindow
    try {
      const value = predicate()
      return { jsonValue: async () => value }
    } finally { globals.window = previous }
  },
} as never
await executeEditorActionStep(runnerPage, { kind: "updateBlockAttributes", path: [0, 0], attributes: { align: "wide" } }, 1, "http://example.test/editor")
await executeEditorActionStep(runnerPage, { kind: "moveBlock", clientId: "child", position: 0 }, 1, "http://example.test/editor")
await executeEditorActionStep(runnerPage, { kind: "replaceInnerBlocks", index: 0, blocks: [{ name: "example/child" }] }, 1, "http://example.test/editor")
await executeEditorActionStep(runnerPage, { kind: "undo" }, 1, "http://example.test/editor")
await executeEditorActionStep(runnerPage, { kind: "redo" }, 1, "http://example.test/editor")
const saveResult = await executeEditorActionStep(runnerPage, { kind: "savePost" }, 1, "http://example.test/editor")
assert.equal(saveResult?.save?.status, "saved")
assert.ok(saveResult?.save?.contentSha256)
const stateBeforeReload = await captureEditorState(runnerPage, target)
await executeEditorActionStep(runnerPage, { kind: "reload" }, 1, "http://example.test/editor")
assert.equal((await captureEditorState(runnerPage, target)).serializedContentSha256, stateBeforeReload.serializedContentSha256)
await executeEditorActionStep(runnerPage, { kind: "reopen" }, 1, "http://example.test/editor")
assert.equal((await captureEditorState(runnerPage, target)).savedContentSha256, stateBeforeReload.savedContentSha256)
assert.deepEqual(runnerCalls.map(({ action }) => action), ["updateBlockAttributes", "moveBlocksToPosition", "replaceInnerBlocks", "undo", "redo"])
assert.equal(runnerCalls[0]?.args[0], "child")
await assert.rejects(() => executeEditorActionStep(runnerPage, { kind: "removeBlock", clientId: "missing" }, 1, "http://example.test/editor"), /target-not-found/)
const capturedRunnerState = await captureEditorState(runnerPage, target)
assert.equal(capturedRunnerState.blocks?.[0]?.innerBlocks?.[0]?.clientId, "child")
assert.equal(capturedRunnerState.blocks?.[0]?.isValid, undefined)
assert.ok(capturedRunnerState.serializedContentSha256)
assert.equal(capturedRunnerState.dirty, false)

const insertTimeoutPage = (applyInsert: boolean) => {
  const blocks = [{ name: "core/paragraph", clientId: "existing", attributes: { content: "Before" }, innerBlocks: [] }] as Array<Record<string, unknown>>
  const timeoutWindow = {
    wp: {
      blocks: {
        createBlock: (name: string, attributes: Record<string, unknown>) => ({ name, clientId: "inserted", attributes, innerBlocks: [] }),
        serialize: (items: unknown[]) => JSON.stringify(items),
      },
      data: {
        select: (store: string) => store === "core/block-editor" ? { getBlocks: () => blocks } : store === "core/editor" ? {
          getCurrentPost: () => ({ content: { raw: "saved" } }),
          getEditedPostContent: () => JSON.stringify(blocks),
          isEditedPostDirty: () => false,
          isSavingPost: () => false,
        } : undefined,
        dispatch: (store: string) => store === "core/block-editor" ? {
          insertBlocks: (inserted: Array<Record<string, unknown>>) => { if (applyInsert) blocks.push(...inserted) },
        } : undefined,
      },
    },
  }
  return {
    evaluate: async (callback: (...args: never[]) => unknown, input?: never) => {
      const globals = globalThis as typeof globalThis & { window?: unknown }
      const previous = globals.window
      globals.window = timeoutWindow
      try { return await callback(input as never) } finally { globals.window = previous }
    },
    waitForFunction: async () => { throw new Error("insert count wait timed out") },
  } as never
}

// A rejected insert is a typed no-op once its post-timeout snapshot matches the
// pre-step state. A changed snapshot remains the original timeout because the
// count wait did not establish the requested insertion deterministically.
const rejectedInsertPage = insertTimeoutPage(false)
const rejectedInsertBefore = await captureEditorState(rejectedInsertPage, target)
await assert.rejects(
  () => executeEditorActionStep(rejectedInsertPage, { kind: "insertBlock", name: "core/paragraph", content: "Rejected" }, 1, "http://example.test/editor", rejectedInsertBefore),
  /wp-codebox-editor-mutation-noop:insertBlock:editor state did not change/,
)
const ambiguousInsertPage = insertTimeoutPage(true)
const ambiguousInsertBefore = await captureEditorState(ambiguousInsertPage, target)
await assert.rejects(
  () => executeEditorActionStep(ambiguousInsertPage, { kind: "insertBlock", name: "core/paragraph", content: "Changed" }, 1, "http://example.test/editor", ambiguousInsertBefore),
  /insert count wait timed out/,
)

const state = (blocks: EditorStateSnapshot["blocks"], content: string): EditorStateSnapshot => ({
  schema: "wp-codebox/editor-state/v1",
  capturedAt: "2026-01-01T00:00:00.000Z",
  target,
  storesAvailable: true,
  blocks,
  serializedContentSha256: content,
})
const block = (clientId: string, attributes: Record<string, unknown> = {}, innerBlocks: NonNullable<EditorStateSnapshot["blocks"]> = []) => ({ name: "core/paragraph", clientId, attributes, innerBlocks })

// Stateful actions must prove their requested transition from the captured editor
// tree. Dispatches that Gutenberg silently ignores are typed no-ops, not success.
assertEditorMutationPostcondition(
  { kind: "moveBlock", clientId: "b", position: 0 },
  state([block("a"), block("b")], "before"),
  state([block("b"), block("a")], "after"),
)
assertEditorMutationPostcondition(
  { kind: "duplicateBlock", clientId: "a" },
  state([block("a", { content: "A" })], "before"),
  state([block("a", { content: "A" }), block("copy", { content: "A" })], "after"),
)
assertEditorMutationPostcondition(
  { kind: "updateBlockAttributes", clientId: "a", attributes: { content: "Updated" } },
  state([block("a", { content: "Before" })], "before"),
  state([block("a", { content: "Updated" })], "after"),
)
assertEditorMutationPostcondition(
  { kind: "removeBlock", clientId: "a" },
  state([block("a"), block("b")], "before"),
  state([block("b")], "after"),
)
for (const [step, before, after] of [
  [{ kind: "moveBlock", clientId: "b", position: 1 }, state([block("a"), block("b")], "same"), state([block("a"), block("b")], "same")],
  [{ kind: "duplicateBlock", clientId: "a" }, state([block("a")], "same"), state([block("a")], "same")],
  [{ kind: "updateBlockAttributes", clientId: "a", attributes: { content: "Same" } }, state([block("a", { content: "Same" })], "same"), state([block("a", { content: "Same" })], "same")],
  [{ kind: "removeBlock", clientId: "a" }, state([block("a")], "same"), state([block("a")], "same")],
] as const) {
  assert.throws(() => assertEditorMutationPostcondition(step, before, after), new RegExp(`wp-codebox-editor-mutation-noop:${step.kind}`))
}

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

const nestedValidity = await captureEditorValidity({
  evaluate: async (callback: (selectors: string[]) => unknown, selectors: string[]) => {
    const globals = globalThis as typeof globalThis & { window?: unknown; document?: unknown }
    const previousWindow = globals.window
    const previousDocument = globals.document
    globals.document = { querySelectorAll: () => [] }
    globals.window = {
      wp: {
        data: {
          select: (store: string) => store === "core/block-editor" ? {
            getBlocks: () => [{ name: "core/group", clientId: "parent", isValid: true, innerBlocks: [{ name: "core/paragraph", clientId: "nested-invalid", isValid: false, innerBlocks: [] }] }],
          } : undefined,
        },
      },
    }
    try {
      return callback(selectors)
    } finally {
      globals.window = previousWindow
      globals.document = previousDocument
    }
  },
} as never, target)
assert.equal(nestedValidity.summary.status, "warnings")
assert.equal(nestedValidity.summary.warningCount, 1)
assert.equal(nestedValidity.warnings[0]?.clientId, "nested-invalid")

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

// Live fixture evidence established that the block-editor store can be usable
// before global block APIs, core/editor, or savePost are available. Opening the
// editor must accept that state; an explicit selector remains an additional
// caller assertion.
const readinessCalls: Array<string | undefined> = []
const semanticReadyPage = {
  waitForFunction: async (predicate: (selector?: string) => unknown, selector?: string) => {
    readinessCalls.push(selector)
    if (selector) {
      throw new Error(`Timed out waiting for ${selector}`)
    }
    const globals = globalThis as typeof globalThis & { window?: unknown }
    const previousWindow = globals.window
    globals.window = {
      wp: {
        data: {
          select: (store: string) => store === "core/block-editor"
            ? { getBlocks: () => Array.from({ length: 118 }) }
            : undefined,
          dispatch: () => ({}),
        },
      },
    }
    try {
      const readiness = predicate()
      assert.ok(readiness)
      return { jsonValue: async () => readiness }
    } finally {
      globals.window = previousWindow
    }
  },
} as never
const semanticReadiness = await waitForEditorOpenReadiness(semanticReadyPage, undefined, 1)
assert.equal(semanticReadiness.editorReadiness.blockTypesRegistered, undefined)
assert.equal(semanticReadiness.editorReadiness.storesAvailable, false)
assert.equal(semanticReadiness.editorReadiness.canSave, false)
await assert.rejects(
  () => waitForEditorOpenReadiness(semanticReadyPage, ".legacy-editor-shell", 1),
  /Timed out waiting for \.legacy-editor-shell/,
)
assert.deepEqual(readinessCalls, [undefined, undefined, ".legacy-editor-shell"])

const retainedArtifact = {
  artifactType: "editor-open",
  requestedUrl: "http://example.test/wp-admin/post-new.php",
  url: "http://example.test/wp-admin/post-new.php",
  preview: { effectiveOrigin: "http://example.test" },
  files: { screenshot: "files/browser/editor-screenshot.png", editorState: "files/browser/editor-state.json", console: "files/browser/editor-console.jsonl", summary: "files/browser/editor-summary.json" },
  summary: { consoleMessages: 1, errors: 1, finalUrl: "http://example.test/wp-admin/post-new.php", htmlSnapshot: false, networkEvents: 0, replayability: "diagnostic-only", screenshot: true, viewport: null },
} as never
const readinessFailure = editorOpenArtifactError(2, new Error("editor readiness timed out"), retainedArtifact)
assert.equal(isBrowserCommandArtifactError(readinessFailure), true)
assert.strictEqual(readinessFailure.artifact, retainedArtifact)

console.log("editor actions ok")
