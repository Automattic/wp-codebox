import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
} finally {
  await rm(root, { recursive: true, force: true })
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
