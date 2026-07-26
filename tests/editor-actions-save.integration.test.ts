import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createWordPressRuntime } from "../packages/runtime-playground/src/public.js"

test("editor actions save persists after reload", { timeout: 180_000 }, async () => {
  const artifactsDirectory = join(tmpdir(), `wp-codebox-editor-save-${process.pid}-${Date.now()}`)
  const runtime = await createWordPressRuntime({
    environment: { version: "6.5", phpVersion: "8.0", blueprint: { steps: [] }, workers: 6 },
    policy: {
      network: "deny",
      filesystem: "sandbox",
      commands: ["wordpress.run-php", "wordpress.editor-actions"],
      secrets: "none",
      approvals: "never",
    },
    artifactsDirectory,
  })

  try {
    const created = await runtime.execute({
      command: "wordpress.run-php",
      args: ["code=echo wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Editor save integration', 'post_content' => '<!-- wp:paragraph --><p>Before</p><!-- /wp:paragraph -->'));"],
      timeoutMs: 60_000,
    })
    assert.equal(created.exitCode, 0, created.stderr)
    const postId = Number.parseInt(created.stdout.trim(), 10)
    assert.ok(Number.isInteger(postId) && postId > 0, `expected a created page id, received ${created.stdout}`)

    const marker = "Persisted editor action marker"
    const action = await runtime.execute({
      command: "wordpress.editor-actions",
      args: [
        `post-id=${postId}`,
        "post-type=page",
        "capture=steps,errors,editor-state",
        "wait-timeout=45s",
        "step-timeout=45s",
        "timeout=120s",
        `steps-json=${JSON.stringify([
          { kind: "updateBlockAttributes", index: 0, attributes: { content: marker } },
          { kind: "savePost" },
          { kind: "reload" },
          { kind: "inspectState" },
        ])}`,
      ],
      timeoutMs: 150_000,
    })
    assert.equal(action.exitCode, 0, action.stderr || action.stdout)

    const runtimeInfo = await runtime.info()
    const state = JSON.parse(await readFile(join(artifactsDirectory, runtimeInfo.id, "files/browser/editor-action-state.json"), "utf8")) as {
      dirty?: boolean
      serializedContent?: string
      serializedContentSha256?: string
    }
    assert.equal(state.dirty, false)
    assert.match(state.serializedContent ?? "", new RegExp(marker))
    assert.ok(state.serializedContentSha256)
    const persisted = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=echo get_post_field('post_content', ${postId});`],
      timeoutMs: 30_000,
    })
    assert.equal(persisted.exitCode, 0, persisted.stderr)
    assert.match(persisted.stdout, new RegExp(marker))
    assert.equal(state.serializedContentSha256, createHash("sha256").update(persisted.stdout).digest("hex"), "post-reload editor content must match the persisted WordPress content")
  } finally {
    await runtime.destroy()
    await rm(artifactsDirectory, { recursive: true, force: true })
  }
})
