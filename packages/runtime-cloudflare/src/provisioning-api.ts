import { D1OperationRepository, OperationConflict, type StaticArtifactOperation, type StaticArtifactOperationInput } from "./d1-operation-repository.js"
import type { RuntimeQueue } from "./queue-dispatch.js"
import { MAX_STATIC_ARTIFACT_BYTES, readBoundedRequestBytes, readStaticArtifactImport, StaticArtifactImportError, validateStaticArtifact } from "./static-artifact-import.js"
import { allocatePreviewSiteContext, parseSiteContexts, previewDomain, siteStorageKeys, type SiteContext } from "./site-context.js"
import { deriveSiteCredential } from "./wordpress-auth.js"
import { allocationIdentity, CloudflareAllocationLifecycle, type AllocationLifecycle } from "./allocation-lifecycle.js"

export const PROVISIONING_API_SCHEMA = "wp-codebox/provisioning-api/v1"
export const PROVISIONING_CREATE_REQUEST_SCHEMA = "wp-codebox/provisioning-create-request/v1"
export const PROVISIONING_SITE_RESOURCE_SCHEMA = "wp-codebox/provisioning-site/v1"
export const PROVISIONING_ARTIFACT_RESOURCE_SCHEMA = "wp-codebox/provisioning-artifact/v1"
export const PROVISIONING_ERROR_SCHEMA = "wp-codebox/provisioning-error/v1"
const SCOPES = new Set(["sites:create", "sites:read", "sites:import", "operations:read"])

interface Token { id: string; principal: string; digest: string; scopes: string[]; expiresAt: string; sites?: string[]; maxSites: number }
export interface ProvisioningAllocation {
  siteId: string; principal: string; key: string; fingerprint: string; operationId: string | null
  artifactSha256: string; artifactSize: number; options: StaticArtifactOperationInput["options"]
}
interface CreateInput { key: string; fingerprint: string; artifactSha256: string; artifactSize: number; options: StaticArtifactOperationInput["options"] }
export interface ProvisioningEnv { WORDPRESS_STATE_DATABASE: D1Database; WORDPRESS_STATE_BUCKET: R2Bucket; WORDPRESS_RUNTIME_QUEUE?: RuntimeQueue; WORDPRESS_SITE_CONTEXTS?: string; WORDPRESS_PREVIEW_DOMAIN?: string; WORDPRESS_PREVIEW_HOST_SECRET?: string; WORDPRESS_API_TOKENS?: string; WORDPRESS_ADMIN_CLAIM_SECRET?: string; WORDPRESS_ADMIN_PASSWORD?: string }

export async function routeProvisioningApi(request: Request, env: ProvisioningEnv, operations: D1OperationRepository): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean)
  const method = request.method
  if (parts[0] !== "v1") return notFound()
  if (parts.length === 3 && parts[1] === "artifacts" && /^[a-f0-9]{64}$/.test(parts[2])) return method === "PUT" ? stageArtifact(request, env, parts[2]) : methodNotAllowed("PUT")
  if (parts.length === 2 && parts[1] === "sites") return method === "POST" ? create(request, env, operations) : methodNotAllowed("POST")
  if (parts.length < 3 || parts[1] !== "sites" || !validSiteId(parts[2])) return notFound()
  const siteId = parts[2]
  // This capability endpoint must never fall through to API bearer authentication or WordPress.
  if (parts.length === 4 && parts[3] === "administrator-claim") return method === "POST" ? claimAdministrator(request, env, operations, siteId) : methodNotAllowed("POST")
  if (parts.length === 3) return method === "GET" ? readSite(request, env, operations, siteId) : methodNotAllowed("GET")
  if (parts.length === 4 && parts[3] === "lifecycle" && method === "GET") return lifecycleStatus(request, env, siteId)
  if (parts.length === 5 && parts[3] === "lifecycle" && parts[4] === "renew") return method === "POST" ? renewLifecycle(request, env, siteId) : methodNotAllowed("POST")
  if (parts.length === 4 && parts[3] === "lifecycle") return method === "DELETE" ? deleteLifecycle(request, env, siteId) : methodNotAllowed("GET, DELETE")
  if (parts.length === 4 && parts[3] === "imports") return method === "POST" ? importSite(request, env, operations, siteId) : methodNotAllowed("POST")
  if (parts.length === 5 && parts[3] === "operations" && /^[0-9a-f-]{36}$/.test(parts[4])) return method === "GET" ? readOperation(request, env, operations, siteId, parts[4]) : methodNotAllowed("GET")
  return notFound()
}

async function dispatchOperation(env: ProvisioningEnv, operations: D1OperationRepository, site: SiteContext, operation: StaticArtifactOperation): Promise<void> {
  const message = await operations.stageDispatch(site, "operation", operation.operationId)
  try { if (!env.WORDPRESS_RUNTIME_QUEUE) throw new Error("Runtime queue binding is unavailable."); await env.WORDPRESS_RUNTIME_QUEUE.send(message); await operations.deliveredDispatch(message) } catch (error) { await operations.failedDispatch(message, error); console.error("Runtime queue producer is backpressured; reconciliation will retry.", error) }
}

async function lifecycleStatus(request: Request, env: ProvisioningEnv, siteId: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:read"); if (token instanceof Response) return token
  const allocation = await new AllocationStore(env.WORDPRESS_STATE_DATABASE).bySite(siteId)
  if (!allocation || allocation.principal !== token.principal || !allowed(token, siteId)) return notFound()
  const lifecycle = await new CloudflareAllocationLifecycle(env.WORDPRESS_STATE_DATABASE).get(allocationIdentity(siteId))
  return lifecycle ? Response.json({ schema: PROVISIONING_API_SCHEMA, lifecycle: lifecycleResource(lifecycle) }) : notFound()
}
async function renewLifecycle(request: Request, env: ProvisioningEnv, siteId: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:import"); if (token instanceof Response) return token
  const allocation = await new AllocationStore(env.WORDPRESS_STATE_DATABASE).bySite(siteId)
  if (!allocation || allocation.principal !== token.principal || !allowed(token, siteId)) return notFound()
  try { const lifecycle = await new CloudflareAllocationLifecycle(env.WORDPRESS_STATE_DATABASE).renew(allocationIdentity(siteId), token.principal); return Response.json({ schema: PROVISIONING_API_SCHEMA, lifecycle: lifecycleResource(lifecycle) }) } catch { return apiError(409, "lifecycle_conflict", "The allocation lifecycle cannot be renewed.") }
}
async function deleteLifecycle(request: Request, env: ProvisioningEnv, siteId: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:import"); if (token instanceof Response) return token
  const allocation = await new AllocationStore(env.WORDPRESS_STATE_DATABASE).bySite(siteId)
  if (!allocation || allocation.principal !== token.principal || !allowed(token, siteId)) return notFound()
  try { await new CloudflareAllocationLifecycle(env.WORDPRESS_STATE_DATABASE).beginDeletion(allocationIdentity(siteId), token.principal); return lifecycleStatus(new Request(request.url, { headers: request.headers }), env, siteId) } catch { return apiError(409, "lifecycle_conflict", "The allocation lifecycle cannot be deleted.") }
}
function lifecycleResource(lifecycle: AllocationLifecycle) { return { state: lifecycle.state, expiresAt: new Date(lifecycle.expiresAt).toISOString(), retainUntil: new Date(lifecycle.retainUntil).toISOString(), generation: lifecycle.identity.generation, receipt: lifecycle.receipt } }

async function stageArtifact(request: Request, env: ProvisioningEnv, expectedSha256: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:create"); if (token instanceof Response) return token
  const declaredLength = request.headers.get("content-length")
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) < 1 || Number(declaredLength) > MAX_STATIC_ARTIFACT_BYTES)) return apiError(413, "invalid_artifact", "Provisioning artifact exceeds its byte budget.")
  let bytes: Uint8Array
  try { bytes = await readBoundedRequestBytes(request, MAX_STATIC_ARTIFACT_BYTES) } catch (error) { return importError(error) }
  if (!bytes.byteLength) return apiError(400, "invalid_artifact", "Provisioning artifact is required.")
  if (await sha(bytes) !== expectedSha256) return apiError(409, "artifact_digest_mismatch", "Provisioning artifact does not match its digest.")
  try { await validateArtifact(bytes) } catch (error) { return importError(error) }
  const key = stagedKey(expectedSha256)
  const verify = async () => {
    const object = await env.WORDPRESS_STATE_BUCKET.get(key)
    if (!object) return false
    const stored = new Uint8Array(await object.arrayBuffer())
    if (object.size !== bytes.byteLength || stored.byteLength !== bytes.byteLength || await sha(stored) !== expectedSha256) throw new OperationConflict("Provisioning artifact staging conflicts with existing content.")
    return true
  }
  try {
    if (!await verify()) {
      await env.WORDPRESS_STATE_BUCKET.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } })
      if (!await verify()) throw new OperationConflict("Provisioning artifact staging did not produce a verified object.")
    }
  } catch (error) {
    if (error instanceof OperationConflict) return apiError(409, "artifact_conflict", error.message)
    throw error
  }
  return Response.json({ schema: PROVISIONING_ARTIFACT_RESOURCE_SCHEMA, artifact: { sha256: expectedSha256, size: bytes.byteLength, r2Key: key } }, { status: 200 })
}

async function create(request: Request, env: ProvisioningEnv, operations: D1OperationRepository): Promise<Response> {
  const token = await authenticate(request, env, "sites:create"); if (token instanceof Response) return token
  const key = idempotencyKey(request); if (key instanceof Response) return key
  let input: CreateInput
  try { input = await readCreate(request, env.WORDPRESS_STATE_BUCKET, key) } catch (error) { return importError(error) }
  if (!claimConfiguration(env)) return apiError(503, "administrator_claim_unavailable", "Administrator claims are unavailable.")
  await operations.initialize()
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE)
  let allocation: ProvisioningAllocation
  try {
    const domain = previewDomain(env.WORDPRESS_PREVIEW_DOMAIN, env.WORDPRESS_PREVIEW_HOST_SECRET)
    const active = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT site_id FROM wp_codebox_sites WHERE state = 'active'").all<{ site_id: string }>()
    const occupied = new Set(active.results.map((row) => row.site_id))
    const configured = domain ? [] : parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS).filter((site) => allowed(token, site.id) && !occupied.has(site.id))
    allocation = await store.allocate(token, input, domain, configured)
  } catch (error) { return error instanceof OperationConflict ? apiError(409, "idempotency_conflict", error.message) : allocationError(error) }
  if (!allowed(token, allocation.siteId)) return notFound()
  const site = await store.context(allocation.siteId)
  if (!site) return notFound()
  try {
    const operation = await resumeProvisioningAllocation(env, site, operations)
    const claim = await new AdministratorClaimStore(env.WORDPRESS_STATE_DATABASE).issue(allocation, env)
    return siteResource(site, operation, 202, claim)
  } catch (error) { if (error instanceof OperationConflict) return apiError(409, "idempotency_conflict", error.message); if (error instanceof AdministratorClaimError) return apiError(409, "administrator_claim_unavailable", "The administrator claim cannot continue provisioning."); throw error }
}

async function readSite(request: Request, env: ProvisioningEnv, operations: D1OperationRepository, siteId: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:read"); if (token instanceof Response) return token
  const allocation = await new AllocationStore(env.WORDPRESS_STATE_DATABASE).bySite(siteId)
  const site = await new AllocationStore(env.WORDPRESS_STATE_DATABASE).context(siteId)
  if (!allocation || !site || allocation.principal !== token.principal || !allowed(token, siteId)) return notFound()
  const claim = await new AdministratorClaimStore(env.WORDPRESS_STATE_DATABASE).metadata(siteId)
  return siteResource(site, allocation.operationId ? await operations.get(siteId, allocation.operationId) : null, 200, claim)
}

async function claimAdministrator(request: Request, env: ProvisioningEnv, operations: D1OperationRepository, siteId: string): Promise<Response> {
  const capability = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1]
  if (!capability || !claimConfiguration(env)) return claimUnavailable()
  const store = new AdministratorClaimStore(env.WORDPRESS_STATE_DATABASE)
  const claim = await store.bySite(siteId)
  if (!claim || claim.state !== "pending") return claimUnavailable()
  if (claim.expiresAt <= Date.now()) { await store.expire(siteId); return claimUnavailable() }
  const digest = await shaText(capability)
  if (!await equal(digest, claim.capabilityDigest)) return claimUnavailable()
  const allocation = await new AllocationStore(env.WORDPRESS_STATE_DATABASE).bySite(siteId)
  const operation = allocation?.operationId ? await operations.get(siteId, allocation.operationId) : null
  if (operation?.state !== "succeeded") return apiError(409, "administrator_claim_not_ready", "The administrator credential is not ready.")
  let password: string
  try { password = await deriveSiteCredential(env.WORDPRESS_ADMIN_PASSWORD!, siteId, "admin-password") } catch { return claimUnavailable() }
  if (!await equal(await shaText(password), claim.credentialDigest)) return claimUnavailable()
  return (await store.consume(siteId, digest)) ? Response.json({ schema: PROVISIONING_API_SCHEMA, credential: { username: "admin", password } }) : claimUnavailable()
}

async function importSite(request: Request, env: ProvisioningEnv, operations: D1OperationRepository, siteId: string): Promise<Response> {
  const token = await authenticate(request, env, "sites:import"); if (token instanceof Response) return token
  const key = idempotencyKey(request); if (key instanceof Response) return key
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE); const allocation = await store.bySite(siteId); const site = await store.context(siteId)
  if (!allocation || !site || allocation.principal !== token.principal || !allowed(token, siteId)) return notFound()
  if (!await allocationActive(env.WORDPRESS_STATE_DATABASE, siteId)) return apiError(409, "allocation_inactive", "The allocation is no longer active.")
  const provision = allocation.operationId ? await operations.get(siteId, allocation.operationId) : null
  if (provision?.state !== "succeeded") return apiError(409, "site_not_ready", "The site is not ready for imports.")
  try {
    const input = await readStaticArtifactImport(request, env.WORDPRESS_STATE_BUCKET, site)
    if (input.idempotencyKey !== key) return apiError(409, "idempotency_conflict", "Idempotency-Key must match the import request.")
    const result = await operations.createOrConverge(site, { ...input, artifact: input.artifactReference })
    await dispatchOperation(env, operations, site, result.operation)
    await store.linkOperation(token.principal, siteId, result.operation.operationId, "import", key)
    return operationResource(siteId, result.operation, 202)
  } catch (error) { return error instanceof OperationConflict ? apiError(409, "operation_conflict", error.message) : importError(error) }
}

async function readOperation(request: Request, env: ProvisioningEnv, operations: D1OperationRepository, siteId: string, operationId: string): Promise<Response> {
  const token = await authenticate(request, env, "operations:read"); if (token instanceof Response) return token
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE); const allocation = await store.bySite(siteId)
  if (!allocation || !await store.context(siteId) || allocation.principal !== token.principal || !allowed(token, siteId) || !await store.ownsOperation(token.principal, siteId, operationId)) return notFound()
  const operation = await operations.get(siteId, operationId)
  return operation ? operationResource(siteId, operation) : notFound()
}

/** Converges a durable allocation after an interrupted API request or scheduled turn. */
export async function resumeProvisioningAllocation(env: ProvisioningEnv, site: SiteContext, operations: D1OperationRepository): Promise<StaticArtifactOperation | null> {
  const store = new AllocationStore(env.WORDPRESS_STATE_DATABASE)
  const allocation = await store.bySite(site.id)
  if (!allocation) return null
  if (!await allocationActive(env.WORDPRESS_STATE_DATABASE, site.id)) throw new OperationConflict("The allocation is no longer active.")
  if (!claimConfiguration(env)) throw new AdministratorClaimError()
  const administratorClaim = await new AdministratorClaimStore(env.WORDPRESS_STATE_DATABASE).issue(allocation, env)
  if (allocation.operationId) {
    const existing = await operations.get(site.id, allocation.operationId)
    if (existing) {
      await store.linkOperation(allocation.principal, site.id, existing.operationId, "provision", allocation.key)
      if (["publication-pending", "succeeded", "failed"].includes(existing.state)) return existing
    }
  }
  if (administratorClaim.state !== "pending") throw new AdministratorClaimError()
  const input = await verifiedAllocationInput(env.WORDPRESS_STATE_BUCKET, site, allocation)
  await putVerifiedArtifact(env.WORDPRESS_STATE_BUCKET, site, input)
  const result = await operations.createOrConverge(site, input)
  await store.bindOperation(allocation, result.operation.operationId)
  await store.linkOperation(allocation.principal, site.id, result.operation.operationId, "provision", allocation.key)
  await dispatchOperation(env, operations, site, result.operation)
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

function siteResource(site: SiteContext, operation: StaticArtifactOperation | null, status = 200, claim: AdministratorClaimMetadata | AdministratorClaimIssued | null = null): Response {
  const state = operation?.state === "succeeded" ? "ready" : operation?.state === "failed" ? "failed" : operation?.state === "publication-pending" ? "publication-pending" : "provisioning"
  const administratorClaim = claim ? { url: `/v1/sites/${site.id}/administrator-claim`, state: claim.state, expiresAt: new Date(claim.expiresAt).toISOString(), ...("token" in claim ? { token: claim.token } : {}) } : undefined
  return Response.json({ schema: PROVISIONING_SITE_RESOURCE_SCHEMA, site: { id: site.id, status: state, url: site.origin, operation: operation ? `/v1/sites/${site.id}/operations/${operation.operationId}` : null, ...(administratorClaim ? { administratorClaim } : {}) } }, { status })
}
function operationResource(siteId: string, operation: StaticArtifactOperation, status = 200): Response { return Response.json({ schema: PROVISIONING_API_SCHEMA, operation: { id: operation.operationId, siteId, state: operation.state, stage: operation.stage, progress: operation.progress, retryAt: operation.retryAt, error: operation.error, receipt: operation.receipt } }, { status }) }
function apiError(status: number, code: string, message: string, allow?: string): Response { return Response.json({ schema: PROVISIONING_ERROR_SCHEMA, error: { code, message } }, { status, headers: allow ? { Allow: allow } : undefined }) }
function notFound(): Response { return apiError(404, "not_found", "The API resource is unavailable.") }
function claimUnavailable(): Response { return apiError(401, "administrator_claim_unavailable", "The administrator claim is unavailable.") }
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
function allowed(token: Token, siteId: string): boolean { return !token.sites || token.sites.includes(siteId) }
function validSiteId(value: string): boolean { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63 }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
async function sha(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, "0")).join("") }
async function shaText(value: string): Promise<string> { return sha(new TextEncoder().encode(value)) }
async function equal(left: string, right: string): Promise<boolean> { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i); return result === 0 }
function claimConfiguration(env: ProvisioningEnv): boolean { return typeof env.WORDPRESS_ADMIN_CLAIM_SECRET === "string" && env.WORDPRESS_ADMIN_CLAIM_SECRET.length >= 32 && typeof env.WORDPRESS_ADMIN_PASSWORD === "string" && env.WORDPRESS_ADMIN_PASSWORD.length > 0 }

class AllocationError extends Error { constructor(readonly code: "quota_exceeded" | "capacity_exhausted") { super(code) } }
class AllocationStore {
  constructor(private readonly db: D1Database) {}
  async allocate(token: Token, input: CreateInput, domain: ReturnType<typeof previewDomain>, configured: SiteContext[]): Promise<ProvisioningAllocation> {
    await this.schema(); const lifecycle = new CloudflareAllocationLifecycle(this.db); await lifecycle.initialize(); const existing = await this.byRequest(token.principal, input.key)
    if (existing) { if (existing.fingerprint !== input.fingerprint) throw new OperationConflict("The idempotency key is already bound to a different immutable input."); return existing }
    if (domain && token.sites) throw new AllocationError("quota_exceeded")
    const attempts = domain ? 8 : configured.length
    for (let attempt = 0; attempt < attempts; attempt++) {
      const site = domain ? await allocatePreviewSiteContext(domain) : configured[attempt]
      const now = Date.now()
      try {
        const [allocation, reservation] = await this.db.batch([
          this.db.prepare("INSERT OR IGNORE INTO wp_codebox_api_sites (site_id, principal, idempotency_key, fingerprint, artifact_sha256, artifact_size, slug, name, site_title, operation_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE (SELECT COUNT(*) FROM wp_codebox_api_sites a LEFT JOIN wp_codebox_site_lifecycles l ON l.site_id = a.site_id WHERE a.principal = ? AND (l.site_id IS NULL OR l.state != 'tombstoned')) < ? AND NOT EXISTS (SELECT 1 FROM wp_codebox_sites WHERE site_id = ?)").bind(site.id, token.principal, input.key, input.fingerprint, input.artifactSha256, input.artifactSize, input.options.slug, input.options.name, input.options.siteTitle, now, token.principal, token.maxSites, site.id),
          this.db.prepare("INSERT INTO wp_codebox_sites (site_id, hostname, origin, generation, state, created_at, activated_at, updated_at) SELECT ?, ?, ?, ?, 'active', ?, ?, ? WHERE EXISTS (SELECT 1 FROM wp_codebox_api_sites WHERE site_id = ? AND principal = ? AND idempotency_key = ? AND fingerprint = ?)").bind(site.id, site.hostname, site.origin, allocationIdentity(site.id).generation, now, now, now, site.id, token.principal, input.key, input.fingerprint),
        ])
        if (allocation.meta.changes === 1 && reservation.meta.changes === 1) {
          await lifecycle.create(site, token.principal, now)
          return { siteId: site.id, principal: token.principal, key: input.key, fingerprint: input.fingerprint, operationId: null, artifactSha256: input.artifactSha256, artifactSize: input.artifactSize, options: input.options }
        }
      } catch (error) {
        if (!(error instanceof Error) || !/unique|constraint/i.test(error.message)) throw error
      }
      const raced = await this.byRequest(token.principal, input.key)
      if (raced) { if (raced.fingerprint !== input.fingerprint) throw new OperationConflict("The idempotency key is already bound to a different immutable input."); return raced }
    }
    const count = await this.db.prepare("SELECT COUNT(*) AS count FROM wp_codebox_api_sites a LEFT JOIN wp_codebox_site_lifecycles l ON l.site_id = a.site_id WHERE a.principal = ? AND (l.site_id IS NULL OR l.state != 'tombstoned')").bind(token.principal).first<{ count: number }>()
    throw new AllocationError((count?.count ?? 0) >= token.maxSites ? "quota_exceeded" : "capacity_exhausted")
  }
  async context(siteId: string): Promise<SiteContext | null> { await this.schema(); const row = await this.db.prepare("SELECT site_id, hostname, origin FROM wp_codebox_sites WHERE site_id = ? AND state = 'active'").bind(siteId).first<{ site_id: string; hostname: string; origin: string }>(); return row ? { id: row.site_id, hostname: row.hostname, origin: row.origin } : null }
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

interface AdministratorClaimMetadata { state: "pending" | "consumed" | "expired"; expiresAt: number }
interface AdministratorClaimIssued extends AdministratorClaimMetadata { token: string }
interface AdministratorClaimRecord extends AdministratorClaimMetadata { capabilityDigest: string; credentialDigest: string }
class AdministratorClaimError extends Error {}
class AdministratorClaimStore {
  constructor(private readonly db: D1Database) {}
  async issue(allocation: ProvisioningAllocation, env: ProvisioningEnv): Promise<AdministratorClaimIssued | AdministratorClaimMetadata> {
    await this.schema()
    if (!await allocationActive(this.db, allocation.siteId)) throw new AdministratorClaimError()
    const token = await claimCapability(env.WORDPRESS_ADMIN_CLAIM_SECRET!, allocation)
    const digest = await shaText(token)
    const credential = await deriveSiteCredential(env.WORDPRESS_ADMIN_PASSWORD!, allocation.siteId, "admin-password")
    const credentialDigest = await shaText(credential)
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000
    await this.db.prepare("INSERT OR IGNORE INTO wp_codebox_api_admin_claims (site_id, capability_digest, credential_digest, expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").bind(allocation.siteId, digest, credentialDigest, expiresAt, Date.now(), Date.now()).run()
    const claim = await this.bySite(allocation.siteId)
    if (!claim) throw new Error("Administrator claim was not persisted.")
    if (claim.state === "pending" && claim.expiresAt <= Date.now()) {
      await this.expire(allocation.siteId)
      return { state: "expired", expiresAt: claim.expiresAt }
    }
    if (claim.state === "pending" && !await equal(credentialDigest, claim.credentialDigest)) throw new AdministratorClaimError()
    return claim.state === "pending" && await equal(digest, claim.capabilityDigest) ? { state: claim.state, expiresAt: claim.expiresAt, token } : { state: claim.state, expiresAt: claim.expiresAt }
  }
  async metadata(siteId: string): Promise<AdministratorClaimMetadata | null> { const claim = await this.bySite(siteId); if (claim?.state === "pending" && claim.expiresAt <= Date.now()) { await this.expire(siteId); return { state: "expired", expiresAt: claim.expiresAt } } return claim && { state: claim.state, expiresAt: claim.expiresAt } }
  async bySite(siteId: string): Promise<AdministratorClaimRecord | null> { await this.schema(); const row = await this.db.prepare("SELECT capability_digest, credential_digest, expires_at, state FROM wp_codebox_api_admin_claims WHERE site_id = ?").bind(siteId).first<{ capability_digest: string; credential_digest: string; expires_at: number; state: AdministratorClaimMetadata["state"] }>(); return row ? { capabilityDigest: row.capability_digest, credentialDigest: row.credential_digest, expiresAt: row.expires_at, state: row.state } : null }
  async expire(siteId: string): Promise<void> { await this.db.prepare("UPDATE wp_codebox_api_admin_claims SET state = 'expired', updated_at = ? WHERE site_id = ? AND state = 'pending' AND expires_at <= ?").bind(Date.now(), siteId, Date.now()).run() }
  async consume(siteId: string, digest: string): Promise<boolean> { const now = Date.now(); const result = await this.db.prepare("UPDATE wp_codebox_api_admin_claims SET state = 'consumed', updated_at = ? WHERE site_id = ? AND state = 'pending' AND capability_digest = ? AND expires_at > ? AND EXISTS (SELECT 1 FROM wp_codebox_sites s LEFT JOIN wp_codebox_site_lifecycles l ON l.site_id = s.site_id AND l.generation = s.generation WHERE s.site_id = wp_codebox_api_admin_claims.site_id AND (l.site_id IS NULL OR (l.state = 'active' AND l.expires_at > ?)))").bind(now, siteId, digest, now, now).run(); return result.meta.changes === 1 }
  private async schema(): Promise<void> { await this.db.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_api_admin_claims (site_id TEXT PRIMARY KEY, capability_digest TEXT NOT NULL, credential_digest TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','consumed','expired')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run() }
}
async function allocationActive(db: D1Database, siteId: string): Promise<boolean> {
  const lifecycle = new CloudflareAllocationLifecycle(db)
  const current = await lifecycle.get(allocationIdentity(siteId))
  return !current || (current.state === "active" && current.expiresAt > Date.now())
}
async function claimCapability(root: string, allocation: ProvisioningAllocation): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(root), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const identity = `wp-codebox/administrator-claim/v1\0${allocation.siteId}\0${allocation.principal}\0${allocation.key}\0${allocation.fingerprint}`
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(identity))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
