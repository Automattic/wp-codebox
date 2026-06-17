import assert from "node:assert/strict"
import type { ArtifactPreview, ExecutionResult } from "../packages/runtime-core/src/index.js"
import { firstCommandWordPressAdminAuthRequirement } from "../packages/runtime-playground/src/command-auth-requirements.js"
import { heldPreviewWithExternalAccessBlockers } from "../packages/runtime-playground/src/artifact-bundle-builder.js"
import { previewReviewerAccess } from "../packages/runtime-playground/src/preview-reviewer-access.js"

const heldPreview: ArtifactPreview = {
  url: "http://127.0.0.1:9400/",
  localUrl: "http://127.0.0.1:9400/",
  status: "available",
  lifecycle: "held-after-run",
  source: "live-playground",
  createdAt: "2026-06-17T00:00:00.000Z",
  expiresAt: "2026-06-17T00:05:00.000Z",
  holdSeconds: 300,
}

assert.equal(firstCommandWordPressAdminAuthRequirement([command("wordpress.browser-probe", ["url=/", "auth=wordpress-admin", "auth-user-id=2"])])?.userId, 2)
assert.equal(firstCommandWordPressAdminAuthRequirement([command("wordpress.editor-open", ["target=site"])])?.userId, 1)
assert.equal(firstCommandWordPressAdminAuthRequirement([command("wordpress.editor-actions", ["url=/wp-admin/site-editor.php", "steps-json=[]"])])?.redirectUrl, "/wp-admin/site-editor.php")
assert.equal(firstCommandWordPressAdminAuthRequirement([command("wordpress.browser-probe", ["url=/"])])?.command.command, undefined)

const blockedEditorPreview = heldPreviewWithExternalAccessBlockers(heldPreview, [command("wordpress.editor-open", ["target=site"])])
assert.equal(blockedEditorPreview?.blockers?.[0]?.code, "external-wordpress-admin-auth-unavailable")
assert.equal(blockedEditorPreview?.reviewerAccess?.status, "blocked")
assert.equal(blockedEditorPreview?.reviewerAccess?.outcome, "auth-required")

const directPublicPreview = heldPreviewWithExternalAccessBlockers({ ...heldPreview, url: "https://preview.example.test/", publicUrl: "https://preview.example.test/" }, [])
assert.equal(directPublicPreview?.reviewerAccess?.outcome, undefined)
assert.equal(previewReviewerAccess(directPublicPreview).outcome, "public")
assert.equal(previewReviewerAccess(heldPreview).outcome, "local")

function command(command: string, args: string[]): ExecutionResult {
  return {
    id: `command-${command}`,
    command,
    args,
    startedAt: "2026-06-17T00:00:00.000Z",
    completedAt: "2026-06-17T00:00:01.000Z",
    exitCode: 0,
    stdout: "",
    stderr: "",
  }
}
