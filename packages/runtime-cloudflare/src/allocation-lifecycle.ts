import type { SiteContext } from "./site-context.js"

export type AllocationLifecycleState = "active" | "deleting" | "tombstoned"
export interface AllocationIdentity { siteId: string; generation: number }
export interface AllocationRetentionPolicy { ttlMs: number; retainMs: number }
export interface AllocationDeletionReceipt { schema: "wp-codebox/cloudflare-allocation-deletion-receipt/v1"; siteId: string; generation: number; deletedObjects: number; deletedBytes: number; deletedRecords: number; retainedObjects: number; retainedBytes: number; retainedRecords: number; unresolvedObjects: number; unresolvedRecords: number; startedAt: string; completedAt: string; terminalState: "tombstoned" }
export interface AllocationLifecycle { identity: AllocationIdentity; principal: string; state: AllocationLifecycleState; expiresAt: number; retainUntil: number; mutationFence: number; operationFence: number; cleanupCursor: string | null; deletedObjects: number; deletedBytes: number; deletedRecords: number; receipt: AllocationDeletionReceipt | null }

const RECEIPT_SCHEMA = "wp-codebox/cloudflare-allocation-deletion-receipt/v1" as const
const schemaReady = new WeakMap<object, Promise<void>>()

/** Durable lifecycle policy for elastic Cloudflare site allocations. */
export class CloudflareAllocationLifecycle {
  constructor(private readonly database: D1Database, private readonly policy: AllocationRetentionPolicy = { ttlMs: 24 * 60 * 60 * 1000, retainMs: 60 * 60 * 1000 }) {
    if (!Number.isSafeInteger(policy.ttlMs) || !Number.isSafeInteger(policy.retainMs) || policy.ttlMs < 1 || policy.retainMs < 0) throw new Error("Allocation lifecycle policy is invalid.")
  }

  async initialize(): Promise<void> { await ensureSchema(this.database) }
  async create(site: SiteContext, principal: string, now = Date.now()): Promise<AllocationLifecycle> {
    await this.initialize()
    const identity = allocationIdentity(site.id)
    await this.database.prepare("INSERT OR IGNORE INTO wp_codebox_site_lifecycles (site_id, generation, principal, state, expires_at, retain_until, mutation_fence, operation_fence, cleanup_cursor, deleted_objects, deleted_bytes, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, 1, 1, NULL, 0, 0, ?, ?)").bind(site.id, identity.generation, principal, now + this.policy.ttlMs, now + this.policy.ttlMs + this.policy.retainMs, now, now).run()
    const lifecycle = await this.get(identity)
    if (!lifecycle || lifecycle.principal !== principal) throw new AllocationLifecycleConflict("Allocation identity conflicts with an existing owner.")
    return lifecycle
  }
  async get(identity: AllocationIdentity): Promise<AllocationLifecycle | null> {
    await this.initialize()
    const row = await this.database.prepare("SELECT site_id, generation, principal, state, expires_at, retain_until, mutation_fence, operation_fence, cleanup_cursor, deleted_objects, deleted_bytes, deleted_records, receipt_json FROM wp_codebox_site_lifecycles WHERE site_id = ? AND generation = ?").bind(identity.siteId, identity.generation).first<LifecycleRow>()
    return row ? hydrate(row) : null
  }
  async renew(identity: AllocationIdentity, principal: string, now = Date.now()): Promise<AllocationLifecycle> {
    await this.initialize()
    const result = await this.database.prepare("UPDATE wp_codebox_site_lifecycles SET expires_at = ?, retain_until = ?, updated_at = ? WHERE site_id = ? AND generation = ? AND principal = ? AND state = 'active' AND expires_at > ?").bind(now + this.policy.ttlMs, now + this.policy.ttlMs + this.policy.retainMs, now, identity.siteId, identity.generation, principal, now).run()
    if (result.meta.changes !== 1) throw new AllocationLifecycleConflict("Allocation is not renewable by this owner.")
    return (await this.get(identity))!
  }
  async beginMutation(identity: AllocationIdentity, principal: string, now = Date.now()): Promise<number> {
    await this.initialize()
    const result = await this.database.prepare("UPDATE wp_codebox_site_lifecycles SET mutation_fence = mutation_fence + 1, updated_at = ? WHERE site_id = ? AND generation = ? AND principal = ? AND state = 'active' AND expires_at > ?").bind(now, identity.siteId, identity.generation, principal, now).run()
    if (result.meta.changes !== 1) throw new AllocationLifecycleConflict("Allocation is not mutable by this owner.")
    return (await this.get(identity))!.mutationFence
  }
  async assertMutation(identity: AllocationIdentity, fence: number, now = Date.now()): Promise<void> {
    const lifecycle = await this.get(identity)
    if (!lifecycle || lifecycle.state !== "active" || lifecycle.expiresAt <= now || lifecycle.mutationFence !== fence) throw new AllocationLifecycleConflict("Allocation mutation fence changed.")
  }
  async assertActive(identity: AllocationIdentity, now = Date.now()): Promise<void> {
    const lifecycle = await this.get(identity)
    if (lifecycle && (lifecycle.state !== "active" || lifecycle.expiresAt <= now)) throw new AllocationLifecycleConflict("Allocation is no longer active.")
  }
  async beginDeletion(identity: AllocationIdentity, principal: string | null, now = Date.now()): Promise<number> {
    await this.initialize()
    const owner = principal === null ? "" : " AND principal = ?"
    const values: unknown[] = [now + this.policy.retainMs, now, identity.siteId, identity.generation]
    if (principal !== null) values.push(principal)
    const result = await this.database.prepare(`UPDATE wp_codebox_site_lifecycles SET state = 'deleting', mutation_fence = mutation_fence + 1, operation_fence = operation_fence + 1, retain_until = MIN(retain_until, ?), cleanup_cursor = NULL, updated_at = ? WHERE site_id = ? AND generation = ?${owner} AND state = 'active'`).bind(...values).run()
    if (result.meta.changes !== 1) throw new AllocationLifecycleConflict("Allocation is not deletable by this owner.")
    const lifecycle = (await this.get(identity))!
    await this.cancelWork(identity, now)
    return lifecycle.operationFence
  }
  async expire(now = Date.now(), limit = 8): Promise<AllocationIdentity[]> {
    await this.initialize()
    const rows = await this.database.prepare("SELECT site_id, generation FROM wp_codebox_site_lifecycles WHERE state = 'active' AND expires_at <= ? ORDER BY expires_at LIMIT ?").bind(now, limit).all<Pick<LifecycleRow, "site_id" | "generation">>()
    const expired: AllocationIdentity[] = []
    for (const row of rows.results) {
      try { await this.beginDeletion({ siteId: row.site_id, generation: row.generation }, null, now); expired.push({ siteId: row.site_id, generation: row.generation }) } catch { /* A competing owner or sweeper already fenced it. */ }
    }
    return expired
  }
  async pendingDeletions(limit = 8, now = Date.now()): Promise<Array<AllocationLifecycle>> {
    await this.initialize()
    const rows = await this.database.prepare("SELECT site_id, generation, principal, state, expires_at, retain_until, mutation_fence, operation_fence, cleanup_cursor, deleted_objects, deleted_bytes, deleted_records, receipt_json FROM wp_codebox_site_lifecycles WHERE state = 'deleting' AND retain_until <= ? ORDER BY updated_at LIMIT ?").bind(now, limit).all<LifecycleRow>()
    return rows.results.map(hydrate)
  }
  async reclaim(bucket: Pick<R2Bucket, "list" | "delete">, identity: AllocationIdentity, operationFence: number, limit = 100, now = Date.now()): Promise<AllocationLifecycle> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Allocation reclamation limit is invalid.")
    const lifecycle = await this.get(identity)
    if (!lifecycle || lifecycle.state !== "deleting" || lifecycle.operationFence !== operationFence) throw new AllocationLifecycleConflict("Allocation deletion fence changed.")
    if (lifecycle.retainUntil > now) throw new AllocationLifecycleConflict("Allocation retention period is still active.")
    const page = await bucket.list({ prefix: `sites/${identity.siteId}/`, cursor: lifecycle.cleanupCursor ?? undefined, limit })
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key))
    const cursor = page.truncated ? page.cursor : null
    const deletedBytes = page.objects.reduce((total, object) => total + (object.size ?? 0), 0)
    const cleaned = cursor ? { deleted: 0, unresolved: 0 } : await this.cleanupWork(identity.siteId, limit)
    const updated = await this.database.prepare("UPDATE wp_codebox_site_lifecycles SET cleanup_cursor = ?, deleted_objects = deleted_objects + ?, deleted_bytes = deleted_bytes + ?, deleted_records = deleted_records + ?, updated_at = ? WHERE site_id = ? AND generation = ? AND state = 'deleting' AND operation_fence = ?").bind(cursor, page.objects.length, deletedBytes, cleaned.deleted, now, identity.siteId, identity.generation, operationFence).run()
    if (updated.meta.changes !== 1) throw new AllocationLifecycleConflict("Allocation deletion fence changed.")
    if (cursor || cleaned.unresolved) return (await this.get(identity))!
    const receipt: AllocationDeletionReceipt = { schema: RECEIPT_SCHEMA, siteId: identity.siteId, generation: identity.generation, deletedObjects: lifecycle.deletedObjects + page.objects.length, deletedBytes: lifecycle.deletedBytes + deletedBytes, deletedRecords: lifecycle.deletedRecords + cleaned.deleted, retainedObjects: 0, retainedBytes: 0, retainedRecords: 0, unresolvedObjects: 0, unresolvedRecords: 0, startedAt: new Date(lifecycle.expiresAt).toISOString(), completedAt: new Date(now).toISOString(), terminalState: "tombstoned" }
    await this.database.batch([
      this.database.prepare("INSERT OR IGNORE INTO wp_codebox_site_deletion_receipts (site_id, generation, receipt_json, created_at) VALUES (?, ?, ?, ?)").bind(identity.siteId, identity.generation, JSON.stringify(receipt), now),
      this.database.prepare("UPDATE wp_codebox_site_lifecycles SET state = 'tombstoned', cleanup_cursor = NULL, receipt_json = ?, terminal_at = ?, updated_at = ? WHERE site_id = ? AND generation = ? AND state = 'deleting' AND operation_fence = ?").bind(JSON.stringify(receipt), now, now, identity.siteId, identity.generation, operationFence),
    ])
    return (await this.get(identity))!
  }
  private async cancelWork(identity: AllocationIdentity, now: number): Promise<void> {
    if (await tableExists(this.database, "wp_codebox_operations") && await tableExists(this.database, "wp_codebox_operation_attempts")) {
      await this.database.batch([
        this.database.prepare("UPDATE wp_codebox_operation_attempts SET completed_at = ?, state = 'failed', stage = 'allocation-deleted', error_code = 'allocation_deleted', error_message = 'Allocation deletion fenced this attempt.' WHERE site_id = ? AND completed_at IS NULL").bind(new Date(now).toISOString(), identity.siteId),
        this.database.prepare("UPDATE wp_codebox_operations SET state = 'failed', stage = 'allocation-deleted', progress = 100, claim_token = NULL, claim_expires_at = NULL, retry_at = NULL, error_code = 'allocation_deleted', error_message = 'Allocation deletion fenced this operation.', completed_at = ?, updated_at = ? WHERE site_id = ? AND state IN ('queued','running','retryable','publication-pending')").bind(new Date(now).toISOString(), now, identity.siteId),
      ])
    }
    if (await tableExists(this.database, "wp_codebox_api_admin_claims")) await this.database.prepare("UPDATE wp_codebox_api_admin_claims SET state = 'expired', updated_at = ? WHERE site_id = ? AND state = 'pending'").bind(now, identity.siteId).run()
    if (await tableExists(this.database, "wp_codebox_runtime_dispatches")) await this.database.prepare("UPDATE wp_codebox_runtime_dispatches SET state = 'done', last_error = 'Allocation deletion fenced this dispatch.', completed_at = ?, updated_at = ? WHERE site_id = ? AND state NOT IN ('done','dead-letter')").bind(now, now, identity.siteId).run()
  }
  private async cleanupWork(siteId: string, limit: number): Promise<{ deleted: number; unresolved: number }> {
    let deleted = 0
    if (await tableExists(this.database, "wp_codebox_operation_attempts")) {
      const result = await this.database.prepare("DELETE FROM wp_codebox_operation_attempts WHERE rowid IN (SELECT rowid FROM wp_codebox_operation_attempts WHERE site_id = ? LIMIT ?)").bind(siteId, limit).run(); deleted += result.meta.changes
    }
    if (await tableExists(this.database, "wp_codebox_operations")) {
      const result = await this.database.prepare("DELETE FROM wp_codebox_operations WHERE rowid IN (SELECT rowid FROM wp_codebox_operations WHERE site_id = ? LIMIT ?)").bind(siteId, limit).run(); deleted += result.meta.changes
    }
    if (await tableExists(this.database, "wp_codebox_api_admin_claims")) {
      const result = await this.database.prepare("DELETE FROM wp_codebox_api_admin_claims WHERE site_id = ?").bind(siteId).run(); deleted += result.meta.changes
    }
    if (await tableExists(this.database, "wp_codebox_api_admin_roots")) {
      const result = await this.database.prepare("DELETE FROM wp_codebox_api_admin_roots WHERE site_id = ?").bind(siteId).run(); deleted += result.meta.changes
    }
    for (const table of ["wp_codebox_runtime_dead_letters", "wp_codebox_runtime_dispatches", "wp_codebox_runtime_fairness"]) if (await tableExists(this.database, table)) {
      const result = await this.database.prepare(`DELETE FROM ${table} WHERE site_id = ?`).bind(siteId).run(); deleted += result.meta.changes
    }
    const tables = ["wp_codebox_operation_attempts", "wp_codebox_operations", "wp_codebox_api_admin_claims", "wp_codebox_api_admin_roots", "wp_codebox_runtime_dead_letters", "wp_codebox_runtime_dispatches", "wp_codebox_runtime_fairness"]
    let unresolved = 0
    for (const table of tables) if (await tableExists(this.database, table)) unresolved += (await this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE site_id = ?`).bind(siteId).first<{ count: number }>())?.count ?? 0
    return { deleted, unresolved }
  }
}

export class AllocationLifecycleConflict extends Error {}
export function allocationIdentity(siteId: string): AllocationIdentity {
  const match = /-g([1-9][0-9]*)-[a-f0-9]{16}$/.exec(siteId)
  return { siteId, generation: match ? Number(match[1]) : 1 }
}

interface LifecycleRow { site_id: string; generation: number; principal: string; state: AllocationLifecycleState; expires_at: number; retain_until: number; mutation_fence: number; operation_fence: number; cleanup_cursor: string | null; deleted_objects: number; deleted_bytes: number; deleted_records: number; receipt_json: string | null }
function hydrate(row: LifecycleRow): AllocationLifecycle { return { identity: { siteId: row.site_id, generation: row.generation }, principal: row.principal, state: row.state, expiresAt: row.expires_at, retainUntil: row.retain_until, mutationFence: row.mutation_fence, operationFence: row.operation_fence, cleanupCursor: row.cleanup_cursor, deletedObjects: row.deleted_objects, deletedBytes: row.deleted_bytes, deletedRecords: row.deleted_records, receipt: row.receipt_json ? JSON.parse(row.receipt_json) as AllocationDeletionReceipt : null } }
async function tableExists(database: D1Database, name: string): Promise<boolean> { return !!await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first() }
async function ensureSchema(database: D1Database): Promise<void> {
  let pending = schemaReady.get(database as object)
  if (!pending) {
    pending = (async () => {
      await database.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_site_lifecycles (site_id TEXT NOT NULL, generation INTEGER NOT NULL, principal TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','deleting','tombstoned')), expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL, mutation_fence INTEGER NOT NULL, operation_fence INTEGER NOT NULL, cleanup_cursor TEXT, deleted_objects INTEGER NOT NULL, deleted_bytes INTEGER NOT NULL DEFAULT 0, deleted_records INTEGER NOT NULL DEFAULT 0, receipt_json TEXT, terminal_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (site_id, generation))").run()
      try { await database.prepare("ALTER TABLE wp_codebox_site_lifecycles ADD COLUMN deleted_bytes INTEGER NOT NULL DEFAULT 0").run() } catch (error) { if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error }
      try { await database.prepare("ALTER TABLE wp_codebox_site_lifecycles ADD COLUMN deleted_records INTEGER NOT NULL DEFAULT 0").run() } catch (error) { if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error }
      await database.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_site_deletion_receipts (site_id TEXT NOT NULL, generation INTEGER NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (site_id, generation))").run()
      await database.prepare("CREATE INDEX IF NOT EXISTS wp_codebox_site_lifecycle_expiry ON wp_codebox_site_lifecycles(state, expires_at)").run()
    })()
    schemaReady.set(database as object, pending)
    pending.catch(() => schemaReady.delete(database as object))
  }
  await pending
}
