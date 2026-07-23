import { mutationFenceExpiresAt, revisionLeaseExpiresAt, RevisionConflict, type MarkdownPointer, type MutationFence, type MutationFenceStatus, type RevisionCoordinator, type RevisionLease, type RevisionState } from "./revision-coordinator.js"

interface StateRow {
  revision: string | null
  manifest_key: string | null
  persisted_at: string | null
  version: number
  lease_token: string | null
  lease_base_revision: string | null
  lease_version: number | null
  lease_expires_at: number | null
}

interface FenceRow {
  token: string
  expires_at: number
}

const LEASE_MS = 90_000
const schemaReady = new WeakMap<object, Promise<void>>()

export class D1RevisionCoordinator implements RevisionCoordinator {
  constructor(private readonly database: D1Database, private readonly siteId: string, private readonly leaseMs = LEASE_MS) {}

  state(): Promise<RevisionState> {
    return readWordPressState(this.database, this.siteId)
  }

  acquire(ttlMs = this.leaseMs): Promise<RevisionLease> {
    return beginStateLease(this.database, this.siteId, ttlMs)
  }

  renew(lease: RevisionLease, ttlMs = this.leaseMs): Promise<RevisionLease> {
    return renewStateLease(this.database, this.siteId, lease, ttlMs)
  }

  async release(lease: RevisionLease): Promise<void> {
    await releaseStateLease(this.database, this.siteId, lease)
  }

  async abort(lease: RevisionLease): Promise<void> {
    await abortStateLease(this.database, this.siteId, lease)
  }

  commit(lease: RevisionLease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }> {
    return commitStateLease(this.database, this.siteId, lease, pointer)
  }

  committed(version: number): Promise<MarkdownPointer | null> {
    return readCommittedPointer(this.database, this.siteId, version)
  }

  fenceStatus(): Promise<MutationFenceStatus> {
    return readMutationFence(this.database, this.siteId)
  }

  acquireFence(ttlMs: number): Promise<MutationFence> {
    return acquireMutationFence(this.database, this.siteId, ttlMs)
  }

  renewFence(token: string, ttlMs: number): Promise<MutationFence> {
    return renewMutationFence(this.database, this.siteId, token, ttlMs)
  }

  async releaseFence(token: string): Promise<void> {
    await releaseMutationFence(this.database, this.siteId, token)
  }

  adopt(pointer: MarkdownPointer, version: number): Promise<{ pointer: MarkdownPointer; version: number }> {
    return adoptWordPressState(this.database, this.siteId, pointer, version)
  }

  async reset(): Promise<void> {
    await resetWordPressState(this.database, this.siteId)
  }
}

async function readWordPressState(database: D1Database, siteId: string): Promise<RevisionState> {
  await ensureSchema(database, siteId)
  const row = await readRow(database, siteId)
  return {
    schema: "wp-codebox/cloudflare-wordpress-state/v2",
    store: "d1",
    pointer: pointerFromRow(row),
    version: row.version,
  }
}

async function beginStateLease(database: D1Database, siteId: string, leaseMs = LEASE_MS): Promise<RevisionLease> {
  await ensureSchema(database, siteId)
  const now = Date.now()
  const token = crypto.randomUUID()
  const expiresAt = revisionLeaseExpiresAt(leaseMs, now)
  const result = await database.prepare(`UPDATE wp_codebox_state
    SET lease_token = ?, lease_base_revision = revision, lease_version = version, lease_expires_at = ?
    WHERE site_id = ? AND (lease_token IS NULL OR lease_expires_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM wp_codebox_fences WHERE site_id = ? AND expires_at > ?)`)
    .bind(token, expiresAt, siteId, now, siteId, now).run()
  if (result.meta.changes !== 1) {
    const active = await readRow(database, siteId)
    const fence = await readFenceRow(database, siteId)
    if (fence && fence.expires_at > now) throw new RevisionConflict("Canonical WordPress mutations are fenced for coordinator cutover.", fence.expires_at)
    throw new RevisionConflict("A canonical WordPress lease is active.", active.lease_expires_at ?? undefined)
  }
  const row = await readRow(database, siteId)
  if (row.lease_token !== token || row.lease_version === null) throw new RevisionConflict("The canonical WordPress lease was not acquired.")
  return { token, pointer: pointerFromRow(row), version: row.lease_version, expiresAt }
}

async function releaseStateLease(database: D1Database, siteId: string, lease: RevisionLease): Promise<{ released: true }> {
  await finishLease(database, siteId, lease, "release")
  return { released: true }
}

async function renewStateLease(database: D1Database, siteId: string, lease: RevisionLease, leaseMs: number): Promise<RevisionLease> {
  await ensureSchema(database, siteId)
  const now = Date.now()
  const expiresAt = revisionLeaseExpiresAt(leaseMs, now)
  const result = await database.prepare(`UPDATE wp_codebox_state SET lease_expires_at = ?
    WHERE site_id = ? AND lease_token = ? AND lease_expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM wp_codebox_fences WHERE site_id = ? AND expires_at > ?)`)
    .bind(expiresAt, siteId, lease.token, now, siteId, now).run()
  if (result.meta.changes !== 1) throw new RevisionConflict("The canonical WordPress lease cannot renew because it expired or changed.")
  return { ...lease, expiresAt }
}

async function abortStateLease(database: D1Database, siteId: string, lease: RevisionLease): Promise<{ aborted: true }> {
  await finishLease(database, siteId, lease, "abort")
  return { aborted: true }
}

async function commitStateLease(database: D1Database, siteId: string, lease: RevisionLease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }> {
  validatePointer(pointer)
  await ensureSchema(database, siteId)
  const baseRevision = lease.pointer?.revision ?? null
  const update = database.prepare(`UPDATE wp_codebox_state
    SET revision = ?, manifest_key = ?, persisted_at = ?, version = version + 1,
        lease_token = NULL, lease_base_revision = NULL, lease_version = NULL, lease_expires_at = NULL
    WHERE site_id = ? AND lease_token = ? AND lease_expires_at > ? AND version = ? AND lease_version = ?
      AND ((revision IS NULL AND ? IS NULL) OR revision = ?)
      AND ((lease_base_revision IS NULL AND ? IS NULL) OR lease_base_revision = ?)`)
    .bind(pointer.revision, pointer.manifestKey, pointer.persistedAt, siteId, lease.token, Date.now(), lease.version, lease.version,
      baseRevision, baseRevision, baseRevision, baseRevision)
  const receipt = database.prepare(`INSERT OR IGNORE INTO wp_codebox_commits (site_id, version, revision, manifest_key, persisted_at)
    SELECT ?, ?, ?, ?, ? FROM wp_codebox_state WHERE site_id = ? AND version = ? AND revision = ?`)
    .bind(siteId, lease.version + 1, pointer.revision, pointer.manifestKey, pointer.persistedAt, siteId, lease.version + 1, pointer.revision)
  const [result, receiptResult] = await database.batch([update, receipt])
  if (result.meta.changes !== 1 || receiptResult.meta.changes !== 1) throw new RevisionConflict("The canonical pointer changed before D1 promotion.")
  return { pointer, version: lease.version + 1 }
}

async function readCommittedPointer(database: D1Database, siteId: string, version: number): Promise<MarkdownPointer | null> {
  if (!Number.isSafeInteger(version) || version < 1) throw new RevisionConflict("A canonical commit version is required.")
  await ensureSchema(database, siteId)
  const row = await database.prepare(`SELECT revision, manifest_key, persisted_at FROM wp_codebox_commits WHERE site_id = ? AND version = ?`).bind(siteId, version).first<{ revision: string; manifest_key: string; persisted_at: string }>()
  if (!row) return null
  const pointer = { revision: row.revision, manifestKey: row.manifest_key, persistedAt: row.persisted_at }
  validatePointer(pointer)
  return pointer
}

async function readMutationFence(database: D1Database, siteId: string): Promise<MutationFenceStatus> {
  await ensureSchema(database, siteId)
  const row = await readFenceRow(database, siteId)
  return row && row.expires_at > Date.now() ? { active: true, expiresAt: row.expires_at } : { active: false }
}

async function acquireMutationFence(database: D1Database, siteId: string, ttlMs: number): Promise<MutationFence> {
  await ensureSchema(database, siteId)
  const now = Date.now()
  const fence = { token: crypto.randomUUID(), expiresAt: mutationFenceExpiresAt(ttlMs, now) }
  const result = await database.prepare(`INSERT INTO wp_codebox_fences (site_id, token, expires_at)
    SELECT ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM wp_codebox_state WHERE site_id = ? AND (lease_token IS NULL OR lease_expires_at <= ?)
    )
    ON CONFLICT(site_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
      WHERE wp_codebox_fences.expires_at <= ?`)
    .bind(siteId, fence.token, fence.expiresAt, siteId, now, now).run()
  if (result.meta.changes !== 1) {
    const [state, active] = await Promise.all([readRow(database, siteId), readFenceRow(database, siteId)])
    if (state.lease_token && state.lease_expires_at && state.lease_expires_at > now) throw new RevisionConflict("A canonical WordPress lease is active.", state.lease_expires_at)
    throw new RevisionConflict("A coordinator cutover fence is already active.", active?.expires_at)
  }
  return fence
}

async function renewMutationFence(database: D1Database, siteId: string, token: string, ttlMs: number): Promise<MutationFence> {
  await ensureSchema(database, siteId)
  const now = Date.now()
  const fence = { token, expiresAt: mutationFenceExpiresAt(ttlMs, now) }
  const result = await database.prepare(`UPDATE wp_codebox_fences SET expires_at = ?
    WHERE site_id = ? AND token = ? AND expires_at > ?`).bind(fence.expiresAt, siteId, token, now).run()
  if (result.meta.changes !== 1) throw new RevisionConflict("The coordinator cutover fence token is invalid or expired.")
  return fence
}

async function releaseMutationFence(database: D1Database, siteId: string, token: string): Promise<{ released: true }> {
  await ensureSchema(database, siteId)
  const result = await database.prepare(`DELETE FROM wp_codebox_fences
    WHERE site_id = ? AND token = ? AND expires_at > ?`).bind(siteId, token, Date.now()).run()
  if (result.meta.changes !== 1) throw new RevisionConflict("The coordinator cutover fence token is invalid or expired.")
  return { released: true }
}

async function adoptWordPressState(database: D1Database, siteId: string, pointer: MarkdownPointer, version: number): Promise<{ pointer: MarkdownPointer; version: number }> {
  validatePointer(pointer)
  if (!Number.isSafeInteger(version) || version < 1) throw new RevisionConflict("A positive canonical version is required for D1 adoption.")
  await ensureSchema(database, siteId)
  const now = Date.now()
  await database.batch([
    database.prepare(`UPDATE wp_codebox_state
      SET revision = ?, manifest_key = ?, persisted_at = ?, version = ?,
          lease_token = NULL, lease_base_revision = NULL, lease_version = NULL, lease_expires_at = NULL
      WHERE site_id = ? AND (lease_token IS NULL OR lease_expires_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM wp_codebox_fences WHERE site_id = ? AND expires_at > ?)
        AND ((revision IS NULL AND manifest_key IS NULL AND persisted_at IS NULL)
          OR (version = ? AND revision = ? AND manifest_key = ? AND persisted_at = ?))
        AND (NOT EXISTS (SELECT 1 FROM wp_codebox_commits WHERE site_id = ? AND version = ?)
          OR EXISTS (SELECT 1 FROM wp_codebox_commits WHERE site_id = ? AND version = ?
            AND revision = ? AND manifest_key = ? AND persisted_at = ?))`)
      .bind(pointer.revision, pointer.manifestKey, pointer.persistedAt, version, siteId, now, siteId, now,
        version, pointer.revision, pointer.manifestKey, pointer.persistedAt,
        siteId, version, siteId, version, pointer.revision, pointer.manifestKey, pointer.persistedAt),
    database.prepare(`INSERT OR IGNORE INTO wp_codebox_commits (site_id, version, revision, manifest_key, persisted_at)
      SELECT site_id, version, revision, manifest_key, persisted_at FROM wp_codebox_state
      WHERE site_id = ? AND version = ? AND revision = ? AND manifest_key = ? AND persisted_at = ? AND lease_token IS NULL
        AND NOT EXISTS (SELECT 1 FROM wp_codebox_fences WHERE site_id = ? AND expires_at > ?)`)
      .bind(siteId, version, pointer.revision, pointer.manifestKey, pointer.persistedAt, siteId, now),
  ])
  const [state, committed] = await Promise.all([readRow(database, siteId), readCommittedPointer(database, siteId, version)])
  if (state.version !== version || !samePointer(pointerFromRow(state), pointer) || !samePointer(committed, pointer)) {
    throw new RevisionConflict("D1 coordinator adoption requires empty or exactly matching state without an active lease or fence.")
  }
  return { pointer, version }
}

async function resetWordPressState(database: D1Database, siteId: string): Promise<{ reset: true }> {
  await ensureSchema(database, siteId)
  const now = Date.now()
  const [reset] = await database.batch([
    database.prepare(`UPDATE wp_codebox_state
      SET revision = NULL, manifest_key = NULL, persisted_at = NULL, version = version + 1,
          lease_token = NULL, lease_base_revision = NULL, lease_version = NULL, lease_expires_at = NULL
      WHERE site_id = ? AND (lease_token IS NULL OR lease_expires_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM wp_codebox_fences WHERE site_id = ? AND expires_at > ?)`)
      .bind(siteId, now, siteId, now),
    database.prepare(`DELETE FROM wp_codebox_commits WHERE site_id = ?
      AND EXISTS (SELECT 1 FROM wp_codebox_state WHERE site_id = ? AND (lease_token IS NULL OR lease_expires_at <= ?))
      AND NOT EXISTS (SELECT 1 FROM wp_codebox_fences WHERE site_id = ? AND expires_at > ?)`)
      .bind(siteId, siteId, now, siteId, now),
  ])
  if (reset.meta.changes !== 1) {
    const [state, fence] = await Promise.all([readRow(database, siteId), readFenceRow(database, siteId)])
    throw new RevisionConflict("Coordinator reset is blocked by an active canonical lease or cutover fence.", fence?.expires_at ?? state.lease_expires_at ?? undefined)
  }
  return { reset: true }
}

async function finishLease(database: D1Database, siteId: string, lease: RevisionLease, action: "release" | "abort"): Promise<void> {
  await ensureSchema(database, siteId)
  const result = await database.prepare(`UPDATE wp_codebox_state
    SET lease_token = NULL, lease_base_revision = NULL, lease_version = NULL, lease_expires_at = NULL
    WHERE site_id = ? AND lease_token = ? AND lease_expires_at > ?`)
    .bind(siteId, lease.token, Date.now()).run()
  if (result.meta.changes !== 1) throw new RevisionConflict(`The canonical WordPress lease cannot ${action} because it expired or changed.`)
}

async function readRow(database: D1Database, siteId: string): Promise<StateRow> {
  const row = await database.prepare(`SELECT revision, manifest_key, persisted_at, version,
    lease_token, lease_base_revision, lease_version, lease_expires_at
    FROM wp_codebox_state WHERE site_id = ?`).bind(siteId).first<StateRow>()
  if (!row) throw new Error("D1 WordPress state row is unavailable.")
  return row
}

async function readFenceRow(database: D1Database, siteId: string): Promise<FenceRow | null> {
  return database.prepare(`SELECT token, expires_at FROM wp_codebox_fences WHERE site_id = ?`).bind(siteId).first<FenceRow>()
}

function pointerFromRow(row: StateRow): MarkdownPointer | null {
  if (row.revision === null && row.manifest_key === null && row.persisted_at === null) return null
  const pointer = { revision: row.revision, manifestKey: row.manifest_key, persistedAt: row.persisted_at }
  validatePointer(pointer)
  return pointer as MarkdownPointer
}

function validatePointer(pointer: unknown): asserts pointer is MarkdownPointer {
  if (!pointer || typeof pointer !== "object") throw new RevisionConflict("A complete canonical pointer is required for D1 promotion.")
  const candidate = pointer as Partial<MarkdownPointer>
  if (typeof candidate.revision !== "string" || typeof candidate.manifestKey !== "string" || typeof candidate.persistedAt !== "string") {
    throw new RevisionConflict("A complete canonical pointer is required for D1 promotion.")
  }
}

function samePointer(left: MarkdownPointer | null, right: MarkdownPointer): boolean {
  return !!left && left.revision === right.revision && left.manifestKey === right.manifestKey && left.persistedAt === right.persistedAt
}

async function ensureSchema(database: D1Database, siteId: string): Promise<void> {
  const key = database as object
  const existing = schemaReady.get(key)
  if (!existing) {
    const pending = (async () => {
    await database.prepare(`CREATE TABLE IF NOT EXISTS wp_codebox_state (
      site_id TEXT PRIMARY KEY,
      revision TEXT,
      manifest_key TEXT,
      persisted_at TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_base_revision TEXT,
      lease_version INTEGER,
      lease_expires_at INTEGER
    )`).run()
    await database.prepare(`CREATE TABLE IF NOT EXISTS wp_codebox_commits (site_id TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL, manifest_key TEXT NOT NULL, persisted_at TEXT NOT NULL, PRIMARY KEY (site_id, version))`).run()
    await database.prepare(`CREATE TABLE IF NOT EXISTS wp_codebox_fences (site_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)`).run()
    })()
    schemaReady.set(key, pending)
    pending.catch(() => schemaReady.delete(key))
  }
  await schemaReady.get(key)
  await database.prepare(`INSERT OR IGNORE INTO wp_codebox_state (site_id, version) VALUES (?, 0)`).bind(siteId).run()
}
