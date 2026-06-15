import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyArtifactBundle } from "@automattic/wp-codebox-core/artifacts"
import { writeReplayableWordPressSiteBundle, type RuntimeSnapshotArtifact } from "../packages/runtime-playground/src/index.js"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-replayable-site-"))

try {
  const bundleDirectory = join(workspace, "bundle")
  const snapshot = snapshotFixture()
  const bundle = await writeReplayableWordPressSiteBundle(snapshot, {
    directory: bundleDirectory,
    createdAt: "2026-06-08T00:00:00.000Z",
    source: { kind: "external-wordpress-site", policy: "caller-approved" },
    landingPage: "/sample-page/",
  })

  const verification = await verifyArtifactBundle(bundleDirectory)
  assert.equal(verification.valid, true)
  assert.deepEqual(verification.violations, [])

  const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"))
  assert.equal(manifest.schema, "wp-codebox/replayable-wordpress-site/v1")
  assert.equal(manifest.replayableWordPressSite.blueprintPath, "blueprint.json")
  assert.equal(manifest.replayableWordPressSite.snapshotPath, "files/runtime-snapshot.json")
  assert.equal(manifest.replayableWordPressSite.replayStatus, "replayable-runtime-state")
  assert.equal(manifest.contentDigest.value, bundle.contentDigest)
  assert.equal(manifest.files.every((file: { sha256?: { value?: string } }) => /^[a-f0-9]{64}$/.test(file.sha256?.value ?? "")), true)

  const blueprint = JSON.parse(await readFile(bundle.blueprintPath, "utf8"))
  assert.equal(blueprint.landingPage, "/sample-page/")
  assert.equal(blueprint.preferredVersions.wp, "6.8.1")
  assert.equal(blueprint.steps[0].step, "runPHP")
  assert.match(blueprint.steps[0].code, /wp-codebox\/wordpress-runtime-snapshot\/v1/)
  assert.match(blueprint.steps[0].code, /Sample Page/)

  const limitations = JSON.parse(await readFile(bundle.limitationsPath, "utf8"))
  assert.equal(limitations.schema, "wp-codebox/replayable-wordpress-site-limitations/v1")
  assert.equal(limitations.captured.databaseTables, 1)
  assert.equal(limitations.captured.wpContentFiles, 1)
  assert.equal(limitations.source.kind, "external-wordpress-site")

  console.log("Replayable WordPress site bundle smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

function snapshotFixture(): RuntimeSnapshotArtifact {
  return {
    schema: "wp-codebox/wordpress-runtime-snapshot/v1",
    version: 1,
    id: "snapshot-fixture",
    createdAt: "2026-06-08T00:00:00.000Z",
    compatibility: {
      backend: "wordpress-playground",
      wordpressVersion: "6.8.1",
      phpVersion: "8.3",
    },
    metadata: {
      runtime: {
        id: "external-source-fixture",
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "external-source-fixture", version: "6.8.1" },
        createdAt: "2026-06-08T00:00:00.000Z",
        status: "destroyed",
      },
      mounts: [],
      mountedInputs: [],
      activeTheme: "twentytwentyfive",
      activePlugins: ["hello.php"],
      wpContentPath: "/example/wp-content",
    },
    database: {
      tables: [
        {
          name: "wp_posts",
          createSql: "CREATE TABLE wp_posts (ID bigint unsigned NOT NULL, post_title text NOT NULL)",
          rows: [{ ID: 1, post_title: "Sample Page" }],
          rowCount: 1,
        },
      ],
    },
    files: [
      {
        scope: "wp-content",
        path: "themes/twentytwentyfive/style.css",
        bytes: 20,
        sha256: "0".repeat(64),
        base64: Buffer.from("/* fixture theme */\n").toString("base64"),
      },
    ],
    hashes: {
      database: { algorithm: "sha256", value: "1".repeat(64) },
      files: { algorithm: "sha256", value: "2".repeat(64) },
    },
  }
}
