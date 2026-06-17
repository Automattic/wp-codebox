import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { writeReplayExportPackage } from "../packages/runtime-playground/src/replayable-wordpress-site-bundle.ts"
import type { RuntimeSnapshotArtifact } from "../packages/runtime-playground/src/runtime-snapshot.ts"

const snapshot: RuntimeSnapshotArtifact = {
  schema: "wp-codebox/wordpress-runtime-snapshot/v1",
  version: 1,
  id: "snapshot-smoke",
  createdAt: "2026-06-15T00:00:00.000Z",
  compatibility: {
    backend: "wordpress-playground",
    wordpressVersion: "latest",
    phpVersion: "8.3.31",
  },
  metadata: {
    runtime: {
      id: "runtime-smoke",
      backend: "wordpress-playground",
      status: "destroyed",
      createdAt: "2026-06-15T00:00:00.000Z",
      environment: {
        kind: "wordpress",
        name: "runtime-smoke",
        version: "latest",
      },
    },
    mounts: [],
    mountedInputs: [],
    activeTheme: "twentytwentyfour",
    activePlugins: [],
    wpContentPath: "/wordpress/wp-content",
  },
  database: { tables: [] },
  files: [
    {
      scope: "wp-content",
      path: "smoke.txt",
      bytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      base64: "aGVsbG8=",
    },
  ],
  hashes: {
    database: { algorithm: "sha256", value: "database-smoke" },
    files: { algorithm: "sha256", value: "files-smoke" },
  },
}

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-replay-export-manifest-"))

try {
  await writeReplayExportPackage(snapshot, {
    directory,
    createdAt: "2026-06-15T00:00:00.000Z",
    id: "replay-export-manifest-integrity-smoke",
  })

  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { files: Array<{ path: string }> }
  const manifestPaths = manifest.files.map((file) => file.path).sort()
  const writtenPaths = (await listFiles(directory)).sort()

  assert.deepEqual(writtenPaths, manifestPaths)
  assert.deepEqual(new Set(manifestPaths).size, manifestPaths.length)

  for (const file of manifest.files) {
    await readFile(join(directory, file.path))
  }

  console.log("replay-export-manifest-integrity-smoke passed")
} finally {
  await rm(directory, { recursive: true, force: true })
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  await collectFiles(directory, directory, files)
  return files
}

async function collectFiles(root: string, directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(root, path, files)
    } else if (entry.isFile()) {
      files.push(relative(root, path).replace(/\\/g, "/"))
    }
  }
}
