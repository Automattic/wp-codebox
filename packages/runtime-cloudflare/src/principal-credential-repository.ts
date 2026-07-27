const SCOPES = new Set(["sites:create", "sites:read", "sites:import", "operations:read"])
const DEFAULT_AUDIT_LIMIT = 10_000
const UNKNOWN_AUDIT_BUCKET_MS = 5 * 60_000

export interface PrincipalCredentialPolicy {
  principal: string
  scopes: string[]
  expiresAt: string
  maxSites: number
  sites?: string[]
}
export interface PrincipalCredentialVersion extends PrincipalCredentialPolicy {
  credentialId: string
  version: string
  digest: string
}
export interface AuthenticatedPrincipal extends PrincipalCredentialPolicy {
  credentialId: string
  version: string
}
export interface CredentialAuditEvent {
  id: number
  at: number
  kind: "registered" | "revoked" | "authenticated" | "denied"
  principal: string | null
  credentialId: string | null
  version: string | null
  reason: "ok" | "unknown" | "expired" | "revoked" | "scope" | "site"
}
export type CredentialAuthorizationDecision =
  | { status: "not-found" }
  | { status: "allowed"; principal: AuthenticatedPrincipal }
  | { status: "denied"; reason: "expired" | "revoked" | "scope" | "site"; principal: string; credentialId: string; version: string }

/** Durable bearer policy storage. Bearers are hashed before they cross this boundary. */
export class D1PrincipalCredentialRepository {
  constructor(private readonly db: D1Database, private readonly auditLimit = DEFAULT_AUDIT_LIMIT) {
    if (!Number.isSafeInteger(auditLimit) || auditLimit < 1 || auditLimit > DEFAULT_AUDIT_LIMIT) throw new Error("Credential audit limit is invalid.")
  }

  async initialize(): Promise<void> {
    await this.db.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_principal_credentials (credential_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, max_sites INTEGER NOT NULL, sites TEXT, revoked_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (credential_id, version))").run()
    await this.db.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_principal_credential_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('registered','revoked','authenticated','denied')), principal TEXT, credential_id TEXT, version TEXT, reason TEXT NOT NULL CHECK (reason IN ('ok','unknown','expired','revoked','scope','site')), dedupe_key TEXT UNIQUE)").run()
  }

  async register(input: PrincipalCredentialVersion): Promise<void> {
    validate(input)
    await this.initialize()
    const expiresAt = Date.parse(input.expiresAt)
    const scopes = JSON.stringify(input.scopes)
    const sites = input.sites ? JSON.stringify(input.sites) : null
    const existing = await this.db.prepare("SELECT digest, principal, scopes, expires_at, max_sites, sites FROM wp_codebox_principal_credentials WHERE credential_id = ? AND version = ?").bind(input.credentialId, input.version).first<Record<string, unknown>>()
    if (existing) {
      if (sameCredential(existing, input, scopes, sites, expiresAt)) return
      throw new Error("Credential version is already registered with different identity or policy.")
    }
    try {
      const now = Date.now()
      await this.db.batch([
        this.db.prepare("INSERT INTO wp_codebox_principal_credentials (credential_id, version, digest, principal, scopes, expires_at, max_sites, sites, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)").bind(input.credentialId, input.version, input.digest, input.principal, scopes, expiresAt, input.maxSites, sites, now),
        this.auditStatement("registered", input.principal, input.credentialId, input.version, "ok", now),
        this.trimAuditStatement(),
      ])
    } catch (error) {
      if (!(error instanceof Error) || !/unique|constraint/i.test(error.message)) throw error
      const raced = await this.db.prepare("SELECT digest, principal, scopes, expires_at, max_sites, sites FROM wp_codebox_principal_credentials WHERE credential_id = ? AND version = ?").bind(input.credentialId, input.version).first<Record<string, unknown>>()
      if (raced && sameCredential(raced, input, scopes, sites, expiresAt)) return
      throw new Error("Credential digest is already registered.")
    }
  }

  async revoke(credentialId: string, version: string, now = Date.now()): Promise<boolean> {
    if (!identifier(credentialId) || !identifier(version) || !Number.isSafeInteger(now) || now < 1) throw new Error("Credential revocation request is invalid.")
    await this.initialize()
    const row = await this.db.prepare("SELECT principal FROM wp_codebox_principal_credentials WHERE credential_id = ? AND version = ?").bind(credentialId, version).first<{ principal: string }>()
    if (!row) return false
    const [result] = await this.db.batch([
      this.db.prepare("UPDATE wp_codebox_principal_credentials SET revoked_at = ? WHERE credential_id = ? AND version = ? AND revoked_at IS NULL").bind(now, credentialId, version),
      this.db.prepare("INSERT INTO wp_codebox_principal_credential_audit (at, kind, principal, credential_id, version, reason, dedupe_key) SELECT ?, 'revoked', ?, ?, ?, 'ok', NULL WHERE changes() = 1").bind(now, row.principal, credentialId, version),
      this.trimAuditStatement(),
    ])
    return result.meta.changes === 1
  }

  async authenticate(bearer: string, now = Date.now()): Promise<AuthenticatedPrincipal | null> {
    const decision = await this.authorizeDigest(await bearerDigest(bearer), undefined, undefined, now)
    if (decision.status === "not-found") await this.recordUnknownDenial(now)
    return decision.status === "allowed" ? decision.principal : null
  }

  async authorize(bearer: string, scope: string, siteId?: string, now = Date.now()): Promise<AuthenticatedPrincipal | null> {
    const decision = await this.authorizeDigest(await bearerDigest(bearer), scope, siteId, now)
    if (decision.status === "not-found") await this.recordUnknownDenial(now)
    return decision.status === "allowed" ? decision.principal : null
  }

  async authorizeDigest(digest: string, scope?: string, siteId?: string, now = Date.now()): Promise<CredentialAuthorizationDecision> {
    if (!/^[a-f0-9]{64}$/.test(digest) || (scope !== undefined && !SCOPES.has(scope)) || (siteId !== undefined && !validSiteId(siteId)) || !Number.isSafeInteger(now) || now < 1) throw new Error("Credential authorization request is invalid.")
    await this.initialize()
    const row = await this.db.prepare("SELECT credential_id, version, principal, scopes, expires_at, max_sites, sites, revoked_at FROM wp_codebox_principal_credentials WHERE digest = ?").bind(digest).first<Record<string, unknown>>()
    if (!row) return { status: "not-found" }
    const value = hydrate(row)
    const reason = row.revoked_at !== null ? "revoked" : Date.parse(value.expiresAt) <= now ? "expired" : scope && !value.scopes.includes(scope) ? "scope" : siteId && value.sites && !value.sites.includes(siteId) ? "site" : null
    if (reason) {
      await this.audit("denied", value.principal, value.credentialId, value.version, reason, now)
      return { status: "denied", reason, principal: value.principal, credentialId: value.credentialId, version: value.version }
    }
    await this.audit("authenticated", value.principal, value.credentialId, value.version, "ok", now)
    return { status: "allowed", principal: value }
  }

  async recordUnknownDenial(now = Date.now()): Promise<void> {
    if (!Number.isSafeInteger(now) || now < 1) throw new Error("Credential audit time is invalid.")
    await this.initialize()
    const bucket = Math.floor(now / UNKNOWN_AUDIT_BUCKET_MS)
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO wp_codebox_principal_credential_audit (at, kind, principal, credential_id, version, reason, dedupe_key) VALUES (?, 'denied', NULL, NULL, NULL, 'unknown', ?)").bind(now, `unknown:${bucket}`),
      this.trimAuditStatement(),
    ])
  }

  async auditEvents(limit = 100): Promise<CredentialAuditEvent[]> {
    await this.initialize()
    const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 100
    const rows = await this.db.prepare("SELECT id, at, kind, principal, credential_id, version, reason FROM wp_codebox_principal_credential_audit ORDER BY id DESC LIMIT ?").bind(bounded).all<CredentialAuditEvent & { credential_id: string | null }>()
    return rows.results.map(({ credential_id: credentialId, ...event }) => Object.freeze({ ...event, credentialId }))
  }

  private async audit(kind: CredentialAuditEvent["kind"], principal: string | null, credentialId: string | null, version: string | null, reason: CredentialAuditEvent["reason"], at = Date.now()): Promise<void> {
    await this.db.batch([this.auditStatement(kind, principal, credentialId, version, reason, at), this.trimAuditStatement()])
  }

  private auditStatement(kind: CredentialAuditEvent["kind"], principal: string | null, credentialId: string | null, version: string | null, reason: CredentialAuditEvent["reason"], at: number): D1PreparedStatement {
    const dedupeKey = kind === "denied" ? `denied:${credentialId}:${version}:${reason}:${Math.floor(at / UNKNOWN_AUDIT_BUCKET_MS)}` : null
    return this.db.prepare("INSERT OR IGNORE INTO wp_codebox_principal_credential_audit (at, kind, principal, credential_id, version, reason, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(at, kind, principal, credentialId, version, reason, dedupeKey)
  }
  private trimAuditStatement(): D1PreparedStatement { return this.db.prepare("DELETE FROM wp_codebox_principal_credential_audit WHERE id IN (SELECT id FROM wp_codebox_principal_credential_audit ORDER BY id DESC LIMIT -1 OFFSET ?)").bind(this.auditLimit) }
}

function validate(input: PrincipalCredentialVersion): void {
  if (!identifier(input.credentialId) || !identifier(input.version) || !principalId(input.principal) || !/^[a-f0-9]{64}$/.test(input.digest) || !validPolicy(input)) throw new Error("Credential policy is invalid.")
}
function validPolicy(value: PrincipalCredentialPolicy): boolean {
  let canonicalExpiry: string
  try { canonicalExpiry = new Date(value.expiresAt).toISOString() } catch { return false }
  return Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 4 && new Set(value.scopes).size === value.scopes.length && value.scopes.every((scope) => SCOPES.has(scope)) && Number.isInteger(value.maxSites) && value.maxSites >= 0 && value.maxSites <= 10_000 && canonicalExpiry === value.expiresAt && Date.parse(value.expiresAt) > 0 && (value.sites === undefined || (Array.isArray(value.sites) && value.sites.length <= 256 && new Set(value.sites).size === value.sites.length && value.sites.every(validSiteId)))
}
function hydrate(row: Record<string, unknown>): AuthenticatedPrincipal {
  const scopes = parseArray(row.scopes)
  const sites = row.sites === null ? undefined : parseArray(row.sites)
  let expiresAt: string
  try { expiresAt = new Date(Number(row.expires_at)).toISOString() } catch { throw new Error("Stored credential policy is invalid.") }
  if (!identifier(row.credential_id) || !identifier(row.version) || !principalId(row.principal) || !scopes || (row.sites !== null && !sites)) throw new Error("Stored credential policy is invalid.")
  const value: AuthenticatedPrincipal = { credentialId: row.credential_id, version: row.version, principal: row.principal, scopes, expiresAt, maxSites: Number(row.max_sites), ...(sites ? { sites } : {}) }
  if (!validPolicy(value)) throw new Error("Stored credential policy is invalid.")
  return value
}
function sameCredential(row: Record<string, unknown>, input: PrincipalCredentialVersion, scopes: string, sites: string | null, expiresAt: number): boolean { return row.digest === input.digest && row.principal === input.principal && row.scopes === scopes && row.expires_at === expiresAt && row.max_sites === input.maxSites && row.sites === sites }
function parseArray(value: unknown): string[] | null { try { const parsed = JSON.parse(value as string); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null } catch { return null } }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) }
function principalId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) }
function validSiteId(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63 }
async function bearerDigest(value: string): Promise<string> { const bytes = new TextEncoder().encode(value); if (!value || bytes.byteLength > 4_096) throw new Error("Credential bearer is invalid."); return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, "0")).join("") }
