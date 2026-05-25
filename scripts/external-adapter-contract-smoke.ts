import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface ArtifactBundlePayload {
  artifact_id: string
  artifact: {
    id: string
    content_digest: string
    changed_files: {
      schema: "wp-codebox/changed-files/v1"
      files: Array<{
        path: string
        status: string
        mountTarget: string
        relativePath: string
      }>
    }
    metadata: {
      provenance: {
        mounts: Array<{
          target: string
          metadata?: Record<string, unknown>
        }>
      }
    }
    review: {
      schema: "wp-codebox/artifact-review/v1"
      evidence: {
        artifactContentDigest: string
        patch: string
      }
    }
  }
  approved_files: string[]
  patch: string
  patch_sha256: string
  artifact_content_digest: string
}

interface ExternalApplyRecord {
  schema: "wp-codebox/external-apply-record/v1"
  adapter: {
    name: string
    version: string
  }
  artifact: {
    id: string
    content_digest: string
    patch_sha256: string
    approved_files: string[]
  }
  approval: {
    approver: string
    approved_at: string
  }
  target: {
    repo: string
    branch: string
    commit: string
    files: string[]
  }
  result: {
    status: "pr-opened"
    pr_url: string
    author: string
  }
}

function artifactContentDigest(changedFilesJson: string, patch: string): string {
  return createHash("sha256")
    .update("wp-codebox/artifact-content/v1\n")
    .update("files/changed-files.json\n")
    .update(changedFilesJson)
    .update("\nfiles/patch.diff\n")
    .update(patch)
    .digest("hex")
}

function externalParentControlPlaneApply(payload: ArtifactBundlePayload): ExternalApplyRecord {
  assert.equal(payload.artifact_id, payload.artifact.id)
  assert.equal(payload.artifact_content_digest, payload.artifact.content_digest)
  assert.equal(payload.artifact.review.evidence.artifactContentDigest, payload.artifact_content_digest)
  assert.equal(createHash("sha256").update(payload.patch).digest("hex"), payload.patch_sha256)

  const changedPaths = new Set(payload.artifact.changed_files.files.map((file) => file.path))
  for (const approvedFile of payload.approved_files) {
    assert.equal(changedPaths.has(approvedFile), true, `${approvedFile} must be present in changed-files.json`)
  }

  const editableMount = payload.artifact.metadata.provenance.mounts.find(
    (mount) => mount.target === "/wordpress/wp-content/plugins/example" && mount.metadata?.editable === true,
  )
  assert.ok(editableMount, "artifact provenance must carry opaque mount metadata for the external adapter")

  const repo = editableMount.metadata?.repo
  const branch = editableMount.metadata?.branch
  const commit = editableMount.metadata?.commit
  assert.equal(typeof repo, "string")
  assert.equal(typeof branch, "string")
  assert.equal(typeof commit, "string")

  return {
    schema: "wp-codebox/external-apply-record/v1",
    adapter: {
      name: "fixture-parent-control-plane",
      version: "2026-05-25",
    },
    artifact: {
      id: payload.artifact_id,
      content_digest: payload.artifact_content_digest,
      patch_sha256: payload.patch_sha256,
      approved_files: payload.approved_files,
    },
    approval: {
      approver: "site-user:1",
      approved_at: "2026-05-25T00:00:00.000Z",
    },
    target: {
      repo,
      branch,
      commit,
      files: payload.approved_files.map((path) => path.replace("/wordpress/wp-content/plugins/example/", "")),
    },
    result: {
      status: "pr-opened",
      pr_url: "https://github.com/example/example-plugin/pull/123",
      author: "wp-codebox-bot",
    },
  }
}

const root = await mkdtemp(join(tmpdir(), "wp-codebox-external-adapter-"))

try {
  const changedFiles = {
    schema: "wp-codebox/changed-files/v1" as const,
    files: [
      {
        path: "/wordpress/wp-content/plugins/example/generated.txt",
        status: "added",
        mountTarget: "/wordpress/wp-content/plugins/example",
        relativePath: "generated.txt",
      },
    ],
  }
  const patch = "diff --git a/generated.txt b/generated.txt\nnew file mode 100644\n--- /dev/null\n+++ b/generated.txt\n@@ -0,0 +1 @@\n+cooked\n"
  const changedFilesJson = `${JSON.stringify(changedFiles, null, 2)}\n`
  const digest = artifactContentDigest(changedFilesJson, patch)
  const artifactId = `artifact-bundle-sha256-${digest}`
  const patchSha256 = createHash("sha256").update(patch).digest("hex")

  const artifact = {
    id: artifactId,
    content_digest: digest,
    changed_files: changedFiles,
    metadata: {
      provenance: {
        mounts: [
          {
            target: "/wordpress/wp-content/plugins/example",
            metadata: {
              editable: true,
              repo: "example/example-plugin",
              branch: "codebox/apply-generated-file",
              commit: "abc1234",
            },
          },
        ],
      },
    },
    review: {
      schema: "wp-codebox/artifact-review/v1" as const,
      evidence: {
        artifactContentDigest: digest,
        patch: "files/patch.diff",
      },
    },
  }

  const payload: ArtifactBundlePayload = {
    artifact_id: artifactId,
    artifact,
    approved_files: ["/wordpress/wp-content/plugins/example/generated.txt"],
    patch,
    patch_sha256: patchSha256,
    artifact_content_digest: digest,
  }

  const record = externalParentControlPlaneApply(payload)
  const recordPath = join(root, "external-apply-record.json")
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)

  const persisted = JSON.parse(await readFile(recordPath, "utf8")) as ExternalApplyRecord
  assert.equal(persisted.adapter.name, "fixture-parent-control-plane")
  assert.equal(persisted.approval.approver, "site-user:1")
  assert.equal(persisted.result.pr_url, "https://github.com/example/example-plugin/pull/123")
  assert.equal(persisted.result.author, "wp-codebox-bot")
  assert.equal(persisted.target.branch, "codebox/apply-generated-file")
  assert.equal(persisted.target.commit, "abc1234")
  assert.equal(persisted.artifact.content_digest, digest)
  assert.equal(JSON.stringify(persisted).includes(patch), false, "external record must not persist the raw patch body")

  console.log(`OK external adapter contract smoke wrote ${recordPath}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
