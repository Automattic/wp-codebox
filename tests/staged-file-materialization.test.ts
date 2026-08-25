import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { materializePlaygroundStagedFiles } from "../packages/runtime-playground/src/mount-materialization.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-staged-file-materialization-"))

try {
  const text = Buffer.from(`{"fixture":"${"text-".repeat(60_000)}end"}\n`)
  const binary = Buffer.allocUnsafe(256 * 1024 + 137)
  for (let index = 0; index < binary.length; index++) binary[index] = (index * 31 + 255) % 256

  for (const [name, contents] of [["artifact.json", text], ["artifact.bin", binary]] as const) {
    const source = join(root, name)
    const target = `/workspace/${name}`
    await writeFile(source, contents)
    const sandboxFiles = new Map<string, Buffer>()

    const materialized = await materializePlaygroundStagedFiles({
      playground: {
        async run({ code }) {
          const payload = JSON.parse(JSON.parse(code.match(/\$payload = json_decode\((.*), true\);/)?.[1] ?? "\"{}\"")) as { target: string; contentsBase64?: string; append?: boolean }
          if (code.includes("wp-codebox/staged-file-write/v1")) {
            const chunk = Buffer.from(payload.contentsBase64 ?? "", "base64")
            const existing = payload.append ? sandboxFiles.get(payload.target) ?? Buffer.alloc(0) : Buffer.alloc(0)
            const next = Buffer.concat([existing, chunk])
            sandboxFiles.set(payload.target, next)
            // This simulates the mounted target overwriting its host source.
            await writeFile(source, next)
            return { text: JSON.stringify({ schema: "wp-codebox/staged-file-write/v1", written: chunk.length }) }
          }
          const actual = sandboxFiles.get(payload.target) ?? Buffer.alloc(0)
          return { text: JSON.stringify({ schema: "wp-codebox/staged-file-verification/v1", bytes: actual.length, sha256: createHash("sha256").update(actual).digest("hex") }) }
        },
      },
    } as never, [{ type: "file", source, target, mode: "readwrite" }])

    assert.equal(materialized, 1)
    assert.deepEqual(sandboxFiles.get(target), contents, `${name} is written across all chunks`)
    assert.deepEqual(await readFile(source), contents, `${name} remains byte-identical after mounted writes`)
  }

  const truncatedSource = join(root, "truncated.json")
  await writeFile(truncatedSource, text)
  await assert.rejects(materializePlaygroundStagedFiles({
    playground: {
      async run({ code }) {
        const payload = JSON.parse(JSON.parse(code.match(/\$payload = json_decode\((.*), true\);/)?.[1] ?? "\"{}\"")) as { contentsBase64?: string }
        if (code.includes("wp-codebox/staged-file-write/v1")) {
          return { text: JSON.stringify({ schema: "wp-codebox/staged-file-write/v1", written: Buffer.from(payload.contentsBase64 ?? "", "base64").length }) }
        }
        return { text: JSON.stringify({ schema: "wp-codebox/staged-file-verification/v1", bytes: 262144, sha256: "0".repeat(64) }) }
      },
    },
  } as never, [{ type: "file", source: truncatedSource, target: "/workspace/truncated.json", mode: "readwrite" }]), /expected \d+ bytes sha256 [a-f0-9]{64}, received 262144 bytes sha256 0{64}/)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("staged file materialization preserves large text and binary files")
