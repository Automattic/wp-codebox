import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { PUBLISHED_PAGE_SCHEMA, PUBLISHED_REVISION_SCHEMA, publishedPageObjectKey } from "../packages/runtime-cloudflare/src/published-reader.js"
import { servePublicPublication } from "../packages/runtime-cloudflare/src/public-reader.js"
import { DEFAULT_SITE_CONTEXT, siteStorageKeys } from "../packages/runtime-cloudflare/src/site-context.js"

const canonicalRevision = "11111111-1111-4111-8111-111111111111"
const publicationRevision = "22222222-2222-4222-8222-222222222222"

function bucket(objects: Map<string, string | Uint8Array>) {
  return {
    async get(key: string) {
      const value = objects.get(key)
      if (value === undefined) return null
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
      return {
        size: bytes.byteLength,
        etag: "test",
        httpMetadata: { contentType: "text/css" },
        text: async () => new TextDecoder().decode(bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
        arrayBuffer: async () => bytes.slice().buffer,
      }
    },
  }
}

async function completePublication(route = "/") {
  const objectKey = await publishedPageObjectKey(canonicalRevision, route, DEFAULT_SITE_CONTEXT)
  return { schema: PUBLISHED_REVISION_SCHEMA, state: "complete", revision: publicationRevision, canonicalRevision, canonicalVersion: 9, publishedAt: "2026-07-26T00:00:00.000Z", routes: [{ route, objectKey, canonicalRevision }] }
}

test("public reader serves complete immutable routes without mutation dependencies", async () => {
  const publication = await completePublication()
  const objectKey = publication.routes[0].objectKey
  const objects = new Map<string, string | Uint8Array>([
    [siteStorageKeys(DEFAULT_SITE_CONTEXT).publishedCurrent, JSON.stringify(publication)],
    [objectKey, JSON.stringify({ schema: PUBLISHED_PAGE_SCHEMA, canonicalRevision, route: "/", status: 200, statusText: "OK", headers: [["content-type", "text/html"]], body: "<h1>Published</h1>" })],
  ])
  const response = await servePublicPublication(new Request("https://wp-codebox-cloudflare-runtime.chubes.workers.dev/"), bucket(objects) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "<h1>Published</h1>")
  assert.equal(response.headers.get("x-wp-codebox-publication-revision"), publicationRevision)
  assert.match(response.headers.get("cache-control")!, /s-maxage=60/)
})

test("public reader bounds missing and incomplete publications without dynamic fallback", async () => {
  const empty = await servePublicPublication(new Request("https://reader.example/missing"), bucket(new Map()) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(empty.status, 503)
  const publication = await completePublication()
  const missing = await servePublicPublication(new Request("https://reader.example/missing"), bucket(new Map([[siteStorageKeys(DEFAULT_SITE_CONTEXT).publishedCurrent, JSON.stringify(publication)]])) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(missing.status, 404)
  const incomplete = { ...publication, state: "building" }
  const invalid = await servePublicPublication(new Request("https://reader.example/"), bucket(new Map([[siteStorageKeys(DEFAULT_SITE_CONTEXT).publishedCurrent, JSON.stringify(incomplete)]])) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(invalid.status, 503)
  assert.equal(invalid.headers.get("x-wp-codebox-public-reader"), "bounded")

  const emptyComplete = { ...publication, routes: [] }
  const emptyCompleteResponse = await servePublicPublication(new Request("https://reader.example/"), bucket(new Map([[siteStorageKeys(DEFAULT_SITE_CONTEXT).publishedCurrent, JSON.stringify(emptyComplete)]])) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(emptyCompleteResponse.status, 503)

  const legacy = { ...publication, schema: "wp-codebox/published-revision/v3" }
  const legacyResponse = await servePublicPublication(new Request("https://reader.example/"), bucket(new Map([[siteStorageKeys(DEFAULT_SITE_CONTEXT).publishedCurrent, JSON.stringify(legacy)]])) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(legacyResponse.status, 503)
})

test("public reader serves publication-bound assets with revision-safe identity", async () => {
  const publication = await completePublication()
  const css = new TextEncoder().encode("body { color: green; }")
  const sha256 = createHash("sha256").update(css).digest("hex")
  const assetKey = `${siteStorageKeys(DEFAULT_SITE_CONTEXT).wpContentObjectPrefix}/${sha256}`
  const manifestKey = `${siteStorageKeys(DEFAULT_SITE_CONTEXT).markdownRevisionPrefix}/${canonicalRevision}.json`
  const objects = new Map<string, string | Uint8Array>([
    [siteStorageKeys(DEFAULT_SITE_CONTEXT).publishedCurrent, JSON.stringify(publication)],
    [manifestKey, JSON.stringify({ revision: canonicalRevision, wpContent: [{ path: "themes/example/style.css", objectKey: assetKey, sha256, size: css.byteLength }] })],
    [assetKey, css],
  ])
  const response = await servePublicPublication(new Request("https://reader.example/wp-content/themes/example/style.css"), bucket(objects) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "body { color: green; }")
  assert.equal(response.headers.get("x-wp-codebox-publication-asset"), "r2")
  assert.equal(response.headers.get("x-wp-codebox-publication-revision"), publicationRevision)
})

test("public reader serves WordPress core assets required by published HTML", async () => {
  const response = await servePublicPublication(new Request("https://reader.example/wp-includes/js/swfobject.js"), bucket(new Map()) as never, DEFAULT_SITE_CONTEXT)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8")
  assert.equal(response.headers.get("x-wp-codebox-static"), "r2-artifact")
})
