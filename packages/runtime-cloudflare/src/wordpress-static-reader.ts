import wordpressStaticArtifactManifest from "../assets/wordpress-static-artifact.json" with { type: "json" }
import { wordpressStaticArchivePath, wordpressStaticContentType } from "./wordpress-runtime-corpus.js"
import { validateWordPressStaticArtifactManifest, type WordPressStaticArtifactManifest } from "./wordpress-static-artifact.js"

export const wordpressStaticArtifact = wordpressStaticArtifactManifest as WordPressStaticArtifactManifest
validateWordPressStaticArtifactManifest(wordpressStaticArtifact)

const wordpressStaticFiles = new Map(wordpressStaticArtifact.files.map((file) => [file.path, file]))

export async function servePublicWordPressStaticAsset(request: Request, bucket: R2Bucket): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const archivePath = wordpressStaticArchivePath(new URL(request.url).pathname)
  if (!archivePath) return null
  const file = wordpressStaticFiles.get(archivePath)
  if (!file) return null

  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheRequest = new Request(`https://wp-codebox-static.invalid/${wordpressStaticArtifact.blob.sha256}/${archivePath}`, { method: "GET" })
  if (cache) {
    try {
      const cached = await cache.match(cacheRequest)
      if (cached) return staticAssetResponse(cached, request.method === "HEAD", "edge")
    } catch {
      // R2 remains authoritative when the Worker cache is unavailable.
    }
  }

  const object = file.size ? await bucket.get(wordpressStaticArtifact.key, { range: { offset: file.offset, length: file.size } }) : undefined
  if (file.size && !object) return new Response("WordPress static artifact is unavailable.", { status: 503, headers: { "cache-control": "no-store" } })
  const bytes = object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array()
  if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.sha256) return new Response("WordPress static artifact integrity check failed.", { status: 502, headers: { "cache-control": "no-store" } })
  const response = staticAssetResponse(new Response(bytes, {
    headers: {
      "content-length": String(file.size),
      "content-type": wordpressStaticContentType(archivePath),
      etag: `"${file.sha256}"`,
    },
  }), request.method === "HEAD", "r2")
  if (request.method === "GET" && cache) {
    try {
      await cache.put(cacheRequest, response.clone())
    } catch {
      // R2 remains authoritative when the Worker cache is unavailable.
    }
  }
  return response
}

function staticAssetResponse(response: Response, head: boolean, source: "edge" | "r2"): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "public, max-age=31536000, immutable")
  headers.set("x-wp-codebox-static", `${source}-artifact`)
  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers })
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
