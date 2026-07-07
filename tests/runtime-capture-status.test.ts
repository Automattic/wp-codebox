import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { RUNTIME_CAPTURE_STATUS_SCHEMA, runtimeCaptureStatus } from "../packages/runtime-playground/src/public.js"
import * as playgroundPublicApi from "../packages/runtime-playground/src/public.js"
import type { CanonicalChangedFiles, WorkspacePatchArtifact } from "../packages/runtime-playground/src/artifacts.js"
import type { RuntimeSnapshotArtifact } from "../packages/runtime-playground/src/runtime-snapshot.js"

const snapshot: RuntimeSnapshotArtifact = {
  schema: "wp-codebox/wordpress-runtime-snapshot/v1",
  version: 1,
  id: "snapshot-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  compatibility: { backend: "wordpress-playground", wordpressVersion: "6.9", phpVersion: "8.3" },
  metadata: {
    runtime: {
      id: "runtime-1",
      backend: "wordpress-playground",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      environment: { kind: "wordpress", version: "6.9", phpVersion: "8.3" },
    },
    mounts: [],
    mountedInputs: [],
    activeTheme: "twentytwentyfive",
    activePlugins: ["example/example.php"],
    wpContentPath: "/wordpress/wp-content",
  },
  database: { tables: [{ name: "wp_options", createSql: "CREATE TABLE wp_options (option_id int)", rows: [], rowCount: 0 }] },
  files: [{ scope: "wp-content", path: "themes/twentytwentyfive/style.css", bytes: 12, sha256: "a".repeat(64), base64: "ZXhhbXBsZQ==" }],
  hashes: { database: { algorithm: "sha256", value: "b".repeat(64) }, files: { algorithm: "sha256", value: "c".repeat(64) } },
}

const cleanChangedFiles: CanonicalChangedFiles = { schema: "wp-codebox/changed-files/v1", files: [] }
const changedFiles: CanonicalChangedFiles = {
  schema: "wp-codebox/changed-files/v1",
  files: [
    { path: "/tmp/site/wp-content/plugins/example/plugin.php", status: "added", mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/example", relativePath: "plugin.php", patchPath: "files/diffs/mount-0.patch" },
    { path: "/tmp/site/wp-content/themes/theme/style.css", status: "modified", mountIndex: 1, mountTarget: "/wordpress/wp-content/themes/theme", relativePath: "style.css", patchPath: "files/diffs/mount-1.patch" },
    { path: "/tmp/site/wp-content/themes/theme/old.css", status: "deleted", mountIndex: 1, mountTarget: "/wordpress/wp-content/themes/theme", relativePath: "old.css", patchPath: "files/diffs/mount-1.patch" },
  ],
}

const clean = runtimeCaptureStatus({ snapshot, changedFiles: cleanChangedFiles })
assert.equal(clean.schema, RUNTIME_CAPTURE_STATUS_SCHEMA)
assert.equal(clean.version, 1)
assert.equal(clean.state, "clean")
assert.equal(clean.resources?.databaseTables, 1)
assert.equal(clean.resources?.wpContentFiles, 1)
assert.deepEqual(clean.changes, { files: 0, added: 0, modified: 0, deleted: 0 })
assert.equal(clean.snapshotDigest?.algorithm, "sha256")
assert.equal(clean.captureDigest?.algorithm, "sha256")

const changed = runtimeCaptureStatus({ snapshot, changedFiles })
assert.equal(changed.state, "changed")
assert.deepEqual(changed.changes, { files: 3, added: 1, modified: 1, deleted: 1 })

const unknown = runtimeCaptureStatus({ snapshot, limitations: ["No comparable baseline was provided."] })
assert.equal(unknown.state, "unknown")
assert.deepEqual(unknown.limitations, ["No comparable baseline was provided."])
assert.equal(unknown.resources?.databaseTables, 1)
assert.equal(unknown.snapshotDigest?.value, unknown.captureDigest?.value)

const workspacePatch: Pick<WorkspacePatchArtifact, "summary" | "contentDigest" | "workspaces"> = {
  summary: { changed: true, files: 2, added: 1, modified: 1, deleted: 0 },
  contentDigest: { algorithm: "sha256", inputs: ["files/changed-files.json", "files/patch.diff"], value: "d".repeat(64) },
  workspaces: [
    { mountIndex: 0, target: "/wordpress/wp-content/plugins/example", source: "/tmp/example", status: "changed", changed: true, patch: "files/diffs/mount-0.patch" },
  ],
}
const workspaceChanged = runtimeCaptureStatus({ workspacePatch })
assert.equal(workspaceChanged.state, "changed")
assert.equal(workspaceChanged.captureDigest?.value, "d".repeat(64))
assert.deepEqual(workspaceChanged.changes, { files: 2, added: 1, modified: 1, deleted: 0, workspaces: 1 })

const unsupported = runtimeCaptureStatus({ supported: false, diagnostics: [{ severity: "warning", code: "runtime-capture-unavailable", message: "Runtime capture is not available for this backend." }] })
assert.equal(unsupported.state, "unsupported")
assert.deepEqual(unsupported.diagnostics, [{ severity: "warning", code: "runtime-capture-unavailable", message: "Runtime capture is not available for this backend." }])

assert.equal(typeof playgroundPublicApi.runtimeCaptureStatus, "function")
assert.equal(playgroundPublicApi.RUNTIME_CAPTURE_STATUS_SCHEMA, "wp-codebox/runtime-capture-status/v1")
assert.equal("buildRuntimeCaptureStatusForWordPressBuild" in playgroundPublicApi, false)

for (const path of [
  "packages/runtime-playground/src/runtime-capture-status.ts",
  "packages/runtime-playground/src/public.ts",
  "packages/runtime-playground/src/index.ts",
]) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8")
  assert.doesNotMatch(source, /WP Build|WordPress Build|paid|free|export gating/i, `${path} must stay product-agnostic`)
}

console.log("runtime capture status ok")
