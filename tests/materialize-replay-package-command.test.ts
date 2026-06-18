import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeMaterializationResultEnvelope, requireCompletedMaterializationResultEnvelope } from "../packages/runtime-core/src/index.js"
import { runMaterializeReplayPackageCommand } from "../packages/cli/src/commands/replay-package.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-materialization-result-"))

try {
  const snapshotPath = join(root, "not-a-snapshot.json")
  await writeFile(snapshotPath, JSON.stringify({ schema: "example/not-runtime-snapshot" }))

  const { code, stdout } = await captureStdout(() => runMaterializeReplayPackageCommand([
    "--snapshot",
    snapshotPath,
    "--output",
    join(root, "package"),
    "--json",
  ]))
  const envelope = JSON.parse(stdout)

  assert.equal(code, 1)
  assert.equal(envelope.schema, "wp-codebox/materialization-result/v1")
  assert.equal(envelope.task, "materialize-replay-package")
  assert.equal(envelope.status, "failed")
  assert.equal(envelope.success, false)
  assert.equal(envelope.phases[0].phase, "wordpress-replay-package-materialization")
  assert.equal(envelope.phases[0].status, "failed")
  assert.match(envelope.error.message, /not a wp-codebox\/wordpress-runtime-snapshot\/v1/)
  assert.equal(envelope.diagnostics[0].severity, "error")

  const normalizedFailure = normalizeMaterializationResultEnvelope({ response: { success: false, task: "example", error: { message: "failed" } } })
  assert.equal(normalizedFailure.status, "failed")
  assert.throws(() => requireCompletedMaterializationResultEnvelope(normalizedFailure), /failed/)

  const validSnapshotPath = join(root, "runtime-snapshot.json")
  const outputDirectory = join(root, "valid-package")
  await writeFile(validSnapshotPath, JSON.stringify(runtimeSnapshotFixture(), null, 2))

  const valid = await captureStdout(() => runMaterializeReplayPackageCommand([
    "--snapshot",
    validSnapshotPath,
    "--output",
    outputDirectory,
    "--json",
  ]))
  const successEnvelope = JSON.parse(valid.stdout)
  const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"))

  assert.equal(valid.code, 0)
  assert.equal(successEnvelope.status, "completed")
  assert.equal(manifest.files.length, 5)
  for (const path of ["manifest.json", "blueprint.after.json", "blueprint.zip", "files/runtime-snapshot.json", "blueprint.after-notes.json"]) {
    const file = manifest.files.find((entry: { path: string }) => entry.path === path)
    assert.ok(file, `manifest includes ${path}`)
    assert.match(file.sha256.value, /^[a-f0-9]{64}$/)
    assert.notEqual(file.sha256.value, "0".repeat(64))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

function runtimeSnapshotFixture() {
  return {
    schema: "wp-codebox/wordpress-runtime-snapshot/v1",
    version: 1,
    capturedAt: "2026-01-01T00:00:00.000Z",
    compatibility: {
      backend: "wordpress-playground",
      wordpressVersion: "latest",
      phpVersion: "8.2",
    },
    database: {
      format: "sqlite-sql",
      tables: [],
    },
    files: [],
    metadata: {},
  }
}

async function captureStdout(callback: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  let stdout = ""
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString()

    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }

    return true
  }) as typeof process.stdout.write

  try {
    return { code: await callback(), stdout }
  } finally {
    process.stdout.write = write
  }
}
