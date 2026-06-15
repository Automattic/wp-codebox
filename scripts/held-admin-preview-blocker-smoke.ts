import assert from "node:assert/strict"
import type { ArtifactPreview, ExecutionResult } from "@automattic/wp-codebox-core"
import { heldPreviewWithExternalAccessBlockers } from "../packages/runtime-playground/src/artifact-bundle-builder.js"

const heldPreview: ArtifactPreview = {
  url: "http://127.0.0.1:48631/wp-admin/post.php?post=24117035&action=edit",
  status: "available",
  lifecycle: "held-after-run",
  source: "live-playground",
  createdAt: "2026-06-15T00:00:00.000Z",
  expiresAt: "2026-06-15T00:15:00.000Z",
  holdSeconds: 900,
}

const command: ExecutionResult = {
  id: "execution-1",
  command: "wordpress.browser-actions",
  args: [
    "url=/wp-admin/post.php?post=24117035&action=edit",
    "auth=wordpress-admin",
    "steps-json=[]",
  ],
  exitCode: 0,
  stdout: "{}",
  stderr: "",
  startedAt: "2026-06-15T00:00:01.000Z",
  finishedAt: "2026-06-15T00:00:02.000Z",
}

const blockedPreview = heldPreviewWithExternalAccessBlockers(heldPreview, [command])
assert.equal(blockedPreview?.blockers?.length, 1)
assert.equal(blockedPreview.blockers[0].schema, "wp-codebox/preview-blocker/v1")
assert.equal(blockedPreview.blockers[0].kind, "unsupported-preview")
assert.equal(blockedPreview.blockers[0].code, "external-wordpress-admin-auth-unavailable")
assert.equal(blockedPreview.blockers[0].reviewerSafe, false)
assert.equal(blockedPreview.blockers[0].retryable, false)
assert.deepEqual(blockedPreview.blockers[0].evidence, { command: "wordpress.browser-actions", auth: "wordpress-admin" })

const bootstrapPreview = heldPreviewWithExternalAccessBlockers({
  ...heldPreview,
  reviewerAuth: {
    schema: "wp-codebox/preview-reviewer-auth/v1",
    kind: "reviewer-auth-bootstrap",
    auth: "wordpress-admin",
    reviewerSafe: true,
    url: "http://127.0.0.1:48631/_wp-codebox/reviewer-auth/bootstrap?token=redacted-smoke-token",
    targetPath: "/wp-admin/post.php?post=24117035&action=edit",
    expiresAt: "2026-06-15T00:15:00.000Z",
    holdSeconds: 900,
    userId: 1,
    scope: {
      runtimeId: "runtime-smoke",
      origin: "http://127.0.0.1:48631",
    },
  },
}, [command])
assert.equal(bootstrapPreview?.blockers, undefined)
assert.equal(bootstrapPreview?.reviewerAuth?.reviewerSafe, true)
assert.equal(bootstrapPreview?.reviewerAuth?.targetPath, "/wp-admin/post.php?post=24117035&action=edit")

const publicPreview = heldPreviewWithExternalAccessBlockers(heldPreview, [{ ...command, args: ["url=/"] }])
assert.equal(publicPreview?.blockers, undefined)

const expiredPreview = heldPreviewWithExternalAccessBlockers({ ...heldPreview, lifecycle: "destroyed-on-completion", status: "expired-on-completion", holdSeconds: undefined }, [command])
assert.equal(expiredPreview?.blockers, undefined)

console.log("Held admin preview blocker/bootstrap smoke passed")
