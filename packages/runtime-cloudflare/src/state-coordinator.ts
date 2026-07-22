import { RevisionConflict, type MarkdownPointer, type RevisionCoordinator, type RevisionLease, type RevisionState } from "./revision-coordinator.js"

interface StoredLease {
  token: string
  base: MarkdownPointer | null
  version: number
  expiresAt: number
}

interface CoordinatorRecord {
  initialized: boolean
  pointer: MarkdownPointer | null
  version: number
  lease?: StoredLease
}

interface CoordinatorEnv {
  WORDPRESS_STATE_BUCKET: R2Bucket
  COORDINATOR_LEASE_MS?: number
}

const POINTER_KEY = "sites/default/markdown/current.json"
const STORAGE_KEY = "wordpress-state-coordinator"
const LEASE_MS = 90_000

export class DurableObjectRevisionCoordinator implements RevisionCoordinator {
  constructor(private readonly stub: DurableObjectStub) {}

  state(): Promise<RevisionState> {
    return this.call("state")
  }

  acquire(): Promise<RevisionLease> {
    return this.call("begin", {})
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

  adopt(pointer: MarkdownPointer, version: number): Promise<{ pointer: MarkdownPointer; version: number }> {
    return this.call("adopt", { pointer, version })
  }

  async reset(): Promise<void> {
    await this.call("reset", {})
  }

  private async call<T>(action: string, body?: Record<string, unknown>): Promise<T> {
    const url = new URL("https://wp-codebox-coordinator.invalid/")
    url.searchParams.set("__wp_codebox_coordinator", action)
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
    const action = new URL(request.url).searchParams.get("__wp_codebox_coordinator")
    if (request.method === "GET" && action === "state") return Response.json(await this.current())
    if (request.method !== "POST" || !action) return new Response("Coordinator requests require an internal action.", { status: 404 })
    const body = await request.json<Record<string, unknown>>()
    if (action === "begin") return Response.json(await this.begin())
    if (action === "release") return Response.json(await this.release(body))
    if (action === "abort") return Response.json(await this.abort(body))
    if (action === "commit") return Response.json(await this.commit(body))
    if (action === "committed") return Response.json(await this.committed(body))
    if (action === "adopt") return Response.json(await this.adopt(body))
    if (action === "reset") return Response.json(await this.reset())
    return new Response("Unknown coordinator action.", { status: 404 })
  }

  private async current(): Promise<RevisionState> {
    const record = await this.record()
    return { schema: "wp-codebox/cloudflare-wordpress-state/v2", store: "durable-object", pointer: record.pointer, version: record.version }
  }

  private async begin(): Promise<RevisionLease> {
    const record = await this.record()
    if (record.lease && record.lease.expiresAt > Date.now()) throw new RevisionConflict("A canonical WordPress lease is active.", record.lease.expiresAt)
    if (record.lease) delete record.lease
    const lease: StoredLease = { token: crypto.randomUUID(), base: record.pointer, version: record.version, expiresAt: Date.now() + (this.env.COORDINATOR_LEASE_MS ?? LEASE_MS) }
    record.lease = lease
    await this.save(record)
    return { token: lease.token, pointer: lease.base, version: lease.version, expiresAt: lease.expiresAt }
  }

  private async release(body: Record<string, unknown>): Promise<{ released: true }> {
    const record = await this.record()
    this.requireLease(record, body)
    delete record.lease
    await this.save(record)
    return { released: true }
  }

  private async abort(body: Record<string, unknown>): Promise<{ aborted: true }> {
    const record = await this.record()
    this.requireLease(record, body)
    delete record.lease
    await this.save(record)
    return { aborted: true }
  }

  private async commit(body: Record<string, unknown>): Promise<{ pointer: MarkdownPointer; version: number }> {
    const record = await this.record()
    const lease = this.requireLease(record, body)
    const pointer = body.pointer as MarkdownPointer
    if (!pointer || typeof pointer.revision !== "string" || typeof pointer.manifestKey !== "string" || typeof pointer.persistedAt !== "string") {
      throw new RevisionConflict("A complete canonical pointer is required for promotion.")
    }
    if (body.baseRevision !== (lease.base?.revision ?? null) || body.version !== lease.version || record.version !== lease.version || record.pointer?.revision !== lease.base?.revision) {
      throw new RevisionConflict("The canonical pointer changed before promotion.")
    }
    await this.env.WORDPRESS_STATE_BUCKET.put(POINTER_KEY, JSON.stringify(pointer), { httpMetadata: { contentType: "application/json" } })
    record.pointer = pointer
    record.version++
    delete record.lease
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(`wordpress-state-commit/${record.version}`, pointer)
      await transaction.put(STORAGE_KEY, record)
    })
    return { pointer, version: record.version }
  }

  private async committed(body: Record<string, unknown>): Promise<MarkdownPointer | null> {
    if (!Number.isSafeInteger(body.version) || (body.version as number) < 1) throw new RevisionConflict("A canonical commit version is required.")
    return await this.state.storage.get<MarkdownPointer>(`wordpress-state-commit/${body.version}`) ?? null
  }

  private async adopt(body: Record<string, unknown>): Promise<{ pointer: MarkdownPointer; version: number }> {
    const record = await this.record()
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

  private async reset(): Promise<{ reset: true }> {
    await this.env.WORDPRESS_STATE_BUCKET.delete(POINTER_KEY)
    await this.state.storage.delete(STORAGE_KEY)
    return { reset: true }
  }

  private async record(): Promise<CoordinatorRecord> {
    const stored = await this.state.storage.get<CoordinatorRecord>(STORAGE_KEY)
    if (stored?.initialized) return stored
    const object = await this.env.WORDPRESS_STATE_BUCKET.get(POINTER_KEY)
    const record: CoordinatorRecord = { initialized: true, pointer: object ? await object.json<MarkdownPointer>() : null, version: 0 }
    await this.save(record)
    return record
  }

  private save(record: CoordinatorRecord): Promise<void> {
    return this.state.storage.put(STORAGE_KEY, record)
  }
}

function samePointer(left: MarkdownPointer | null, right: MarkdownPointer): boolean {
  return !!left && left.revision === right.revision && left.manifestKey === right.manifestKey && left.persistedAt === right.persistedAt
}
