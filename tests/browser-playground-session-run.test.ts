import assert from "node:assert/strict"

import { normalizeBrowserPlaygroundPreviewAccess, runBrowserPlaygroundSession } from "../packages/runtime-core/src/index.js"

const envelope = await runBrowserPlaygroundSession({ goal: "Render a browser preview." }, {
  createBrowserPlaygroundSession(input) {
    return {
      success: true,
      schema: "wp-codebox/browser-playground-session/v1",
      session: { id: "browser-run-contract" },
      recipe: { schema: "wp-codebox/workspace-recipe/v1" },
      runtime_access: {
        preview_url: "http://127.0.0.1:9400/",
        local_url: "http://127.0.0.1:9400/",
        lease: {
          schema: "wp-codebox/preview-lease/v1",
          local_url: "http://127.0.0.1:9400/",
          public_url: "https://review.example.test/",
          lease: { status: "active", provider: "preview-runtime" },
        },
      },
      task_input: input,
    }
  },
  executeBrowserPlaygroundSession(session) {
    assert.equal(session.schema, "wp-codebox/browser-playground-session/v1")
    return {
      success: true,
      browser_run_result: {
        schema: "wp-codebox/browser-run-result/v1",
        operation: "browser-session-recipe",
        status: "completed",
        success: true,
        result: { ok: true },
        artifactRefs: [{ kind: "browser-html", path: "files/browser/index.html", digest: { algorithm: "sha256", value: "abc" } }],
        diagnostics: [],
      },
      runtime_access: {
        public_url: "https://review.example.test/",
        local_url: "http://127.0.0.1:9400/",
        lease: {
          schema: "wp-codebox/preview-lease/v1",
          public_url: "https://review.example.test/",
          local_url: "http://127.0.0.1:9400/",
          lease: { status: "active", provider: "preview-runtime" },
        },
      },
      artifacts: [{ id: "artifact-bundle-sha256-abc" }],
      events: [{ type: "browser-run.completed" }],
      terminal_outcome: { terminal: true, status: "completed", success: true },
    }
  },
})

assert.equal(envelope.schema, "wp-codebox/browser-playground-session-run/v1")
assert.equal(envelope.success, true)
assert.equal(envelope.status, "completed")
assert.equal(envelope.browser_run_result.schema, "wp-codebox/browser-run-result/v1")
assert.equal(envelope.preview_access.schema, "wp-codebox/browser-playground-preview-access/v1")
assert.equal(envelope.preview_access.reviewer_url, "https://review.example.test/")
assert.equal(envelope.preview_access.public_url, "https://review.example.test/")
assert.equal(envelope.preview_access.local_url, "http://127.0.0.1:9400/")
assert.equal(envelope.preview_access.safe_for_review, true)
assert.equal(envelope.preview_access.reachability, "ready")
assert.equal(envelope.preview_access.lease?.schema, "wp-codebox/preview-lease/v1")
assert.deepEqual(envelope.artifacts, [{ id: "artifact-bundle-sha256-abc" }])
assert.deepEqual(envelope.events, [{ type: "browser-run.completed" }])
assert.deepEqual(envelope.terminal_outcome, { terminal: true, status: "completed", success: true })
assert.deepEqual(envelope.errors, [])

const localOnly = normalizeBrowserPlaygroundPreviewAccess({ local_url: "http://127.0.0.1:9400/" })
assert.equal(localOnly.reviewer_url, undefined)
assert.equal(localOnly.public_url, undefined)
assert.equal(localOnly.local_url, "http://127.0.0.1:9400/")
assert.equal(localOnly.safe_for_review, false)
assert.equal(localOnly.reachability, "local-only")

const previewPublicUrlOnly = normalizeBrowserPlaygroundPreviewAccess({
  runtime_access: {
    lease: {
      schema: "wp-codebox/preview-lease/v1",
      preview_public_url: "https://preview-public.example.test/",
      lease: { status: "active" },
    },
  },
})
assert.equal(previewPublicUrlOnly.reviewer_url, "https://preview-public.example.test/")
assert.equal(previewPublicUrlOnly.public_url, "https://preview-public.example.test/")
assert.equal(previewPublicUrlOnly.safe_for_review, true)
assert.equal(previewPublicUrlOnly.reachability, "ready")

const unsafeReviewerClaim = normalizeBrowserPlaygroundPreviewAccess({
  reviewer_url: "http://127.0.0.1:9400/",
  safe_for_review: true,
})
assert.equal(unsafeReviewerClaim.reviewer_url, "http://127.0.0.1:9400/")
assert.equal(unsafeReviewerClaim.safe_for_review, false)
assert.equal(unsafeReviewerClaim.reachability, "blocked")

console.log("browser playground session run contract ok")
