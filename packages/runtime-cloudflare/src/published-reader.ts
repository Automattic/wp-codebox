export const PUBLISHED_REVISION_SCHEMA = "wp-codebox/published-revision/v1" as const
export const PUBLISHED_PAGE_SCHEMA = "wp-codebox/wordpress-page/v2" as const
export const R2_PUBLISHED_CURRENT_KEY = "sites/default/publications/current.json"
export const R2_PUBLISHED_REVISION_PREFIX = "sites/default/publications/revisions"
export const MAX_PUBLISHED_ROUTES = 1_000
export const MAX_PUBLISHED_REVISION_BYTES = 512 * 1024
export const MAX_PUBLISHED_PAGE_BYTES = 8 * 1024 * 1024

export interface PublishedRoute {
  route: string
  objectKey: string
}

export interface PublishedRevision {
  schema: typeof PUBLISHED_REVISION_SCHEMA
  revision: string
  canonicalRevision: string
  publishedAt: string
  routes: PublishedRoute[]
}

export function canonicalPublicRoute(input: Request | URL | string): string {
  const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? new URL(input) : new URL(input, "https://wp-codebox-runtime.invalid")
  url.searchParams.sort()
  return `${url.pathname}${url.search}`
}

export async function publishedPageObjectKey(canonicalRevision: string, route: string): Promise<string> {
  if (!isRevision(canonicalRevision) || !isCanonicalRoute(route)) throw new Error("Published page identity is invalid.")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(route))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `sites/default/pages/${canonicalRevision}/${hash}.json`
}

export function publishedRevisionObjectKey(revision: string): string {
  if (!isRevision(revision)) throw new Error("Published revision identity is invalid.")
  return `${R2_PUBLISHED_REVISION_PREFIX}/${revision}.json`
}

export function validatePublishedRevision(value: unknown): PublishedRevision {
  if (!value || typeof value !== "object") throw new Error("Published revision is invalid.")
  const revision = value as Partial<PublishedRevision>
  if (revision.schema !== PUBLISHED_REVISION_SCHEMA || !isRevision(revision.revision) || !isRevision(revision.canonicalRevision)
    || typeof revision.publishedAt !== "string" || !Number.isFinite(Date.parse(revision.publishedAt)) || !Array.isArray(revision.routes)
    || revision.routes.length === 0 || revision.routes.length > MAX_PUBLISHED_ROUTES) throw new Error("Published revision is invalid.")
  let previous = ""
  for (const route of revision.routes) {
    if (!route || typeof route !== "object" || !isCanonicalRoute(route.route) || route.route <= previous
      || route.objectKey !== `sites/default/pages/${revision.canonicalRevision}/${route.objectKey.split("/").at(-1)}`
      || !/^sites\/default\/pages\/[a-f0-9-]{36}\/[a-f0-9]{64}\.json$/.test(route.objectKey)) throw new Error("Published revision route is invalid.")
    previous = route.route
  }
  return revision as PublishedRevision
}

export function normalizePublishedRoutes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PUBLISHED_ROUTES) throw new Error("Publication requires a bounded routes array.")
  const routes = value.map((route) => {
    if (typeof route !== "string" || !route.startsWith("/")) throw new Error("Publication route is invalid.")
    return canonicalPublicRoute(route)
  }).sort()
  if (routes.some((route, index) => index > 0 && route === routes[index - 1])) throw new Error("Publication routes must be unique.")
  return routes
}

function isCanonicalRoute(route: string): boolean {
  if (!route.startsWith("/") || route.includes("#") || route.includes("\\") || route.length > 2_048) return false
  try {
    return canonicalPublicRoute(route) === route
  } catch {
    return false
  }
}

function isRevision(revision: unknown): revision is string {
  return typeof revision === "string" && /^[a-f0-9-]{36}$/.test(revision)
}
