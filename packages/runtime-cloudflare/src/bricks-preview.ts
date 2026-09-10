import { authenticateProvisioningRequest, provisioningTokenAllowsSite } from './provisioning-api.js'
import { parseSiteContexts, type SiteContext } from './site-context.js'
import type { NativeEnv, NativePointer } from './native-bricks-api.js'
import type { MarkdownPointer, RevisionState } from './revision-coordinator.js'

export interface NativePreviewBackend {
  state(site: SiteContext): Promise<RevisionState>
  render(request: Request, site: SiteContext, pointer: MarkdownPointer): Promise<Response>
}
const prefix = /^\/v1\/bricks\/sites\/([a-z0-9-]{1,63})\/previews\/([A-Za-z0-9_-]{1,160})(\/.*)?$/
const browserAsset = /\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|pdf)$/i
const privateHeaders = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' }
function failure(status: number, code: string) { return Response.json({ error: { code } }, { status, headers: privateHeaders }) }

/** Native allocations are protected from their first preparation, even before
 * a successful mutation receipt exists. Persisted ownership retains protection
 * if an operator later removes the preparation entry. The public default POC
 * is deliberately outside this customer-allocation policy. */
export async function isProtectedNativeSite(env: NativeEnv, site: SiteContext): Promise<boolean> {
  if (site.id === 'default') return false
  if (Object.hasOwn(JSON.parse(env.WORDPRESS_BRICKS_PREPARED_ALLOCATIONS ?? '{}'), site.id)) return true
  const exists = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wp_codebox_native_operations'").first()
  return !!exists && !!await env.WORDPRESS_STATE_DATABASE.prepare('SELECT site_id FROM wp_codebox_native_operations WHERE site_id=? LIMIT 1').bind(site.id).first()
}

export function nativePreviewPathAllowed(path: string, search: URLSearchParams): boolean {
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return false }
  if (decoded !== path || !path.startsWith('/') || path.includes('//') || /[\\\x00-\x20]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return false
  if (path.startsWith('/__') || /^\/(?:wp-admin|wp-json|v1|r2)(?:\/|$)/i.test(path) || /\.php(?:\/|$)/i.test(path)) return false
  const asset = path.startsWith('/wp-content/') || path.startsWith('/wp-includes/')
  if (asset && !browserAsset.test(path)) return false
  if (!asset && path !== '/' && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*\/?$/.test(path)) return false
  for (const [key,value] of search) {
    if (asset ? key !== 'ver' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value) : !['p','page_id','paged'].includes(key) || !/^[1-9][0-9]{0,9}$/.test(value)) return false
  }
  return true
}

export function rewriteNativePreview(text: string, siteOrigin: string, mount: string): string {
  // WordPress absolute URLs, including inline JSON, plus root-relative HTML/CSS
  // URLs. Relative CSS paths already resolve inside the same protected mount.
  text = text.replace(/((?:href|src|action|poster|srcset)\s*=\s*["']|url\(\s*["']?)(\/)(?!\/)/gi, (_all, before) => `${before}${mount}/`)
    .replace(/(,\s*)(\/wp-(?:content|includes)\/)/g, `$1${mount}$2`)
  return text.split(siteOrigin.replaceAll('/', '\\/')).join(mount.replaceAll('/', '\\/'))
    .split(siteOrigin).join(mount).split(siteOrigin.replace(/^https?:/, '')).join(mount)
}

export async function routeNativeBricksPreview(request: Request, env: NativeEnv, backend: NativePreviewBackend): Promise<Response | null> {
  const url = new URL(request.url)
  const match = prefix.exec(url.pathname)
  if (!match) return url.pathname.includes('/previews/') && url.pathname.startsWith('/v1/bricks/') ? failure(404,'not_found') : null
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405,'read_only_preview')
  const token = await authenticateProvisioningRequest(request, env, 'sites:read')
  if (token instanceof Response) return new Response(token.body, { status: token.status, headers: {...Object.fromEntries(token.headers), ...privateHeaders} })
  const [,siteId,receiptId] = match
  if (!provisioningTokenAllowsSite(token,siteId)) return failure(404,'not_found')
  const site = parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS).find(site => site.id === siteId)
  if (!site) return failure(404,'not_found')
  // Never advertise protection while the same customer namespace is public.
  if (!await isProtectedNativeSite(env,site)) return failure(409,'native_allocation_not_protected')
  const exists = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wp_codebox_native_operations'").first()
  if (!exists) return failure(404,'not_found')
  const row = await env.WORDPRESS_STATE_DATABASE.prepare(`SELECT receipt_json,generation FROM wp_codebox_native_operations WHERE site_id=? AND principal=? AND state='succeeded'
    AND json_extract(receipt_json,'$.revision_receipt.receipt_id')=? LIMIT 1`).bind(siteId,token.principal,receiptId).first<{receipt_json:string;generation:number}>()
  if (!row) return failure(404,'not_found')
  const lifecycle = await env.WORDPRESS_STATE_DATABASE.prepare(`SELECT s.generation,s.state,l.state AS lifecycle_state,l.expires_at FROM wp_codebox_sites s
    LEFT JOIN wp_codebox_site_lifecycles l ON l.site_id=s.site_id AND l.generation=s.generation WHERE s.site_id=?`).bind(siteId).first<{generation:number;state:string;lifecycle_state:string|null;expires_at:number|null}>()
  if (!lifecycle || lifecycle.generation !== row.generation || lifecycle.state !== 'active' || (lifecycle.lifecycle_state !== null && (lifecycle.lifecycle_state !== 'active' || (lifecycle.expires_at ?? 0) <= Date.now()))) return failure(410,'allocation_unavailable')
  const receipt = JSON.parse(row.receipt_json)
  const pointer: NativePointer = receipt.revision_receipt
  if (receipt.site_id !== site.id || pointer.receipt_id !== receiptId) return failure(409,'receipt_mismatch')
  const current = (state: RevisionState) => state.version === pointer.canonical_state_version && state.pointer?.revision === pointer.canonical_state_revision && state.pointer.manifestKey === pointer.canonical_manifest_key && state.pointer.persistedAt === pointer.canonical_persisted_at
  const state = await backend.state(site)
  if (!current(state)) return failure(409,'stale_revision')
  const path = match[3] ?? '/'
  if (!nativePreviewPathAllowed(path,url.searchParams)) return failure(403,'read_only_preview')
  // The engine supplies its existing protected customer mount, not a browser
  // supplied host header. Require a plain root-relative path without a query.
  const mount = request.headers.get('x-wp-codebox-preview-base') ?? `/v1/bricks/sites/${siteId}/previews/${receiptId}`
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mount)) return failure(400,'invalid_preview_base')
  const safeRequest = new Request(`${site.origin}${path}${url.search}`, { method: request.method, headers: { accept: request.headers.get('accept') ?? '*/*' } })
  const response = await backend.render(safeRequest,site,state.pointer!)
  if (!current(await backend.state(site))) { await response.body?.cancel(); return failure(409,'stale_revision') }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    const destination = new URL(response.headers.get('location') ?? '/',site.origin)
    if (destination.origin !== site.origin || !nativePreviewPathAllowed(destination.pathname,destination.searchParams)) return failure(409,'preview_redirect_denied')
    return new Response(null,{status:response.status,headers:{...privateHeaders,location:`${mount}${destination.pathname}${destination.search}`}})
  }
  const headers = new Headers(response.headers)
  for (const name of ['set-cookie','content-length','content-encoding','etag','last-modified','link','refresh','access-control-allow-origin']) headers.delete(name)
  for (const [key,value] of Object.entries(privateHeaders)) headers.set(key,value)
  headers.set('x-wp-codebox-native-receipt',receiptId)
  headers.set('x-wp-codebox-canonical-version',String(state.version))
  headers.set('x-wp-codebox-canonical-revision',state.pointer!.revision)
  headers.set('x-content-type-options','nosniff')
  headers.set('content-security-policy',"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'")
  const type = headers.get('content-type') ?? ''
  const body = request.method === 'HEAD' ? null : /text\/html|text\/css|javascript/.test(type) ? rewriteNativePreview(await response.text(),site.origin,mount) : response.body
  return new Response(body,{status:response.status,headers})
}

export function nativePreviewReceipt(site: SiteContext, receiptId: string, apiOrigin: string) {
  if (site.id === 'default') return { state: 'requested' as const, url: null }
  const origin = new URL(apiOrigin)
  if (origin.origin !== apiOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) || !/^[A-Za-z0-9_-]{1,160}$/.test(receiptId)) throw new Error('Native preview receipt identity is invalid.')
  return { state: 'ready' as const, url: `${apiOrigin}/v1/bricks/sites/${site.id}/previews/${receiptId}/` }
}
