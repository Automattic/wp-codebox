import assert from "node:assert/strict"
import { randomFillSync } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageRequire = createRequire(resolve(packageRoot, "package.json"))
const dependencyPackage = packageRequire.resolve("@php-wasm/stream-compression/package.json")

assert.ok(dependencyPackage.startsWith(`${packageRoot}${sep}node_modules${sep}`), "stream-compression must resolve from the Cloudflare package install")

const { decodeRemoteZip, encodeZip } = await import(pathToFileURL(resolve(dirname(dependencyPackage), "index.js")))
const payload = new Uint8Array(1024 * 1024 + 1)
randomFillSync(payload)
const archive = new Uint8Array(await new Response(encodeZip([new File([payload], "payload.txt", { lastModified: 0 })])).arrayBuffer())
const originalFetch = globalThis.fetch

globalThis.fetch = async (_input, init = {}) => {
  if (init.method === "HEAD") return new Response(null, { headers: { "Content-Length": String(archive.byteLength) } })
  const range = new Headers(init.headers).get("Range")
  assert.ok(range, "ranged ZIP decoding must request explicit byte ranges")
  const match = /^bytes=(\d+)-(\d+)$/.exec(range)
  assert.ok(match, `unexpected Range header: ${range}`)
  const start = Number(match[1])
  const end = Number(match[2])
  return new Response(archive.slice(start, end + 1), {
    status: 206,
    headers: { "Content-Range": `bytes ${start}-${end}/${archive.byteLength}` },
  })
}

try {
  const decoded = await decodeRemoteZip("https://example.test/archive.zip", () => true)
  const files = []
  for await (const file of decoded) files.push(file)
  assert.equal(files.length, 1)
  assert.equal(new TextDecoder().decode(files[0].path), "payload.txt")
  assert.deepEqual(files[0].bytes, payload, "the patched bounded range decoder must preserve file bytes")
} finally {
  globalThis.fetch = originalFetch
}
