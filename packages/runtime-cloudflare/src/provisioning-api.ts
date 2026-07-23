import { D1OperationRepository, OperationConflict, type StaticArtifactOperation, type StaticArtifactOperationInput } from "./d1-operation-repository.js"
import { MAX_STATIC_ARTIFACT_BYTES, readBoundedRequestBytes, readStaticArtifactImport, StaticArtifactImportError, validateStaticArtifact } from "./static-artifact-import.js"
import { parseSiteContexts, siteStorageKeys, type SiteContext } from "./site-context.js"

export const PROVISIONING_API_SCHEMA = "wp-codebox/provisioning-api/v1"
export const PROVISIONING_CREATE_REQUEST_SCHEMA = "wp-codebox/provisioning-create-request/v1"
export const PROVISIONING_SITE_RESOURCE_SCHEMA = "wp-codebox/provisioning-site/v1"
export const PROVISIONING_ERROR_SCHEMA = "wp-codebox/provisioning-error/v1"
const SCOPES = new Set(["sites:create", "sites:read", "sites:import", "operations:read"])

interface Token { id: string; principal: string; digest: string; scopes: string[]; expiresAt: string; sites?: string[]; maxSites: number }
export interface ProvisioningAllocation {
  siteId: string; principal: string; key: string; fingerprint: string; operationId: string | null
  artifactSha256: string; artifactSize: number; options: StaticArtifactOperationInput["options"]
}
interface CreateInput { key: string; fingerprint: string; artifactSha256: string; artifactSize: number; options: StaticArtifactOperationInput["options"] }
export interface ProvisioningEnv { WORDPRESS_STATE_DATABASE: D1Database; WORDPRESS_STATE_BUCKET: R2Bucket; WORDPRESS_SITE_CONTEXTS?: string; WORDPRESS_API_TOKENS?: string }

export async function routeProvisioningApi(request: Request, env: ProvisioningEnv, operations: D1OperationRepository): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean)
  const method = request.method
  if (parts[0] !== "v1") return notFound()
  if (parts.length === 2 && parts[1] === "sites") return method === "POST" ? create(request, env, operations) : methodNotAllowed("POST")
  if (parts.length < 3 || parts[1] !== "sites" || !validSiteId(parts[2])) return notFound()
  const siteId = parts[2]
  if (parts.length === 3) return method === "GET" ? readSite(request, env, operations, siteId) : methodNotAllowed("GET")
  if (parts.length === 4 && parts[3] === "imports") return method === "POST" ? importSite(request, env, operations, siteId) : methodNotAllowed("POST")
  if (parts.length === 5 && parts[3] === "operations" && /^[0-9a-f-]{36}$/.test(parts[4])) return method === "GET" ? readOperation(request, env, operations, siteId, parts[4]) : methodNotAllowed("GET")
  return notFound()
}

async function create(request: Request, env: ProvisioningEnv, operations: D1OperationRepository): Promise<Response> {
  const token = await authenticate(request, env, "sites:create"); if (token instanceof Response) return token
  const key = idempotencyKey(request); if (key instanceof Response) return key
  let input: CreateInput
  try { input = await readCreate(request, env.WORDPRESS_STATE_BUCKET, key) } catch (error) { return importError(error) }
  await operations.initialize()
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE)
  let allocation: ProvisioningAllocation
  try {
    const active = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT site_id FROM wp_codebox_sites WHERE state = 'active'").all<{ site_id: string }>()
    const occupied = new Set(active.results.map((row) => row.site_id))
    const candidates = parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS).filter((site) => allowed(token, site.id) && !occupied.has(site.id))
    allocation = await store.allocate(token, input, candidates)
  } catch (error) { return error instanceof OperationConflict ? apiError(409, "idempotency_conflict", error.message) : allocationError(error) }
  if (!allowed(token, allocation.siteId)) return notFound()
  const site = context(env, allocation.siteId)
  if (!site) return notFound()
  try {
    const operation = await resumeProvisioningAllocation(env, site, operations)
    return siteResource(site, operation, 202)
  } catch (error) { if (error instanceof OperationConflict) return apiError(409, "idempotency_conflict", error.message); throw error }
}

async function readSite(request: Request, env: ProvisioningEnv, operations: D1OperationRepository, siteId: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:read"); if (token instanceof Response) return token
  const allocation = await new AllocationStore(env.WORDPRESS_STATE_DATABASE).bySite(siteId)
  const site = context(env, siteId)
  if (!allocation || !site || allocation.principal !== token.principal || !allowed(token, siteId)) return notFound()
  return siteResource(site, allocation.operationId ? await operations.get(siteId, allocation.operationId) : null)
}

async function importSite(request: Request, env: ProvisioningEnv, operations: D1OperationRepository, siteId: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:import"); if (token instanceof Response) return token
  const key = idempotencyKey(request); if (key instanceof Response) return key
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE); const allocation = await store.bySite(siteId); const site = context(env, siteId)
  if (!allocation || !site || allocation.principal !== token.principal || !allowed(token, siteId)) return notFound()
  const provision = allocation.operationId ? await operations.get(siteId, allocation.operationId) : null
  if (provision?.state !== "succeeded") return apiError(409, "site_not_ready", "The site is not ready for imports.")
  try {
    const input = await readStaticArtifactImport(request, env.WORDPRESS_STATE_BUCKET, site)
    if (input.idempotencyKey !== key) return apiError(409, "idempotency_conflict", "Idempotency-Key must match the import request.")
    const result = await operations.createOrConverge(site, { ...input, artifact: input.artifactReference })
    await store.linkOperation(token.principal, siteId, result.operation.operationId, "import", key)
    return operationResource(siteId, result.operation, 202)
  } catch (error) { return error instanceof OperationConflict ? apiError(409, "operation_conflict", error.message) : importError(error) }
}

async function readOperation(request: Request, env: ProvisioningEnv, operations: D1OperationRepository, siteId: string, operationId: string): Promise<Response> {
  const token = await authenticate(request, env, "operations:read"); if (token instanceof Response) return token
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE); const allocation = await store.bySite(siteId)
  if (!allocation || !context(env, siteId) || allocation.principal !== token.principal || !allowed(token, siteId) || !await store.ownsOperation(token.principal, siteId, operationId)) return notFound()
  const operation = await operations.get(siteId, operationId)
  return operation ? operationResource(siteId, operation) : notFound()
}

/** Converges a durable allocation after an interrupted API request or scheduled turn. */
export async function resumeProvisioningAllocation(env: ProvisioningEnv, site: SiteContext, operations: D1OperationRepository): Promise<StaticArtifactOperation | null> {
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE)
  const allocation = await store.bySite(site.id)
  if (!allocation) return null
  if (allocation.operationId) {
    const existing = await operations.get(site.id, allocation.operationId)
    if (existing) {
      await store.linkOperation(allocation.principal, site.id, existing.operationId, "provision", allocation.key)
      if (["publication-pending", "succeeded", "failed"].includes(existing.state)) return existing
    }
  }
  const input = await verifiedAllocationInput(env.WORDPRESS_STATE_BUCKET, site, allocation)
  await putVerifiedArtifact(env.WORDPRESS_STATE_BUCKET, site, input)
  const result = await operations.createOrConverge(site, input)
  await store.bindOperation(allocation, result.operation.operationId)
  await store.linkOperation(allocation.principal, site.id, result.operation.operationId, "provision", allocation.key)
  return result.operation
}

async function readCreate(request: Request, bucket: R2Bucket, key: string): Promise<CreateInput> {
  const bytes = await readBoundedRequestBytes(request)
  let body: Record<string, unknown>; try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new StaticArtifactImportError("Provisioning request must be valid UTF-8 JSON.", 400) }
  if (!record(body) || body.schema !== PROVISIONING_CREATE_REQUEST_SCHEMA || body.idempotencyKey !== key || !record(body.artifact) || !record(body.import)) throw new StaticArtifactImportError("Provisioning request is invalid.", 400)
  const sha256 = body.artifact.sha256; const size = body.artifact.size
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || body.artifact.r2Key !== stagedKey(sha256) || !Number.isSafeInteger(size) || typeof size !== "number" || size < 1 || size > MAX_STATIC_ARTIFACT_BYTES) throw new StaticArtifactImportError("Provisioning artifact reference is invalid.", 400)
  const options = optionsOf(body.import); const object = await bucket.get(stagedKey(sha256))
  if (!object) throw new StaticArtifactImportError("Provisioning artifact is unavailable.", 404)
  const artifact = new Uint8Array(await object.arrayBuffer())
  if (object.size !== size || artifact.byteLength !== size || await sha(artifact) !== sha256) throw new StaticArtifactImportError("Provisioning artifact does not match its reference.", 409)
  await validateArtifact(artifact)
  return { key, artifactSha256: sha256, artifactSize: size, options, fingerprint: await shaText(JSON.stringify({ sha256, size, options })) }
}

async function verifiedAllocationInput(bucket: R2Bucket, site: SiteContext, allocation: ProvisioningAllocation): Promise<StaticArtifactOperationInput> {
  const staged = await bucket.get(stagedKey(allocation.artifactSha256))
  if (!staged) throw new Error("Provisioning staging artifact is unavailable during recovery.")
  const bytes = new Uint8Array(await staged.arrayBuffer())
  if (staged.size !== allocation.artifactSize || bytes.byteLength !== allocation.artifactSize || await sha(bytes) !== allocation.artifactSha256) throw new Error("Provisioning staging artifact no longer matches its allocation.")
  await validateArtifact(bytes)
  return { idempotencyKey: allocation.key, fingerprint: allocation.fingerprint, artifact: { r2Key: destinationKey(site, allocation.artifactSha256), sha256: allocation.artifactSha256, size: allocation.artifactSize }, options: allocation.options }
}

async function validateArtifact(bytes: Uint8Array): Promise<void> { try { await validateStaticArtifact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) } catch (error) { if (error instanceof StaticArtifactImportError) throw error; throw new StaticArtifactImportError("Provisioning artifact must be valid UTF-8 JSON.", 422) } }
async function putVerifiedArtifact(bucket: R2Bucket, site: SiteContext, input: StaticArtifactOperationInput): Promise<void> {
  const verify = async () => {
    const object = await bucket.get(input.artifact.r2Key)
    if (!object) return false
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (object.size !== input.artifact.size || bytes.byteLength !== input.artifact.size || await sha(bytes) !== input.artifact.sha256) throw new OperationConflict("Allocated artifact destination conflicts with verified content.")
    return true
  }
  if (await verify()) return
  const staged = await bucket.get(stagedKey(input.artifact.sha256))
  if (!staged) throw new Error("Provisioning staging artifact is unavailable during copy.")
  const bytes = new Uint8Array(await staged.arrayBuffer())
  if (staged.size !== input.artifact.size || bytes.byteLength !== input.artifact.size || await sha(bytes) !== input.artifact.sha256) throw new Error("Provisioning staging artifact changed during copy.")
  const result = await bucket.put(input.artifact.r2Key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } })
  if (!await verify()) throw new OperationConflict(result === null ? "Conditional artifact copy did not produce a destination object." : "Allocated artifact destination disappeared after its conditional write.")
}

function siteResource(site: SiteContext, operation: StaticArtifactOperation | null, status = 200): Response {
  const state = operation?.state === "succeeded" ? "ready" : operation?.state === "failed" ? "failed" : operation?.state === "publication-pending" ? "publication-pending" : "provisioning"
  return Response.json({ schema: PROVISIONING_SITE_RESOURCE_SCHEMA, site: { id: site.id, status: state, url: site.origin, operation: operation ? `/v1/sites/${site.id}/operations/${operation.operationId}` : null } }, { status })
}
function operationResource(siteId: string, operation: StaticArtifactOperation, status = 200): Response { return Response.json({ schema: PROVISIONING_API_SCHEMA, operation: { id: operation.operationId, siteId, state: operation.state, stage: operation.stage, progress: operation.progress, retryAt: operation.retryAt, error: operation.error, receipt: operation.receipt } }, { status }) }
function apiError(status: number, code: string, message: string, allow?: string): Response { return Response.json({ schema: PROVISIONING_ERROR_SCHEMA, error: { code, message } }, { status, headers: allow ? { Allow: allow } : undefined }) }
function notFound(): Response { return apiError(404, "not_found", "The API resource is unavailable.") }
function methodNotAllowed(allow: string): Response { return apiError(405, "method_not_allowed", "The API method is unsupported.", allow) }
function importError(error: unknown): Response { if (error instanceof StaticArtifactImportError) return apiError(error.status, "invalid_import", error.message); throw error }
function allocationError(error: unknown): Response { if (error instanceof AllocationError) return apiError(error.code === "quota_exceeded" ? 429 : 409, error.code, error.code === "quota_exceeded" ? "The principal site quota is exhausted." : "No configured site context is available."); throw error }
function idempotencyKey(request: Request): string | Response { const key = request.headers.get("idempotency-key"); return key && /^[A-Za-z0-9._:-]{1,128}$/.test(key) ? key : apiError(400, "invalid_idempotency_key", "Idempotency-Key is required.") }

async function authenticate(request: Request, env: ProvisioningEnv, scope: string): Promise<Token | Response> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1]
  if (!bearer) return apiError(401, "unauthorized", "Bearer authentication is required.")
  let tokens: Token[]; try { tokens = parseTokens(env.WORDPRESS_API_TOKENS) } catch { return apiError(401, "unauthorized", "Bearer authentication is unavailable.") }
  const digest = await shaText(bearer)
  for (const token of tokens) if (await equal(digest, token.digest)) {
    if (Date.parse(token.expiresAt) <= Date.now()) return apiError(401, "unauthorized", "Bearer authentication failed.")
    return token.scopes.includes(scope) ? token : apiError(403, "forbidden", "The bearer token lacks the required scope.")
  }
  return apiError(401, "unauthorized", "Bearer authentication failed.")
}
function parseTokens(value: string | undefined): Token[] {
  const tokens: unknown = JSON.parse(value ?? "")
  if (!Array.isArray(tokens) || !tokens.length || tokens.length > 64) throw new Error("Invalid token configuration.")
  const ids = new Set<string>(); const digests = new Set<string>()
  return tokens.map((raw) => {
    if (!record(raw)) throw new Error("Invalid token configuration.")
    const token = raw as unknown as Token
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(token.id) || !/^[A-Za-z0-9._:-]{1,128}$/.test(token.principal) || !/^[a-f0-9]{64}$/.test(token.digest) || ids.has(token.id) || digests.has(token.digest) || !Array.isArray(token.scopes) || !token.scopes.length || token.scopes.length > 4 || token.scopes.some((scope) => !SCOPES.has(scope)) || !Number.isInteger(token.maxSites) || token.maxSites < 0 || token.maxSites > 10_000 || typeof token.expiresAt !== "string" || new Date(token.expiresAt).toISOString() !== token.expiresAt || Date.parse(token.expiresAt) <= 0 || (token.sites !== undefined && (!Array.isArray(token.sites) || token.sites.length > 256 || token.sites.some((site) => !validSiteId(site))))) throw new Error("Invalid token configuration.")
    ids.add(token.id); digests.add(token.digest); return token
  })
}
function optionsOf(value: Record<string, unknown>): StaticArtifactOperationInput["options"] { const slug = value.slug; const name = typeof value.name === "string" ? value.name.trim() : ""; const siteTitle = typeof value.siteTitle === "string" ? value.siteTitle.trim() : ""; if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64 || !name || name.length > 120 || !siteTitle || siteTitle.length > 120) throw new StaticArtifactImportError("Provisioning import options are invalid.", 400); return { slug, name, siteTitle } }
function stagedKey(sha256: string): string { return `sites/provisioning/import-artifacts/${sha256}.json` }
function destinationKey(site: SiteContext, sha256: string): string { return `${siteStorageKeys(site).staticArtifactPrefix}/${sha256}.json` }
function context(env: ProvisioningEnv, id: string): SiteContext | undefined { return parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS).find((site) => site.id === id) }
function allowed(token: Token, siteId: string): boolean { return !token.sites || token.sites.includes(siteId) }
function validSiteId(value: string): boolean { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63 }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
async function sha(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, "0")).join("") }
async function shaText(value: string): Promise<string> { return sha(new TextEncoder().encode(value)) }
async function equal(left: string, right: string): Promise<boolean> { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i); return result === 0 }

class AllocationError extends Error { constructor(readonly code: "quota_exceeded" | "capacity_exhausted") { super(code) } }
class AllocationStore {
  constructor(private readonly db: D1Database) {}
  async allocate(token: Token, input: CreateInput, sites: SiteContext[]): Promise<ProvisioningAllocation> {
    await this.schema(); const existing = await this.byRequest(token.principal, input.key)
    if (existing) { if (existing.fingerprint !== input.fingerprint) throw new OperationConflict("The idempotency key is already bound to a different immutable input."); return existing }
    for (const site of sites) {
      const now = Date.now()
      try {
        const [allocation, reservation] = await this.db.batch([
          this.db.prepare("INSERT OR IGNORE INTO wp_codebox_api_sites (site_id, principal, idempotency_key, fingerprint, artifact_sha256, artifact_size, slug, name, site_title, operation_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE (SELECT COUNT(*) FROM wp_codebox_api_sites WHERE principal = ?) < ? AND NOT EXISTS (SELECT 1 FROM wp_codebox_sites WHERE site_id = ?)").bind(site.id, token.principal, input.key, input.fingerprint, input.artifactSha256, input.artifactSize, input.options.slug, input.options.name, input.options.siteTitle, now, token.principal, token.maxSites, site.id),
          this.db.prepare("INSERT INTO wp_codebox_sites (site_id, hostname, origin, state, created_at, activated_at, updated_at) SELECT ?, ?, ?, 'active', ?, ?, ? WHERE EXISTS (SELECT 1 FROM wp_codebox_api_sites WHERE site_id = ? AND principal = ? AND idempotency_key = ? AND fingerprint = ?)").bind(site.id, site.hostname, site.origin, now, now, now, site.id, token.principal, input.key, input.fingerprint),
        ])
        if (allocation.meta.changes === 1 && reservation.meta.changes === 1) return { siteId: site.id, principal: token.principal, key: input.key, fingerprint: input.fingerprint, operationId: null, artifactSha256: input.artifactSha256, artifactSize: input.artifactSize, options: input.options }
      } catch (error) {
        if (!(error instanceof Error) || !/unique|constraint/i.test(error.message)) throw error
      }
      const raced = await this.byRequest(token.principal, input.key)
      if (raced) { if (raced.fingerprint !== input.fingerprint) throw new OperationConflict("The idempotency key is already bound to a different immutable input."); return raced }
    }
    const count = await this.db.prepare("SELECT COUNT(*) AS count FROM wp_codebox_api_sites WHERE principal = ?").bind(token.principal).first<{ count: number }>()
    throw new AllocationError((count?.count ?? 0) >= token.maxSites ? "quota_exceeded" : "capacity_exhausted")
  }
  async bySite(siteId: string): Promise<ProvisioningAllocation | null> { await this.schema(); const row = await this.db.prepare("SELECT site_id, principal, idempotency_key, fingerprint, artifact_sha256, artifact_size, slug, name, site_title, operation_id FROM wp_codebox_api_sites WHERE site_id = ?").bind(siteId).first<Record<string, unknown>>(); return row ? allocation(row) : null }
  async bindOperation(value: ProvisioningAllocation, operationId: string): Promise<void> {
    await this.schema()
    await this.db.prepare("UPDATE wp_codebox_api_sites SET operation_id = ? WHERE site_id = ? AND (operation_id IS NULL OR operation_id = ?)").bind(operationId, value.siteId, operationId).run()
    const current = await this.bySite(value.siteId)
    if (current?.operationId !== operationId) throw new OperationConflict("The provisioning allocation is already bound to another operation.")
  }
  async linkOperation(principal: string, siteId: string, operationId: string, kind: "provision" | "import", key: string): Promise<void> {
    await this.schema()
    await this.db.prepare("INSERT OR IGNORE INTO wp_codebox_api_operation_links (principal, site_id, operation_id, kind, idempotency_key) VALUES (?, ?, ?, ?, ?)").bind(principal, siteId, operationId, kind, key).run()
    const linked = await this.db.prepare("SELECT operation_id FROM wp_codebox_api_operation_links WHERE principal = ? AND site_id = ? AND kind = ? AND idempotency_key = ?").bind(principal, siteId, kind, key).first<{ operation_id: string }>()
    if (linked?.operation_id !== operationId) throw new OperationConflict("The API idempotency key is already bound to another operation.")
  }
  async ownsOperation(principal: string, siteId: string, operationId: string): Promise<boolean> { await this.schema(); return !!await this.db.prepare("SELECT operation_id FROM wp_codebox_api_operation_links WHERE principal = ? AND site_id = ? AND operation_id = ?").bind(principal, siteId, operationId).first() }
  private async byRequest(principal: string, key: string): Promise<ProvisioningAllocation | null> { const row = await this.db.prepare("SELECT site_id, principal, idempotency_key, fingerprint, artifact_sha256, artifact_size, slug, name, site_title, operation_id FROM wp_codebox_api_sites WHERE principal = ? AND idempotency_key = ?").bind(principal, key).first<Record<string, unknown>>(); return row ? allocation(row) : null }
  private async schema(): Promise<void> {
    await this.db.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_api_sites (site_id TEXT PRIMARY KEY, principal TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, artifact_size INTEGER NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, site_title TEXT NOT NULL, operation_id TEXT, created_at INTEGER NOT NULL, UNIQUE(principal, idempotency_key))").run()
    await this.db.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_api_operation_links (principal TEXT NOT NULL, site_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('provision','import')), idempotency_key TEXT NOT NULL, PRIMARY KEY (principal, site_id, operation_id), UNIQUE(principal, site_id, kind, idempotency_key))").run()
  }
}
function allocation(row: Record<string, unknown>): ProvisioningAllocation { return { siteId: row.site_id as string, principal: row.principal as string, key: row.idempotency_key as string, fingerprint: row.fingerprint as string, operationId: row.operation_id as string | null, artifactSha256: row.artifact_sha256 as string, artifactSize: row.artifact_size as number, options: { slug: row.slug as string, name: row.name as string, siteTitle: row.site_title as string } } }
