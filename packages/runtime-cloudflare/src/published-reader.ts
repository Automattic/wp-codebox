export const PUBLISHED_REVISION_SCHEMA = "wp-codebox/published-revision/v3" as const
const PREVIOUS_PUBLISHED_REVISION_SCHEMA = "wp-codebox/published-revision/v2"
const LEGACY_PUBLISHED_REVISION_SCHEMA = "wp-codebox/published-revision/v1"
export const PUBLISHED_PAGE_SCHEMA = "wp-codebox/wordpress-page/v2" as const
export const R2_PUBLISHED_CURRENT_KEY = "sites/default/publications/current.json"
export const R2_PUBLISHED_REVISION_PREFIX = "sites/default/publications/revisions"
export const MAX_PUBLISHED_ROUTES = 1_000
export const MAX_PUBLISHED_REVISION_BYTES = 512 * 1024
export const MAX_PUBLISHED_PAGE_BYTES = 8 * 1024 * 1024

export interface PublishedRoute {
  route: string
  objectKey: string
  canonicalRevision: string
}

export interface PublishedRevision {
  schema: typeof PUBLISHED_REVISION_SCHEMA
  revision: string
  canonicalRevision: string
  canonicalVersion: number
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
  const legacy = (value as { schema?: unknown }).schema === LEGACY_PUBLISHED_REVISION_SCHEMA
  const current = revision.schema === PUBLISHED_REVISION_SCHEMA
  if (![PUBLISHED_REVISION_SCHEMA, PREVIOUS_PUBLISHED_REVISION_SCHEMA, LEGACY_PUBLISHED_REVISION_SCHEMA].includes(revision.schema as string) || !isRevision(revision.revision) || !isRevision(revision.canonicalRevision)
    || typeof revision.publishedAt !== "string" || !Number.isFinite(Date.parse(revision.publishedAt)) || !Array.isArray(revision.routes)
    || (current && (typeof revision.canonicalVersion !== "number" || !Number.isSafeInteger(revision.canonicalVersion) || revision.canonicalVersion < 0))
    || revision.routes.length === 0 || revision.routes.length > MAX_PUBLISHED_ROUTES) throw new Error("Published revision is invalid.")
  let previous = ""
  const normalizedRoutes: PublishedRoute[] = []
  for (const route of revision.routes) {
    const routeRevision = legacy ? revision.canonicalRevision : route.canonicalRevision
    if (!route || typeof route !== "object" || !isCanonicalRoute(route.route) || route.route <= previous
      || !isRevision(routeRevision)
      || route.objectKey !== `sites/default/pages/${routeRevision}/${route.objectKey.split("/").at(-1)}`
      || !/^sites\/default\/pages\/[a-f0-9-]{36}\/[a-f0-9]{64}\.json$/.test(route.objectKey)) throw new Error("Published revision route is invalid.")
    previous = route.route
    normalizedRoutes.push({ route: route.route, objectKey: route.objectKey, canonicalRevision: routeRevision })
  }
  return { ...revision, schema: PUBLISHED_REVISION_SCHEMA, canonicalVersion: current ? revision.canonicalVersion! : 0, routes: normalizedRoutes } as PublishedRevision
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
