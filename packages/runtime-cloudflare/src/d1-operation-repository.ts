import type { MarkdownPointer } from "./revision-coordinator.js"
import type { SiteContext } from "./site-context.js"

export const STATIC_ARTIFACT_OPERATION_SCHEMA = "wp-codebox/cloudflare-static-artifact-operation/v1"
export type StaticArtifactOperationState = "queued" | "running" | "retryable" | "publication-pending" | "succeeded" | "failed"
export interface StaticArtifactOperationInput { idempotencyKey: string; fingerprint: string; artifact: { r2Key: string; sha256: string; size: number }; options: { slug: string; name: string; siteTitle: string } }
export interface OperationAttempt { number: number; startedAt: string; completedAt: string | null; state: string; stage: string; error: { code: string; message: string } | null }
export interface OperationReceipt { input: StaticArtifactOperationInput; ssiResult: unknown; canonical: { pointer: MarkdownPointer; version: number }; publication: { status: "pending"; jobKey: string } | { status: "promoted"; jobKey: string; revision: string } | { status: "superseded" | "orphaned"; jobKey: string } | { status: "none" }; siteUrl: string; canonicalCompletedAt: string; terminalCompletedAt: string | null }
export interface StaticArtifactOperation {
  schema: typeof STATIC_ARTIFACT_OPERATION_SCHEMA
  site: Pick<SiteContext, "id" | "hostname" | "origin">
  operationId: string
  state: StaticArtifactOperationState
  input: StaticArtifactOperationInput
  attempts: number
  attemptHistory: OperationAttempt[]
  stage: string
  progress: number
  retryAt: number | null
  claimExpiresAt: number | null
  prepared: { pointer: MarkdownPointer; version: number; ssiResult: unknown; publicationJobKey: string | null } | null
  error: { code: string; message: string } | null
  receipt: OperationReceipt | null
}

export class OperationConflict extends Error {}
const schemaReady = new WeakMap<object, Promise<void>>()

export function shouldRecoverPreparedCommit(prepared: StaticArtifactOperation["prepared"], committed: MarkdownPointer | null): boolean {
  return !!prepared && !!committed && prepared.pointer.revision === committed.revision && prepared.pointer.manifestKey === committed.manifestKey && prepared.pointer.persistedAt === committed.persistedAt
}

export class D1OperationRepository {
  constructor(private readonly database: D1Database, private readonly claimMs = 600_000) {}

  async createOrConverge(site: SiteContext, input: StaticArtifactOperationInput): Promise<{ operation: StaticArtifactOperation; created: boolean }> {
    await ensureSchema(this.database)
    const now = Date.now()
    await this.database.prepare(`INSERT OR IGNORE INTO wp_codebox_sites (site_id, hostname, origin, state, created_at, activated_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)`).bind(site.id, site.hostname, site.origin, now, now, now).run()
    const registered = await this.database.prepare(`SELECT hostname, origin, state FROM wp_codebox_sites WHERE site_id = ?`).bind(site.id).first<{ hostname: string; origin: string; state: string }>()
    if (!registered) throw new Error("D1 site registration was not observable.")
    if (registered && (registered.hostname !== site.hostname || registered.origin !== site.origin || registered.state !== "active")) throw new OperationConflict("The configured site identity conflicts with its registered D1 site.")
    const existing = await this.byKey(site.id, input.idempotencyKey)
    if (existing) {
      if (existing.input.fingerprint !== input.fingerprint) throw new OperationConflict("The idempotency key is already bound to a different immutable input.")
      return { operation: existing, created: false }
    }
    try {
      await this.database.prepare(`INSERT INTO wp_codebox_operations (site_id, operation_id, idempotency_key, fingerprint, artifact_key, artifact_sha256, artifact_size, slug, name, site_title, state, stage, progress, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'created', 0, 0, ?, ?)`)
        .bind(site.id, crypto.randomUUID(), input.idempotencyKey, input.fingerprint, input.artifact.r2Key, input.artifact.sha256, input.artifact.size, input.options.slug, input.options.name, input.options.siteTitle, now, now).run()
    } catch (error) {
      const raced = await this.byKey(site.id, input.idempotencyKey)
      if (raced?.input.fingerprint === input.fingerprint) return { operation: raced, created: false }
      if (raced) throw new OperationConflict("The idempotency key is already bound to a different immutable input.")
      const active = await this.database.prepare(`SELECT operation_id FROM wp_codebox_operations WHERE site_id = ? AND state IN ('queued','running','retryable')`).bind(site.id).first<{ operation_id: string }>()
      if (active) throw new OperationConflict("A mutating operation is already active for this site.")
      throw error
    }
    const operation = await this.byKey(site.id, input.idempotencyKey)
    if (!operation) throw new Error("D1 operation insert was not observable.")
    return { operation, created: true }
  }

  async get(siteId: string, operationId: string): Promise<StaticArtifactOperation | null> {
    await ensureSchema(this.database)
    const row = await this.database.prepare(`${operationSelect} WHERE o.site_id = ? AND o.operation_id = ?`).bind(siteId, operationId).first<Row>()
    return row ? this.hydrate(row) : null
  }

  async claimNext(siteId: string, now = Date.now()): Promise<(StaticArtifactOperation & { claimToken: string }) | null> {
    await ensureSchema(this.database)
    const candidate = await this.database.prepare(`SELECT operation_id FROM wp_codebox_operations WHERE site_id = ? AND (state = 'queued' OR (state = 'retryable' AND retry_at <= ?) OR (state = 'running' AND claim_expires_at <= ?)) ORDER BY created_at LIMIT 1`).bind(siteId, now, now).first<{ operation_id: string }>()
    if (!candidate) return null
    const token = crypto.randomUUID()
    const expiresAt = now + this.claimMs
    const [update, attempt] = await this.database.batch([
      this.database.prepare(`UPDATE wp_codebox_operations SET state = 'running', stage = 'claimed', claim_token = ?, claim_expires_at = ?, attempts = attempts + 1, retry_at = NULL, error_code = NULL, error_message = NULL, updated_at = ? WHERE site_id = ? AND operation_id = ? AND (state = 'queued' OR (state = 'retryable' AND retry_at <= ?) OR (state = 'running' AND claim_expires_at <= ?))`).bind(token, expiresAt, now, siteId, candidate.operation_id, now, now),
      this.database.prepare(`INSERT INTO wp_codebox_operation_attempts (site_id, operation_id, attempt_number, claim_token, started_at, state, stage) SELECT site_id, operation_id, attempts, ?, ?, 'running', 'claimed' FROM wp_codebox_operations WHERE site_id = ? AND operation_id = ? AND state = 'running' AND claim_token = ? AND claim_expires_at = ?`).bind(token, new Date(now).toISOString(), siteId, candidate.operation_id, token, expiresAt),
    ])
    if (update.meta.changes !== 1) return null
    if (attempt.meta.changes !== 1) throw new OperationConflict("Operation attempt creation did not match its claim.")
    const operation = await this.get(siteId, candidate.operation_id)
    if (!operation) throw new Error("Claimed operation is unavailable.")
    return { ...operation, claimToken: token }
  }

  async renew(siteId: string, operationId: string, token: string): Promise<void> {
    await this.ownedUpdate(siteId, operationId, token, `UPDATE wp_codebox_operations SET claim_expires_at = ?, updated_at = ?`, [Date.now() + this.claimMs, Date.now()])
  }

  async checkpoint(siteId: string, operationId: string, token: string, stage: string, progress: number): Promise<void> {
    await this.ownedUpdate(siteId, operationId, token, `UPDATE wp_codebox_operations SET stage = ?, progress = ?, updated_at = ?`, [stage, progress, Date.now()])
  }

  async prepareCommit(siteId: string, operationId: string, token: string, version: number, pointer: MarkdownPointer, ssiResult: unknown, publicationJobKey: string | null): Promise<void> {
    await this.ownedUpdate(siteId, operationId, token, `UPDATE wp_codebox_operations SET prepared_version = ?, prepared_revision = ?, prepared_manifest_key = ?, prepared_persisted_at = ?, prepared_result_json = ?, prepared_publication_job = ?, stage = 'prepared-commit', progress = 85, updated_at = ?`, [version, pointer.revision, pointer.manifestKey, pointer.persistedAt, JSON.stringify(ssiResult), publicationJobKey, Date.now()])
  }

  async recordCommit(siteId: string, operationId: string, token: string): Promise<void> {
    await this.ownedUpdate(siteId, operationId, token, `UPDATE wp_codebox_operations SET stage = 'committed', progress = 90, updated_at = ?`, [Date.now()])
  }

  async complete(siteId: string, operationId: string, token: string, ssiResult: unknown | undefined, publicationJobKey: string | undefined, siteUrl: string): Promise<void> {
    const operation = await this.get(siteId, operationId)
    if (!operation?.prepared) throw new OperationConflict("A prepared canonical pointer is required before operation completion.")
    const now = new Date().toISOString()
    const result = ssiResult ?? operation.prepared.ssiResult
    const jobKey = publicationJobKey ?? operation.prepared.publicationJobKey ?? undefined
    const receipt: OperationReceipt = { input: operation.input, ssiResult: result, canonical: { pointer: operation.prepared.pointer, version: operation.prepared.version }, publication: jobKey ? { status: "pending", jobKey } : { status: "none" }, siteUrl, canonicalCompletedAt: now, terminalCompletedAt: jobKey ? null : now }
    const state: StaticArtifactOperationState = jobKey ? "publication-pending" : "succeeded"
    const stage = jobKey ? "canonical-completed-publication-pending" : "completed"
    await this.terminalBatch(siteId, operationId, token, `UPDATE wp_codebox_operations SET state = ?, stage = ?, progress = ?, receipt_json = ?, error_code = NULL, error_message = NULL, claim_token = NULL, claim_expires_at = NULL, retry_at = NULL, completed_at = ?, updated_at = ?`, [state, stage, jobKey ? 95 : 100, JSON.stringify(receipt), jobKey ? null : now, Date.now()], state, stage, null)
  }

  async retry(siteId: string, operationId: string, token: string, error: unknown, retryAt: number): Promise<void> { await this.finish(siteId, operationId, token, "retryable", error, retryAt) }
  async fail(siteId: string, operationId: string, token: string, error: unknown): Promise<void> { await this.finish(siteId, operationId, token, "failed", error, null) }

  private async finish(siteId: string, operationId: string, token: string, state: "retryable" | "failed", error: unknown, retryAt: number | null): Promise<void> {
    const sanitized = sanitizeError(error)
    const completedAt = state === "failed" ? new Date().toISOString() : null
    await this.terminalBatch(siteId, operationId, token, `UPDATE wp_codebox_operations SET state = ?, stage = ?, error_code = ?, error_message = ?, retry_at = ?, claim_token = NULL, claim_expires_at = NULL, completed_at = ?, updated_at = ?`, [state, state, sanitized.code, sanitized.message, retryAt, completedAt, Date.now()], state, state, sanitized)
  }

  private async ownedUpdate(siteId: string, operationId: string, token: string, update: string, values: unknown[]): Promise<void> {
    const result = await this.database.prepare(`${update} WHERE site_id = ? AND operation_id = ? AND state = 'running' AND claim_token = ? AND claim_expires_at > ?`).bind(...values, siteId, operationId, token, Date.now()).run()
    if (result.meta.changes !== 1) throw new OperationConflict("Operation claim expired or changed.")
  }

  private async terminalBatch(siteId: string, operationId: string, token: string, update: string, values: unknown[], state: string, stage: string, error: { code: string; message: string } | null): Promise<void> {
    const now = Date.now()
    const [attempt, operation] = await this.database.batch([
      this.database.prepare(`UPDATE wp_codebox_operation_attempts SET completed_at = ?, state = ?, stage = ?, error_code = ?, error_message = ? WHERE site_id = ? AND operation_id = ? AND claim_token = ? AND completed_at IS NULL AND EXISTS (SELECT 1 FROM wp_codebox_operations WHERE site_id = ? AND operation_id = ? AND state = 'running' AND claim_token = ? AND claim_expires_at > ?)`).bind(new Date(now).toISOString(), state, stage, error?.code ?? null, error?.message ?? null, siteId, operationId, token, siteId, operationId, token, now),
      this.database.prepare(`${update} WHERE site_id = ? AND operation_id = ? AND state = 'running' AND claim_token = ? AND claim_expires_at > ?`).bind(...values, siteId, operationId, token, now),
    ])
    if (attempt.meta.changes !== 1 || operation.meta.changes !== 1) throw new OperationConflict("Operation claim expired or changed.")
  }

  async reconcilePublication(siteId: string, jobKey: string, outcome: "promoted" | "superseded" | "orphaned", revision?: string): Promise<void> {
    if (outcome === "promoted" && !revision) return
    const row = await this.database.prepare(`${operationSelect} WHERE o.site_id = ? AND o.state = 'publication-pending' AND o.prepared_publication_job = ?`).bind(siteId, jobKey).first<Row>()
    if (!row) return
    const operation = await this.hydrate(row)
    if (!operation.receipt || operation.receipt.publication.status !== "pending") return
    const completedAt = new Date().toISOString()
    const receipt: OperationReceipt = { ...operation.receipt, publication: outcome === "promoted" ? { status: "promoted", jobKey, revision: revision! } : { status: outcome, jobKey }, terminalCompletedAt: completedAt }
    const failed = outcome !== "promoted"
    await this.database.prepare(`UPDATE wp_codebox_operations SET state = ?, stage = ?, progress = 100, receipt_json = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE site_id = ? AND operation_id = ? AND state = 'publication-pending' AND prepared_publication_job = ?`).bind(failed ? "failed" : "succeeded", failed ? `publication-${outcome}` : "published", JSON.stringify(receipt), failed ? `publication_${outcome}` : null, failed ? `Publication ${outcome}.` : null, completedAt, Date.now(), siteId, operation.operationId, jobKey).run()
  }

  async pendingPublicationJobs(siteId: string, limit = 16): Promise<string[]> {
    await ensureSchema(this.database)
    const rows = await this.database.prepare(`SELECT prepared_publication_job FROM wp_codebox_operations WHERE site_id = ? AND state = 'publication-pending' AND prepared_publication_job IS NOT NULL ORDER BY updated_at LIMIT ?`).bind(siteId, limit).all<{ prepared_publication_job: string }>()
    return rows.results.map((row) => row.prepared_publication_job)
  }

  private async byKey(siteId: string, key: string): Promise<StaticArtifactOperation | null> {
    const row = await this.database.prepare(`${operationSelect} WHERE o.site_id = ? AND o.idempotency_key = ?`).bind(siteId, key).first<Row>()
    return row ? this.hydrate(row) : null
  }

  private async hydrate(row: Row): Promise<StaticArtifactOperation> {
    const attempts = await this.database.prepare(`SELECT attempt_number, claim_token, started_at, completed_at, state, stage, error_code, error_message FROM wp_codebox_operation_attempts WHERE site_id = ? AND operation_id = ? ORDER BY attempt_number DESC LIMIT 10`).bind(row.site_id, row.operation_id).all<AttemptRow>()
    return operationFromRow(row, attempts.results)
  }
}

const operationSelect = `SELECT o.*, s.hostname, s.origin FROM wp_codebox_operations o JOIN wp_codebox_sites s ON s.site_id = o.site_id`
interface Row { site_id: string; hostname: string; origin: string; operation_id: string; idempotency_key: string; fingerprint: string; artifact_key: string; artifact_sha256: string; artifact_size: number; slug: string; name: string; site_title: string; state: StaticArtifactOperationState; stage: string; progress: number; attempts: number; retry_at: number | null; claim_expires_at: number | null; prepared_version: number | null; prepared_revision: string | null; prepared_manifest_key: string | null; prepared_persisted_at: string | null; prepared_result_json: string | null; prepared_publication_job: string | null; error_code: string | null; error_message: string | null; receipt_json: string | null }
interface AttemptRow { attempt_number: number; claim_token: string; started_at: string; completed_at: string | null; state: string; stage: string; error_code: string | null; error_message: string | null }
function operationFromRow(row: Row, attempts: AttemptRow[]): StaticArtifactOperation {
  const prepared = row.prepared_version !== null && row.prepared_revision && row.prepared_manifest_key && row.prepared_persisted_at && row.prepared_result_json ? { version: row.prepared_version, pointer: { revision: row.prepared_revision, manifestKey: row.prepared_manifest_key, persistedAt: row.prepared_persisted_at }, ssiResult: JSON.parse(row.prepared_result_json), publicationJobKey: row.prepared_publication_job } : null
  const input = { idempotencyKey: row.idempotency_key, fingerprint: row.fingerprint, artifact: { r2Key: row.artifact_key, sha256: row.artifact_sha256, size: row.artifact_size }, options: { slug: row.slug, name: row.name, siteTitle: row.site_title } }
  return { schema: STATIC_ARTIFACT_OPERATION_SCHEMA, site: { id: row.site_id, hostname: row.hostname, origin: row.origin }, operationId: row.operation_id, state: row.state, input, attempts: row.attempts, attemptHistory: attempts.map((attempt) => ({ number: attempt.attempt_number, startedAt: attempt.started_at, completedAt: attempt.completed_at, state: attempt.state, stage: attempt.stage, error: attempt.error_code ? { code: attempt.error_code, message: attempt.error_message ?? "Operation failed." } : null })), stage: row.stage, progress: row.progress, retryAt: row.retry_at, claimExpiresAt: row.claim_expires_at, prepared, error: row.error_code ? { code: row.error_code, message: row.error_message ?? "Operation failed." } : null, receipt: row.receipt_json ? JSON.parse(row.receipt_json) as OperationReceipt : null }
}
function sanitizeError(error: unknown): { code: string; message: string } { const message = error instanceof Error ? error.message : "Operation failed."; return { code: error instanceof OperationConflict ? "conflict" : "execution_failed", message: message.replace(/[\r\n\t]/g, " ").slice(0, 500) } }
async function ensureSchema(database: D1Database): Promise<void> {
  const existing = schemaReady.get(database as object)
  if (!existing) {
    const pending = (async () => {
      await database.prepare(`CREATE TABLE IF NOT EXISTS wp_codebox_sites (site_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active')), created_at INTEGER NOT NULL, activated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run()
      await database.prepare(`CREATE TABLE IF NOT EXISTS wp_codebox_operations (site_id TEXT NOT NULL, operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, artifact_key TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, artifact_size INTEGER NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, site_title TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued','running','retryable','publication-pending','succeeded','failed')), stage TEXT NOT NULL, progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100), attempts INTEGER NOT NULL, retry_at INTEGER, claim_token TEXT, claim_expires_at INTEGER, prepared_version INTEGER, prepared_revision TEXT, prepared_manifest_key TEXT, prepared_persisted_at TEXT, prepared_result_json TEXT, prepared_publication_job TEXT, receipt_json TEXT, error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at TEXT, PRIMARY KEY (site_id, operation_id), UNIQUE (site_id, idempotency_key), FOREIGN KEY (site_id) REFERENCES wp_codebox_sites(site_id))`).run()
      await database.prepare(`CREATE TABLE IF NOT EXISTS wp_codebox_operation_attempts (site_id TEXT NOT NULL, operation_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, claim_token TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, state TEXT NOT NULL, stage TEXT NOT NULL, error_code TEXT, error_message TEXT, PRIMARY KEY (site_id, operation_id, attempt_number), FOREIGN KEY (site_id, operation_id) REFERENCES wp_codebox_operations(site_id, operation_id))`).run()
      await database.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS wp_codebox_one_active_operation ON wp_codebox_operations(site_id) WHERE state IN ('queued','running','retryable')`).run()
      await database.prepare(`CREATE INDEX IF NOT EXISTS wp_codebox_operation_ready ON wp_codebox_operations(site_id, state, retry_at, claim_expires_at, created_at)`).run()
    })()
    schemaReady.set(database as object, pending)
    pending.catch(() => schemaReady.delete(database as object))
  }
  await schemaReady.get(database as object)
}
