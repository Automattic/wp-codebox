import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime, verifyArtifactBundle } from "@automattic/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-state-bundle-capture-"))
const backend = createPlaygroundRuntimeBackend()

try {
  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "state-bundle-capture-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.run-php", "wordpress.wp-cli", "wordpress.capture-state-bundle"],
        secrets: "none",
        approvals: "never",
      },
      artifactsDirectory,
    },
    backend,
  )

  try {
    await runtime.execute({ command: "wordpress.wp-cli", args: ["command=post create --post_type=page --post_status=publish --post_title='State Bundle Capture Smoke' --porcelain"] })
    await runtime.execute({ command: "wordpress.run-php", args: ["code=file_put_contents(WP_CONTENT_DIR . '/state-bundle-smoke.txt', 'captured state bundle file');"] })

    const capture = await runtime.execute({ command: "wordpress.capture-state-bundle", args: ["label=after-generation"] })
    const captureOutput = JSON.parse(capture.stdout)
    assert.equal(captureOutput.schema, "wp-codebox/wordpress-state-bundle-capture/v1")
    assert.equal(captureOutput.status, "captured")
    assert.equal(captureOutput.replayStatus, "replayable-runtime-state")
    assert.equal(captureOutput.label, "after-generation")
    assert.equal(captureOutput.snapshot.semantics, "runtime-state-artifact")
    assert.equal(captureOutput.snapshot.artifactRefs[0].kind, "runtime-snapshot-artifact")
    assert.equal(captureOutput.summary.databaseTables > 0, true)
    assert.equal(captureOutput.summary.wpContentFiles > 0, true)

    const artifacts = await runtime.collectArtifacts({ includeRuntimeSnapshotBundles: true })
    const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
    const blueprintAfter = JSON.parse(await readFile(artifacts.blueprintAfterPath, "utf8"))
    const blueprintAfterNotes = JSON.parse(await readFile(artifacts.blueprintAfterNotesPath, "utf8"))

    assert.equal(manifest.files.some((file: { path?: string; kind?: string }) => file.path === captureOutput.snapshot.artifactRefs[0].path && file.kind === "runtime-snapshot"), true)
    assert.equal(manifest.files.some((file: { path?: string; kind?: string }) => file.path === "files/blueprint.after.partial.json" && file.kind === "blueprint-after-diagnostic"), true)
    assert.equal(blueprintAfter.steps[0].step, "runPHP")
    assert.match(blueprintAfter.steps[0].code, /State Bundle Capture Smoke/)
    assert.match(blueprintAfter.steps[0].code, /state-bundle-smoke\.txt/)
    assert.equal(blueprintAfterNotes.replayStatus, "replayable-runtime-state")
    assert.equal(blueprintAfterNotes.captured.databaseTables > 0, true)
    assert.equal(blueprintAfterNotes.captured.wpContentFiles > 0, true)
    assert.equal((await verifyArtifactBundle(artifacts.directory)).valid, true)

    console.log("Recipe state bundle capture smoke passed")
  } finally {
    await runtime.destroy()
  }
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
