import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime, restoreRuntime } from "@automattic/wp-codebox-core"
import { verifyArtifactBundle } from "@automattic/wp-codebox-core/artifacts"
import { createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-snapshot-"))
const backend = createPlaygroundRuntimeBackend()

try {
  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "runtime-snapshot-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.run-php", "wordpress.wp-cli"],
        secrets: "none",
        approvals: "never",
      },
      artifactsDirectory,
    },
    backend,
  )

  try {
    await runtime.execute({ command: "wordpress.wp-cli", args: ["command=post create --post_type=page --post_status=publish --post_title='Snapshot Restore Smoke' --porcelain"] })
    await runtime.execute({ command: "wordpress.run-php", args: ["code=file_put_contents(WP_CONTENT_DIR . '/snapshot-smoke.txt', 'runtime snapshot file');"] })

    const snapshot = await runtime.snapshot()
    assert.equal(snapshot.schema, "wp-codebox/runtime-episode-snapshot/v1")
    assert.equal(snapshot.semantics, "runtime-state-artifact")
    assert.equal(snapshot.artifactRefs?.[0].kind, "runtime-snapshot-artifact")
    assert.match(snapshot.artifactRefs?.[0].digest?.value ?? "", /^[a-f0-9]{64}$/)
    assert.equal((snapshot.metadata.summary as { databaseTables?: number }).databaseTables! > 0, true)
    assert.equal((snapshot.metadata.summary as { wpContentFiles?: number }).wpContentFiles! > 0, true)

    const artifacts = await runtime.collectArtifacts({ includeRuntimeSnapshotBundles: true })
    const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
    const snapshotEntry = manifest.files.find((file: { path: string; kind: string }) => file.path === snapshot.artifactRefs?.[0].path && file.kind === "runtime-snapshot")
    assert.ok(snapshotEntry, "runtime artifact collection should include requested snapshot references")
    assert.equal((await verifyArtifactBundle(artifacts.directory)).valid, true)

    const restored = await restoreRuntime(snapshot, backend, {
      runtime: {
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "runtime-snapshot-restored", version: "7.0", blueprint: { steps: [] } },
        policy: {
          network: "deny",
          filesystem: "readwrite-mounts",
          commands: ["wordpress.run-php", "wordpress.wp-cli"],
          secrets: "none",
          approvals: "never",
        },
        artifactsDirectory,
      },
    })

    try {
      const title = await restored.execute({ command: "wordpress.run-php", args: ["code=$post = get_page_by_title('Snapshot Restore Smoke'); echo $post ? $post->post_title : '';"] })
      assert.equal(title.stdout.trim(), "Snapshot Restore Smoke")
      const file = await restored.execute({ command: "wordpress.run-php", args: ["code=echo file_get_contents(WP_CONTENT_DIR . '/snapshot-smoke.txt');"] })
      assert.equal(file.stdout.trim(), "runtime snapshot file")
    } finally {
      await restored.destroy()
    }

    await assert.rejects(
      () => restoreRuntime({ ...snapshot, semantics: "metadata-only", metadata: {} }, backend),
      /not a runtime-state artifact/,
    )
  } finally {
    await runtime.destroy()
  }
} finally {
  await rm(artifactsDirectory, { force: true, recursive: true })
}
