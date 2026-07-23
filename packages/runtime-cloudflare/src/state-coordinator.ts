import { mutationFenceExpiresAt, revisionLeaseExpiresAt, RevisionConflict, type MarkdownPointer, type MutationFence, type MutationFenceStatus, type RevisionCoordinator, type RevisionLease, type RevisionState } from "./revision-coordinator.js"

interface StoredLease {
  token: string
  base: MarkdownPointer | null
  version: number
  expiresAt: number
}

interface CoordinatorRecord {
  initialized: boolean
  siteId: string
  pointer: MarkdownPointer | null
  version: number
  lease?: StoredLease
  fence?: MutationFence
}

interface CoordinatorEnv {
  WORDPRESS_STATE_BUCKET: R2Bucket
  COORDINATOR_LEASE_MS?: number
}

const STORAGE_KEY = "wordpress-state-coordinator"
const LEASE_MS = 90_000

export class DurableObjectRevisionCoordinator implements RevisionCoordinator {
  constructor(private readonly stub: DurableObjectStub, private readonly siteId: string) {}

  state(): Promise<RevisionState> {
    return this.call("state")
  }

  acquire(ttlMs?: number): Promise<RevisionLease> {
    return this.call("begin", ttlMs === undefined ? {} : { ttlMs })
  }

  renew(lease: RevisionLease, ttlMs?: number): Promise<RevisionLease> {
    return this.call("renew", { token: lease.token, ttlMs })
  }

  async release(lease: RevisionLease): Promise<void> {
    await this.call("release", { token: lease.token })
  }

  async abort(lease: RevisionLease): Promise<void> {
    await this.call("abort", { token: lease.token })
  }

  commit(lease: RevisionLease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }> {
    return this.call("commit", { token: lease.token, baseRevision: lease.pointer?.revision ?? null, version: lease.version, pointer })
  }

  committed(version: number): Promise<MarkdownPointer | null> {
    return this.call("committed", { version })
  }

  fenceStatus(): Promise<MutationFenceStatus> {
    return this.call("fence-status")
  }

  acquireFence(ttlMs: number): Promise<MutationFence> {
    return this.call("fence-acquire", { ttlMs })
  }

  renewFence(token: string, ttlMs: number): Promise<MutationFence> {
    return this.call("fence-renew", { token, ttlMs })
  }

  async releaseFence(token: string): Promise<void> {
    await this.call("fence-release", { token })
  }

  adopt(pointer: MarkdownPointer, version: number): Promise<{ pointer: MarkdownPointer; version: number }> {
    return this.call("adopt", { pointer, version })
  }

  async reset(): Promise<void> {
    await this.call("reset", {})
  }

  private async call<T>(action: string, body?: Record<string, unknown>): Promise<T> {
    const url = new URL("https://wp-codebox-coordinator.invalid/")
    url.searchParams.set("__wp_codebox_coordinator", action)
    url.searchParams.set("siteId", this.siteId)
    const response = await this.stub.fetch(new Request(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined))
    if (!response.ok) {
      let payload: { message?: string; retryAt?: number } = {}
      try {
        payload = await response.json<{ message?: string; retryAt?: number }>()
      } catch {
        // The response status remains sufficient when an adapter cannot return JSON.
      }
      if (response.status === 409) throw new RevisionConflict(payload.message ?? "Durable Object coordination conflict.", payload.retryAt)
      throw new Error(payload.message ?? `Durable Object coordination failed with ${response.status}.`)
    }
    return response.json<T>()
  }
}

export class WordPressStateCoordinator implements DurableObject {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CoordinatorEnv,
  ) {}

  fetch(request: Request): Promise<Response> {
    const response = this.tail.then(() => this.handle(request)).catch((error: unknown) => {
      if (error instanceof RevisionConflict) {
        const headers = new Headers()
        if (error.retryAt) headers.set("retry-after", String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))))
        return Response.json({ schema: "wp-codebox/cloudflare-coordinator-conflict/v1", message: error.message, retryAt: error.retryAt }, { status: 409, headers })
      }
      return Response.json({ schema: "wp-codebox/cloudflare-coordinator-error/v1", message: error instanceof Error ? error.message : String(error) }, { status: 500 })
    })
    this.tail = response.then(() => undefined, () => undefined)
    return response
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const action = url.searchParams.get("__wp_codebox_coordinator")
    const siteId = url.searchParams.get("siteId") ?? "default"
    if (request.method === "GET" && action === "state") return Response.json(await this.current(siteId))
    if (request.method === "GET" && action === "fence-status") return Response.json(await this.fenceStatus(siteId))
    if (request.method !== "POST" || !action) return new Response("Coordinator requests require an internal action.", { status: 404 })
    const body = await request.json<Record<string, unknown>>()
    if (action === "begin") return Response.json(await this.begin(siteId, body))
    if (action === "renew") return Response.json(await this.renew(siteId, body))
    if (action === "release") return Response.json(await this.release(siteId, body))
    if (action === "abort") return Response.json(await this.abort(siteId, body))
    if (action === "commit") return Response.json(await this.commit(siteId, body))
    if (action === "committed") return Response.json(await this.committed(siteId, body))
    if (action === "fence-status") return Response.json(await this.fenceStatus(siteId))
    if (action === "fence-acquire") return Response.json(await this.acquireFence(siteId, body))
    if (action === "fence-renew") return Response.json(await this.renewFence(siteId, body))
    if (action === "fence-release") return Response.json(await this.releaseFence(siteId, body))
    if (action === "adopt") return Response.json(await this.adopt(siteId, body))
    if (action === "reset") return Response.json(await this.reset(siteId))
    return new Response("Unknown coordinator action.", { status: 404 })
  }

  private async current(siteId: string): Promise<RevisionState> {
    const record = await this.record(siteId)
    return { schema: "wp-codebox/cloudflare-wordpress-state/v2", store: "durable-object", pointer: record.pointer, version: record.version }
  }

  private async begin(siteId: string, body: Record<string, unknown>): Promise<RevisionLease> {
    const record = await this.record(siteId)
    const now = Date.now()
    const fence = await this.activeFence(record)
    if (fence) throw new RevisionConflict("Canonical WordPress mutations are fenced for coordinator cutover.", fence.expiresAt)
    if (record.lease && record.lease.expiresAt > now) throw new RevisionConflict("A canonical WordPress lease is active.", record.lease.expiresAt)
    if (record.lease) delete record.lease
    const lease: StoredLease = { token: crypto.randomUUID(), base: record.pointer, version: record.version, expiresAt: revisionLeaseExpiresAt((body.ttlMs as number | undefined) ?? this.env.COORDINATOR_LEASE_MS ?? LEASE_MS, now) }
    record.lease = lease
    await this.save(record)
    return { token: lease.token, pointer: lease.base, version: lease.version, expiresAt: lease.expiresAt }
  }

  private async release(siteId: string, body: Record<string, unknown>): Promise<{ released: true }> {
    const record = await this.record(siteId)
    this.requireLease(record, body)
    delete record.lease
    await this.save(record)
    return { released: true }
  }

  private async renew(siteId: string, body: Record<string, unknown>): Promise<RevisionLease> {
    const record = await this.record(siteId)
    const lease = this.requireLease(record, body)
    lease.expiresAt = revisionLeaseExpiresAt((body.ttlMs as number | undefined) ?? this.env.COORDINATOR_LEASE_MS ?? LEASE_MS)
    await this.save(record)
    return { token: lease.token, pointer: lease.base, version: lease.version, expiresAt: lease.expiresAt }
  }

  private async abort(siteId: string, body: Record<string, unknown>): Promise<{ aborted: true }> {
    const record = await this.record(siteId)
    this.requireLease(record, body)
    delete record.lease
    await this.save(record)
    return { aborted: true }
  }

  private async commit(siteId: string, body: Record<string, unknown>): Promise<{ pointer: MarkdownPointer; version: number }> {
    const record = await this.record(siteId)
    const lease = this.requireLease(record, body)
    const pointer = body.pointer as MarkdownPointer
    if (!pointer || typeof pointer.revision !== "string" || typeof pointer.manifestKey !== "string" || typeof pointer.persistedAt !== "string") {
      throw new RevisionConflict("A complete canonical pointer is required for promotion.")
    }
    if (body.baseRevision !== (lease.base?.revision ?? null) || body.version !== lease.version || record.version !== lease.version || record.pointer?.revision !== lease.base?.revision) {
      throw new RevisionConflict("The canonical pointer changed before promotion.")
    }
    await this.env.WORDPRESS_STATE_BUCKET.put(pointerKey(siteId), JSON.stringify(pointer), { httpMetadata: { contentType: "application/json" } })
    record.pointer = pointer
    record.version++
    delete record.lease
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(`wordpress-state-commit/${record.version}`, pointer)
      await transaction.put(STORAGE_KEY, record)
    })
    return { pointer, version: record.version }
  }

  private async committed(siteId: string, body: Record<string, unknown>): Promise<MarkdownPointer | null> {
    await this.record(siteId)
    if (!Number.isSafeInteger(body.version) || (body.version as number) < 1) throw new RevisionConflict("A canonical commit version is required.")
    return await this.state.storage.get<MarkdownPointer>(`wordpress-state-commit/${body.version}`) ?? null
  }

  private async fenceStatus(siteId: string): Promise<MutationFenceStatus> {
    const fence = await this.activeFence(await this.record(siteId))
    return fence ? { active: true, expiresAt: fence.expiresAt } : { active: false }
  }

  private async acquireFence(siteId: string, body: Record<string, unknown>): Promise<MutationFence> {
    const record = await this.record(siteId)
    const now = Date.now()
    const expiresAt = mutationFenceExpiresAt(body.ttlMs as number, now)
    if (record.lease && record.lease.expiresAt > now) throw new RevisionConflict("A canonical WordPress lease is active.", record.lease.expiresAt)
    if (record.lease) delete record.lease
    const active = await this.activeFence(record, now)
    if (active) throw new RevisionConflict("A coordinator cutover fence is already active.", active.expiresAt)
    const fence = { token: crypto.randomUUID(), expiresAt }
    record.fence = fence
    await this.save(record)
    return fence
  }

  private async renewFence(siteId: string, body: Record<string, unknown>): Promise<MutationFence> {
    const record = await this.record(siteId)
    const active = await this.activeFence(record)
    if (!active || typeof body.token !== "string" || body.token !== active.token) throw new RevisionConflict("The coordinator cutover fence token is invalid or expired.")
    const fence = { token: active.token, expiresAt: mutationFenceExpiresAt(body.ttlMs as number) }
    record.fence = fence
    await this.save(record)
    return fence
  }

  private async releaseFence(siteId: string, body: Record<string, unknown>): Promise<{ released: true }> {
    const record = await this.record(siteId)
    const active = await this.activeFence(record)
    if (!active || typeof body.token !== "string" || body.token !== active.token) throw new RevisionConflict("The coordinator cutover fence token is invalid or expired.")
    delete record.fence
    await this.save(record)
    return { released: true }
  }

  private async adopt(siteId: string, body: Record<string, unknown>): Promise<{ pointer: MarkdownPointer; version: number }> {
    const record = await this.record(siteId)
    const fence = await this.activeFence(record)
    if (fence) throw new RevisionConflict("Coordinator adoption is blocked by an active cutover fence.", fence.expiresAt)
    const pointer = body.pointer as MarkdownPointer
    const version = body.version
    if (!pointer || typeof pointer.revision !== "string" || typeof pointer.manifestKey !== "string" || typeof pointer.persistedAt !== "string"
      || !Number.isSafeInteger(version) || (version as number) < 1) throw new RevisionConflict("A complete canonical pointer and positive version are required for adoption.")
    if (record.lease && record.lease.expiresAt > Date.now()) throw new RevisionConflict("Coordinator adoption requires no active lease.", record.lease.expiresAt)
    if (record.lease) delete record.lease
    const empty = record.version === 0 && record.pointer === null
    const exact = record.version === version && samePointer(record.pointer, pointer)
    if (!empty && !exact) throw new RevisionConflict("Coordinator adoption requires empty or exactly matching state.")
    record.pointer = pointer
    record.version = version as number
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(`wordpress-state-commit/${record.version}`, pointer)
      await transaction.put(STORAGE_KEY, record)
    })
    return { pointer, version: record.version }
  }

  private requireLease(record: CoordinatorRecord, body: Record<string, unknown>): StoredLease {
    const lease = record.lease
    if (!lease || lease.expiresAt <= Date.now()) throw new RevisionConflict("The canonical WordPress lease has expired.")
    if (body.token !== lease.token) throw new RevisionConflict("The canonical WordPress lease token is invalid.")
    return lease
  }

  private async reset(siteId: string): Promise<{ reset: true }> {
    const record = await this.record(siteId)
    const now = Date.now()
    const fence = await this.activeFence(record, now)
    if (fence) throw new RevisionConflict("Coordinator reset is blocked by an active cutover fence.", fence.expiresAt)
    if (record.lease && record.lease.expiresAt > now) throw new RevisionConflict("Coordinator reset is blocked by an active canonical lease.", record.lease.expiresAt)
    await this.env.WORDPRESS_STATE_BUCKET.delete(pointerKey(siteId))
    await this.state.storage.delete(STORAGE_KEY)
    return { reset: true }
  }

  private async record(siteId: string): Promise<CoordinatorRecord> {
    const stored = await this.state.storage.get<CoordinatorRecord>(STORAGE_KEY)
    if (stored?.initialized) {
      if ((stored.siteId ?? "default") !== siteId) throw new RevisionConflict("The Durable Object belongs to a different site.")
      return stored
    }
    const object = await this.env.WORDPRESS_STATE_BUCKET.get(pointerKey(siteId))
    const record: CoordinatorRecord = { initialized: true, siteId, pointer: object ? await object.json<MarkdownPointer>() : null, version: 0 }
    await this.save(record)
    return record
  }

  private save(record: CoordinatorRecord): Promise<void> {
    return this.state.storage.put(STORAGE_KEY, record)
  }

  private async activeFence(record: CoordinatorRecord, now = Date.now()): Promise<MutationFence | undefined> {
    if (!record.fence) return undefined
    if (record.fence.expiresAt > now) return record.fence
    delete record.fence
    await this.save(record)
    return undefined
  }
}

function pointerKey(siteId: string): string {
  return `sites/${siteId}/markdown/current.json`
}

function samePointer(left: MarkdownPointer | null, right: MarkdownPointer): boolean {
  return !!left && left.revision === right.revision && left.manifestKey === right.manifestKey && left.persistedAt === right.persistedAt
}
