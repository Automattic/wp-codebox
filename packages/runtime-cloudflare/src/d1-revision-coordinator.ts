import { RevisionConflict, type MarkdownPointer, type RevisionCoordinator, type RevisionLease, type RevisionState } from "./revision-coordinator.js"

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

const SITE_ID = "default"
const LEASE_MS = 90_000
const schemaReady = new WeakMap<object, Promise<void>>()

export class D1RevisionCoordinator implements RevisionCoordinator {
  constructor(private readonly database: D1Database, private readonly leaseMs = LEASE_MS) {}

  state(): Promise<RevisionState> {
    return readWordPressState(this.database)
  }

  acquire(): Promise<RevisionLease> {
    return beginStateLease(this.database, this.leaseMs)
  }

  async release(lease: RevisionLease): Promise<void> {
    await releaseStateLease(this.database, lease)
  }

  async abort(lease: RevisionLease): Promise<void> {
    await abortStateLease(this.database, lease)
  }

  commit(lease: RevisionLease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }> {
    return commitStateLease(this.database, lease, pointer)
  }

  committed(version: number): Promise<MarkdownPointer | null> {
    return readCommittedPointer(this.database, version)
  }

  async reset(): Promise<void> {
    await resetWordPressState(this.database)
  }
}

async function readWordPressState(database: D1Database): Promise<RevisionState> {
  await ensureSchema(database)
  const row = await readRow(database)
  return {
    schema: "wp-codebox/cloudflare-wordpress-state/v2",
    store: "d1",
    pointer: pointerFromRow(row),
    version: row.version,
  }
}

async function beginStateLease(database: D1Database, leaseMs = LEASE_MS): Promise<RevisionLease> {
  await ensureSchema(database)
  const now = Date.now()
  const token = crypto.randomUUID()
  const expiresAt = now + leaseMs
  const result = await database.prepare(`UPDATE wp_codebox_state
    SET lease_token = ?, lease_base_revision = revision, lease_version = version, lease_expires_at = ?
    WHERE site_id = ? AND (lease_token IS NULL OR lease_expires_at <= ?)`)
    .bind(token, expiresAt, SITE_ID, now).run()
  if (result.meta.changes !== 1) {
    const active = await readRow(database)
    throw new RevisionConflict("A canonical WordPress lease is active.", active.lease_expires_at ?? undefined)
  }
  const row = await readRow(database)
  if (row.lease_token !== token || row.lease_version === null) throw new RevisionConflict("The canonical WordPress lease was not acquired.")
  return { token, pointer: pointerFromRow(row), version: row.lease_version, expiresAt }
}

async function releaseStateLease(database: D1Database, lease: RevisionLease): Promise<{ released: true }> {
  await finishLease(database, lease, "release")
  return { released: true }
}

async function abortStateLease(database: D1Database, lease: RevisionLease): Promise<{ aborted: true }> {
  await finishLease(database, lease, "abort")
  return { aborted: true }
}

async function commitStateLease(database: D1Database, lease: RevisionLease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }> {
  validatePointer(pointer)
  await ensureSchema(database)
  const baseRevision = lease.pointer?.revision ?? null
  const update = database.prepare(`UPDATE wp_codebox_state
    SET revision = ?, manifest_key = ?, persisted_at = ?, version = version + 1,
        lease_token = NULL, lease_base_revision = NULL, lease_version = NULL, lease_expires_at = NULL
    WHERE site_id = ? AND lease_token = ? AND lease_expires_at > ? AND version = ? AND lease_version = ?
      AND ((revision IS NULL AND ? IS NULL) OR revision = ?)
      AND ((lease_base_revision IS NULL AND ? IS NULL) OR lease_base_revision = ?)`)
    .bind(pointer.revision, pointer.manifestKey, pointer.persistedAt, SITE_ID, lease.token, Date.now(), lease.version, lease.version,
      baseRevision, baseRevision, baseRevision, baseRevision)
  const receipt = database.prepare(`INSERT OR IGNORE INTO wp_codebox_commits (site_id, version, revision, manifest_key, persisted_at)
    SELECT ?, ?, ?, ?, ? FROM wp_codebox_state WHERE site_id = ? AND version = ? AND revision = ?`)
    .bind(SITE_ID, lease.version + 1, pointer.revision, pointer.manifestKey, pointer.persistedAt, SITE_ID, lease.version + 1, pointer.revision)
  const [result, receiptResult] = await database.batch([update, receipt])
  if (result.meta.changes !== 1 || receiptResult.meta.changes !== 1) throw new RevisionConflict("The canonical pointer changed before D1 promotion.")
  return { pointer, version: lease.version + 1 }
}

async function readCommittedPointer(database: D1Database, version: number): Promise<MarkdownPointer | null> {
  if (!Number.isSafeInteger(version) || version < 1) throw new RevisionConflict("A canonical commit version is required.")
  await ensureSchema(database)
  const row = await database.prepare(`SELECT revision, manifest_key, persisted_at FROM wp_codebox_commits WHERE site_id = ? AND version = ?`).bind(SITE_ID, version).first<{ revision: string; manifest_key: string; persisted_at: string }>()
  if (!row) return null
  const pointer = { revision: row.revision, manifestKey: row.manifest_key, persistedAt: row.persisted_at }
  validatePointer(pointer)
  return pointer
}

async function resetWordPressState(database: D1Database): Promise<{ reset: true }> {
  await ensureSchema(database)
  await database.batch([
    database.prepare(`UPDATE wp_codebox_state
      SET revision = NULL, manifest_key = NULL, persisted_at = NULL, version = version + 1,
          lease_token = NULL, lease_base_revision = NULL, lease_version = NULL, lease_expires_at = NULL
      WHERE site_id = ?`).bind(SITE_ID),
    database.prepare(`DELETE FROM wp_codebox_commits WHERE site_id = ?`).bind(SITE_ID),
  ])
  return { reset: true }
}

async function finishLease(database: D1Database, lease: RevisionLease, action: "release" | "abort"): Promise<void> {
  await ensureSchema(database)
  const result = await database.prepare(`UPDATE wp_codebox_state
    SET lease_token = NULL, lease_base_revision = NULL, lease_version = NULL, lease_expires_at = NULL
    WHERE site_id = ? AND lease_token = ? AND lease_expires_at > ?`)
    .bind(SITE_ID, lease.token, Date.now()).run()
  if (result.meta.changes !== 1) throw new RevisionConflict(`The canonical WordPress lease cannot ${action} because it expired or changed.`)
}

async function readRow(database: D1Database): Promise<StateRow> {
  const row = await database.prepare(`SELECT revision, manifest_key, persisted_at, version,
    lease_token, lease_base_revision, lease_version, lease_expires_at
    FROM wp_codebox_state WHERE site_id = ?`).bind(SITE_ID).first<StateRow>()
  if (!row) throw new Error("D1 WordPress state row is unavailable.")
  return row
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

function ensureSchema(database: D1Database): Promise<void> {
  const key = database as object
  const existing = schemaReady.get(key)
  if (existing) return existing
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
    await database.prepare(`INSERT OR IGNORE INTO wp_codebox_state (site_id, version) VALUES (?, 0)`).bind(SITE_ID).run()
    await database.prepare(`CREATE TABLE IF NOT EXISTS wp_codebox_commits (site_id TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL, manifest_key TEXT NOT NULL, persisted_at TEXT NOT NULL, PRIMARY KEY (site_id, version))`).run()
  })()
  schemaReady.set(key, pending)
  pending.catch(() => schemaReady.delete(key))
  return pending
}
