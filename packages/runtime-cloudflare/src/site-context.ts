export interface SiteContext {
  id: string
  hostname: string
  origin: string
}

export interface SiteStorageKeys {
  root: string
  markdownCurrent: string
  markdownRevisionPrefix: string
  markdownObjectPrefix: string
  publishedCurrent: string
  publishedRevisionPrefix: string
  publishedPagePrefix: string
  publicationJobPrefix: string
  publicationProgressPrefix: string
  publicationClaimPrefix: string
  publicationReceiptPrefix: string
  uploadObjectPrefix: string
  wpContentObjectPrefix: string
  staticArtifactPrefix: string
}

export const DEFAULT_SITE_CONTEXT: SiteContext = {
  id: "default",
  hostname: "wp-codebox-cloudflare-runtime.chubes.workers.dev",
  origin: "https://wp-codebox-cloudflare-runtime.chubes.workers.dev",
}

export function parseSiteContexts(value: string | undefined): SiteContext[] {
  if (value === undefined || value.trim() === "") return [DEFAULT_SITE_CONTEXT]
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("WORDPRESS_SITE_CONTEXTS must be valid JSON.")
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("WORDPRESS_SITE_CONTEXTS must be a non-empty array.")

  const ids = new Set<string>()
  const hostnames = new Set<string>()
  return parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Site context is invalid.")
    const context = value as Partial<SiteContext>
    if (!isSiteId(context.id) || typeof context.hostname !== "string" || typeof context.origin !== "string") throw new Error("Site context is invalid.")
    const normalized = normalizeSiteContext(context.id, context.hostname, context.origin)
    if (ids.has(normalized.id) || hostnames.has(normalized.hostname)) throw new Error("Site contexts must have unique ids and hostnames.")
    ids.add(normalized.id)
    hostnames.add(normalized.hostname)
    return normalized
  })
}

export function resolveSiteContext(hostname: string, contexts: readonly SiteContext[]): SiteContext {
  const context = contexts.find((candidate) => candidate.hostname === hostname)
  if (!context) throw new Error("Unknown site hostname.")
  return context
}

export function resolveSiteContextFromRequest(request: Request | URL, contexts: readonly SiteContext[]): SiteContext {
  return resolveSiteContext(normalizeHostname(request instanceof Request ? new URL(request.url).hostname : request.hostname), contexts)
}

export function siteStorageKeys(site: SiteContext): SiteStorageKeys {
  const prefix = `sites/${site.id}`
  return {
    root: prefix,
    markdownCurrent: `${prefix}/markdown/current.json`,
    markdownRevisionPrefix: `${prefix}/markdown/revisions`,
    markdownObjectPrefix: `${prefix}/markdown/objects`,
    publishedCurrent: `${prefix}/publications/current.json`,
    publishedRevisionPrefix: `${prefix}/publications/revisions`,
    publishedPagePrefix: `${prefix}/pages`,
    publicationJobPrefix: `${prefix}/publications/jobs`,
    publicationProgressPrefix: `${prefix}/publications/job-progress`,
    publicationClaimPrefix: `${prefix}/publications/job-claims`,
    publicationReceiptPrefix: `${prefix}/publications/job-receipts`,
    uploadObjectPrefix: `${prefix}/uploads/objects`,
    wpContentObjectPrefix: `${prefix}/wp-content/objects`,
    staticArtifactPrefix: `${prefix}/import-artifacts`,
  }
}

function normalizeSiteContext(id: string, hostname: string, origin: string): SiteContext {
  if (hostname !== hostname.toLowerCase() || hostname.includes("/") || hostname.includes("\\") || hostname.includes("@") || (hostname.includes(":") && hostname !== "::1")) throw new Error("Site hostname is invalid.")
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error("Site origin is invalid.")
  }
  const canonicalHostname = normalizeHostname(url.hostname)
  if (hostname !== canonicalHostname || url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Site origin is not canonical.")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHostname(hostname))) throw new Error("Site origin must use HTTPS except for local hosts.")
  return { id, hostname, origin }
}

function isSiteId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1"
}
