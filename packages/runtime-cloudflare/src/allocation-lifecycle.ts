import type { SiteContext } from "./site-context.js"

export type AllocationLifecycleState = "active" | "deleting" | "tombstoned"
export interface AllocationIdentity { siteId: string; generation: number }
export interface AllocationRetentionPolicy { ttlMs: number; retainMs: number }
export interface AllocationDeletionReceipt { schema: "wp-codebox/cloudflare-allocation-deletion-receipt/v1"; siteId: string; generation: number; deletedObjects: number; completedAt: string }
export interface AllocationLifecycle { identity: AllocationIdentity; principal: string; state: AllocationLifecycleState; expiresAt: number; retainUntil: number; mutationFence: number; operationFence: number; cleanupCursor: string | null; deletedObjects: number; receipt: AllocationDeletionReceipt | null }

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
    await this.database.prepare("INSERT OR IGNORE INTO wp_codebox_site_lifecycles (site_id, generation, principal, state, expires_at, retain_until, mutation_fence, operation_fence, cleanup_cursor, deleted_objects, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, 1, 1, NULL, 0, ?, ?)").bind(site.id, identity.generation, principal, now + this.policy.ttlMs, now + this.policy.ttlMs + this.policy.retainMs, now, now).run()
    const lifecycle = await this.get(identity)
    if (!lifecycle || lifecycle.principal !== principal) throw new AllocationLifecycleConflict("Allocation identity conflicts with an existing owner.")
    return lifecycle
  }
  async get(identity: AllocationIdentity): Promise<AllocationLifecycle | null> {
    await this.initialize()
    const row = await this.database.prepare("SELECT site_id, generation, principal, state, expires_at, retain_until, mutation_fence, operation_fence, cleanup_cursor, deleted_objects, receipt_json FROM wp_codebox_site_lifecycles WHERE site_id = ? AND generation = ?").bind(identity.siteId, identity.generation).first<LifecycleRow>()
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
  async beginDeletion(identity: AllocationIdentity, principal: string | null, now = Date.now()): Promise<number> {
    await this.initialize()
    const owner = principal === null ? "" : " AND principal = ?"
    const values: unknown[] = [now, identity.siteId, identity.generation]
    if (principal !== null) values.push(principal)
    const result = await this.database.prepare(`UPDATE wp_codebox_site_lifecycles SET state = 'deleting', mutation_fence = mutation_fence + 1, operation_fence = operation_fence + 1, cleanup_cursor = NULL, updated_at = ? WHERE site_id = ? AND generation = ?${owner} AND state = 'active'`).bind(...values).run()
    if (result.meta.changes !== 1) throw new AllocationLifecycleConflict("Allocation is not deletable by this owner.")
    return (await this.get(identity))!.operationFence
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
  async pendingDeletions(limit = 8): Promise<Array<AllocationLifecycle>> {
    await this.initialize()
    const rows = await this.database.prepare("SELECT site_id, generation, principal, state, expires_at, retain_until, mutation_fence, operation_fence, cleanup_cursor, deleted_objects, receipt_json FROM wp_codebox_site_lifecycles WHERE state = 'deleting' ORDER BY updated_at LIMIT ?").bind(limit).all<LifecycleRow>()
    return rows.results.map(hydrate)
  }
  async reclaim(bucket: Pick<R2Bucket, "list" | "delete">, identity: AllocationIdentity, operationFence: number, limit = 100, now = Date.now()): Promise<AllocationLifecycle> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Allocation reclamation limit is invalid.")
    const lifecycle = await this.get(identity)
    if (!lifecycle || lifecycle.state !== "deleting" || lifecycle.operationFence !== operationFence) throw new AllocationLifecycleConflict("Allocation deletion fence changed.")
    const page = await bucket.list({ prefix: `sites/${identity.siteId}/`, cursor: lifecycle.cleanupCursor ?? undefined, limit })
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key))
    const cursor = page.truncated ? page.cursor : null
    const updated = await this.database.prepare("UPDATE wp_codebox_site_lifecycles SET cleanup_cursor = ?, deleted_objects = deleted_objects + ?, updated_at = ? WHERE site_id = ? AND generation = ? AND state = 'deleting' AND operation_fence = ?").bind(cursor, page.objects.length, now, identity.siteId, identity.generation, operationFence).run()
    if (updated.meta.changes !== 1) throw new AllocationLifecycleConflict("Allocation deletion fence changed.")
    if (cursor) return (await this.get(identity))!
    const receipt: AllocationDeletionReceipt = { schema: RECEIPT_SCHEMA, siteId: identity.siteId, generation: identity.generation, deletedObjects: lifecycle.deletedObjects + page.objects.length, completedAt: new Date(now).toISOString() }
    await this.database.batch([
      this.database.prepare("INSERT OR IGNORE INTO wp_codebox_site_deletion_receipts (site_id, generation, receipt_json, created_at) VALUES (?, ?, ?, ?)").bind(identity.siteId, identity.generation, JSON.stringify(receipt), now),
      this.database.prepare("UPDATE wp_codebox_site_lifecycles SET state = 'tombstoned', cleanup_cursor = NULL, receipt_json = ?, terminal_at = ?, updated_at = ? WHERE site_id = ? AND generation = ? AND state = 'deleting' AND operation_fence = ?").bind(JSON.stringify(receipt), now, now, identity.siteId, identity.generation, operationFence),
    ])
    return (await this.get(identity))!
  }
}

export class AllocationLifecycleConflict extends Error {}
export function allocationIdentity(siteId: string): AllocationIdentity {
  const match = /-g([1-9][0-9]*)-[a-f0-9]{16}$/.exec(siteId)
  return { siteId, generation: match ? Number(match[1]) : 1 }
}

interface LifecycleRow { site_id: string; generation: number; principal: string; state: AllocationLifecycleState; expires_at: number; retain_until: number; mutation_fence: number; operation_fence: number; cleanup_cursor: string | null; deleted_objects: number; receipt_json: string | null }
function hydrate(row: LifecycleRow): AllocationLifecycle { return { identity: { siteId: row.site_id, generation: row.generation }, principal: row.principal, state: row.state, expiresAt: row.expires_at, retainUntil: row.retain_until, mutationFence: row.mutation_fence, operationFence: row.operation_fence, cleanupCursor: row.cleanup_cursor, deletedObjects: row.deleted_objects, receipt: row.receipt_json ? JSON.parse(row.receipt_json) as AllocationDeletionReceipt : null } }
async function ensureSchema(database: D1Database): Promise<void> {
  let pending = schemaReady.get(database as object)
  if (!pending) {
    pending = (async () => {
      await database.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_site_lifecycles (site_id TEXT NOT NULL, generation INTEGER NOT NULL, principal TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','deleting','tombstoned')), expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL, mutation_fence INTEGER NOT NULL, operation_fence INTEGER NOT NULL, cleanup_cursor TEXT, deleted_objects INTEGER NOT NULL, receipt_json TEXT, terminal_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (site_id, generation))").run()
      await database.prepare("CREATE TABLE IF NOT EXISTS wp_codebox_site_deletion_receipts (site_id TEXT NOT NULL, generation INTEGER NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (site_id, generation))").run()
      await database.prepare("CREATE INDEX IF NOT EXISTS wp_codebox_site_lifecycle_expiry ON wp_codebox_site_lifecycles(state, expires_at)").run()
    })()
    schemaReady.set(database as object, pending)
    pending.catch(() => schemaReady.delete(database as object))
  }
  await pending
}
