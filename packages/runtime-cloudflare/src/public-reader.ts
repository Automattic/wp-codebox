import { canonicalPublicRoute, MAX_PUBLISHED_PAGE_BYTES, MAX_PUBLISHED_REVISION_BYTES, PUBLISHED_PAGE_SCHEMA, validateCompletePublishedRevision } from "./published-reader.js"
import { parseSiteContexts, previewDomain, resolvePreviewSiteContextFromRequest, resolveSiteContextFromRequest, siteStorageKeys, type SiteContext } from "./site-context.js"
import { isCanonicalWpContentPath, validateWpContentManifestFiles } from "./wp-content-persistence.js"
import { validateUploadManifestFiles } from "./upload-persistence.js"
import { servePublicWordPressStaticAsset } from "./wordpress-static-reader.js"
import { runtimeArchiveComponentOwnedWpContentPaths } from "../../runtime-core/src/runtime-archive-component.js"
import { validateRuntimeArchiveArtifactManifest, type RuntimeArchiveArtifactManifest } from "./runtime-archive-artifact.js"
import websiteImporterArtifactManifest from "../assets/website-importer-artifact.json" with { type: "json" }

const websiteImporterArtifact = websiteImporterArtifactManifest as RuntimeArchiveArtifactManifest
validateRuntimeArchiveArtifactManifest(websiteImporterArtifact)
if (!websiteImporterArtifact.component) throw new Error("Website importer runtime artifact is missing its component descriptor.")
const WEBSITE_IMPORTER_OWNED_WP_CONTENT_PATHS = runtimeArchiveComponentOwnedWpContentPaths(websiteImporterArtifact.component)

export interface PublicReaderEnv {
  WORDPRESS_STATE_BUCKET: R2Bucket
  WORDPRESS_SITE_CONTEXTS?: string
  WORDPRESS_PREVIEW_DOMAIN?: string
  WORDPRESS_PREVIEW_HOST_SECRET?: string
}

interface PageSnapshot {
  schema: typeof PUBLISHED_PAGE_SCHEMA
  canonicalRevision: string
  route: string
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

interface PublicationAsset {
  path: string
  objectKey: string
  sha256: string
  size: number
}

/**
 * This is intentionally a complete request boundary: it has no mutation
 * fallback, so an absent or incomplete publication cannot boot WordPress.
 */
export function createCloudflarePublicReader<Env extends PublicReaderEnv>() {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let site: SiteContext
      try {
        const contexts = parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS)
        try {
          site = resolveSiteContextFromRequest(request, contexts)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Unknown site hostname.") throw error
          site = await resolvePreviewSiteContextFromRequest(request, previewDomain(env.WORDPRESS_PREVIEW_DOMAIN, env.WORDPRESS_PREVIEW_HOST_SECRET))
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Unknown site hostname.") return response("Unknown site hostname.", 421)
        return response("Public publication configuration is invalid.", 503)
      }
      return servePublicPublication(request, env.WORDPRESS_STATE_BUCKET, site)
    },
  }
}

export async function servePublicPublication(request: Request, bucket: R2Bucket, site: SiteContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return response("Public publication accepts GET and HEAD only.", 405)
  if (request.headers.has("authorization") || request.headers.has("cookie") || new URL(request.url).searchParams.has("phase")) return response("Dynamic WordPress requests are unavailable from the public reader.", 404)
  const staticAsset = await servePublicWordPressStaticAsset(request, bucket)
  if (staticAsset) return staticAsset
  const route = canonicalPublicRoute(request)
  let publication
  try {
    const current = await bucket.get(siteStorageKeys(site).publishedCurrent)
    if (!current) return response("Public publication is not ready.", 503)
    if (current.size > MAX_PUBLISHED_REVISION_BYTES) return response("Public publication is incomplete.", 503)
    publication = validateCompletePublishedRevision(JSON.parse(await current.text()), site)
  } catch {
    return response("Public publication is incomplete.", 503)
  }
  const asset = await servePublishedAsset(request, bucket, site, publication)
  if (asset) return asset
  const entry = publication.routes.find((candidate) => candidate.route === route)
  if (!entry) return response("Published route not found.", 404)

  const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
  const cacheKey = new Request(`https://wp-codebox-publication.invalid/${site.id}/${publication.revision}${route}`, { method: "GET" })
  const cached = cache ? await cache.match(cacheKey) : null
  if (cached) return publicationResponse(cached, request.method === "HEAD", publication.revision, "edge")
  try {
    const object = await bucket.get(entry.objectKey)
    if (!object || object.size > MAX_PUBLISHED_PAGE_BYTES) return response("Public publication is incomplete.", 503)
    const snapshot = JSON.parse(await object.text()) as PageSnapshot
    if (!isPageSnapshot(snapshot, entry.canonicalRevision, route)) return response("Public publication is incomplete.", 503)
    const published = publicationResponse(new Response(snapshot.body, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers }), request.method === "HEAD", publication.revision, "r2")
    if (cache && request.method === "GET") await cache.put(cacheKey, published.clone()).catch(() => undefined)
    return published
  } catch {
    return response("Public publication is incomplete.", 503)
  }
}

async function servePublishedAsset(request: Request, bucket: R2Bucket, site: SiteContext, publication: ReturnType<typeof validateCompletePublishedRevision>): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  const uploads = pathname.startsWith("/wp-content/uploads/") ? pathname.slice("/wp-content/uploads/".length) : null
  const wpContent = pathname.startsWith("/wp-content/") ? pathname.slice("/wp-content/".length) : null
  if (uploads === null && wpContent === null) return null
  let path: string
  try {
    path = decodeURIComponent(uploads ?? wpContent!)
  } catch {
    return response("Published asset path is invalid.", 400)
  }
  if ((uploads === null && !isCanonicalWpContentPath(path, WEBSITE_IMPORTER_OWNED_WP_CONTENT_PATHS)) || (uploads !== null && !isCanonicalRelativePath(path))) return response("Published asset path is invalid.", 400)
  try {
    const manifestKey = `${siteStorageKeys(site).markdownRevisionPrefix}/${publication.canonicalRevision}.json`
    const manifestObject = await bucket.get(manifestKey)
    if (!manifestObject) return response("Public publication is incomplete.", 503)
    const manifest = await manifestObject.json<{ revision?: unknown; uploads?: PublicationAsset[]; wpContent?: PublicationAsset[] }>()
    if (manifest.revision !== publication.canonicalRevision) return response("Public publication is incomplete.", 503)
    const files = uploads === null ? manifest.wpContent ?? [] : manifest.uploads ?? []
    if (uploads === null) validateWpContentManifestFiles(files, site, WEBSITE_IMPORTER_OWNED_WP_CONTENT_PATHS)
    else validateUploadManifestFiles(files, site)
    const file = files.find((candidate) => candidate.path === path)
    if (!file) return response("Published asset not found.", 404)
    const cache = typeof caches === "undefined" ? undefined : (caches as CacheStorage & { default?: Cache }).default
    const cacheKey = new Request(`https://wp-codebox-publication.invalid/${site.id}/${publication.revision}/${file.sha256}/${pathname}`, { method: "GET" })
    const cached = cache ? await cache.match(cacheKey) : null
    if (cached) return assetResponse(cached, request.method === "HEAD", publication.revision, "edge")
    const object = await bucket.get(file.objectKey)
    if (!object || object.size !== file.size) return response("Public publication is incomplete.", 503)
    const body = request.method === "HEAD" ? null : new Uint8Array(await object.arrayBuffer())
    if (body && await sha256Hex(body) !== file.sha256) return response("Public publication is incomplete.", 503)
    const published = assetResponse(new Response(body ? Uint8Array.from(body).buffer : null, { headers: { "content-length": String(file.size), "content-type": object.httpMetadata?.contentType ?? "application/octet-stream", etag: `\"${file.sha256}\"` } }), request.method === "HEAD", publication.revision, "r2")
    if (cache && request.method === "GET") await cache.put(cacheKey, published.clone()).catch(() => undefined)
    return published
  } catch {
    return response("Public publication is incomplete.", 503)
  }
}

function isPageSnapshot(snapshot: PageSnapshot, canonicalRevision: string, route: string): boolean {
  return snapshot.schema === PUBLISHED_PAGE_SCHEMA && snapshot.canonicalRevision === canonicalRevision && snapshot.route === route
    && Number.isInteger(snapshot.status) && snapshot.status >= 100 && snapshot.status <= 599 && typeof snapshot.statusText === "string"
    && Array.isArray(snapshot.headers) && snapshot.headers.every((header) => Array.isArray(header) && header.length === 2 && header.every((value) => typeof value === "string"))
    && typeof snapshot.body === "string"
}

function publicationResponse(response: Response, head: boolean, revision: string, source: "edge" | "r2"): Response {
  const headers = new Headers(response.headers)
  // The Worker cache key includes this immutable publication revision and site generation.
  headers.set("cache-control", "public, max-age=60, s-maxage=60")
  headers.set("x-wp-codebox-publication-revision", revision)
  headers.set("x-wp-codebox-publication-cache", source)
  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers })
}

function response(message: string, status: number): Response {
  return new Response(message, { status, headers: { "cache-control": "no-store", "x-wp-codebox-public-reader": "bounded" } })
}

function isCanonicalRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 2_048 && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function assetResponse(response: Response, head: boolean, revision: string, source: "edge" | "r2"): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "public, max-age=60, s-maxage=60")
  headers.set("x-wp-codebox-publication-revision", revision)
  headers.set("x-wp-codebox-publication-asset", source)
  return new Response(head ? null : response.body, { status: response.status, headers })
}
