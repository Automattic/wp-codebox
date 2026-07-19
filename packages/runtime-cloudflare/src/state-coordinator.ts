export interface MarkdownPointer {
  revision: string
  manifestKey: string
  persistedAt: string
}

interface Lease {
  token: string
  base: MarkdownPointer | null
  version: number
  expiresAt: number
}

interface CoordinatorRecord {
  initialized: boolean
  pointer: MarkdownPointer | null
  version: number
  lease?: Lease
}

interface CoordinatorEnv {
  WORDPRESS_STATE_BUCKET: R2Bucket
  COORDINATOR_LEASE_MS?: number
}

const POINTER_KEY = "sites/default/markdown/current.json"
const STORAGE_KEY = "wordpress-state-coordinator"
// A cold PHP-WASM WordPress boot has measured around 53 seconds; this remains bounded
// while allowing one lease to cover a cold boot plus request-boundary persistence.
const LEASE_MS = 90_000

export class WordPressStateCoordinator implements DurableObject {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CoordinatorEnv,
  ) {}

  fetch(request: Request): Promise<Response> {
    const response = this.tail.then(() => this.handle(request)).catch((error: unknown) => {
      if (error instanceof CoordinatorConflict) {
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
    if (action === "reset") return Response.json(await this.reset())
    return new Response("Unknown coordinator action.", { status: 404 })
  }

  private async current(): Promise<{ schema: string; durableObjectId: string; pointer: MarkdownPointer | null; version: number }> {
    const record = await this.record()
    return { schema: "wp-codebox/cloudflare-wordpress-state/v1", durableObjectId: this.state.id.toString(), pointer: record.pointer, version: record.version }
  }

  private async begin(): Promise<{ token: string; pointer: MarkdownPointer | null; version: number; expiresAt: number }> {
    const record = await this.record()
    if (record.lease && record.lease.expiresAt > Date.now()) {
      throw new CoordinatorConflict("A canonical WordPress lease is active.", record.lease.expiresAt)
    }
    if (record.lease) delete record.lease
    const lease: Lease = { token: crypto.randomUUID(), base: record.pointer, version: record.version, expiresAt: Date.now() + (this.env.COORDINATOR_LEASE_MS ?? LEASE_MS) }
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
      throw new CoordinatorConflict("A complete canonical pointer is required for promotion.")
    }
    if (body.baseRevision !== (lease.base?.revision ?? null) || body.version !== lease.version || record.version !== lease.version || record.pointer?.revision !== lease.base?.revision) {
      throw new CoordinatorConflict("The canonical pointer changed before promotion.")
    }
    await this.env.WORDPRESS_STATE_BUCKET.put(POINTER_KEY, JSON.stringify(pointer), { httpMetadata: { contentType: "application/json" } })
    record.pointer = pointer
    record.version++
    delete record.lease
    await this.save(record)
    return { pointer, version: record.version }
  }

  private requireLease(record: CoordinatorRecord, body: Record<string, unknown>): Lease {
    const lease = record.lease
    if (!lease || lease.expiresAt <= Date.now()) throw new CoordinatorConflict("The canonical WordPress lease has expired.")
    if (body.token !== lease.token) throw new CoordinatorConflict("The canonical WordPress lease token is invalid.")
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

class CoordinatorConflict extends Error {
  constructor(message: string, readonly retryAt?: number) {
    super(message)
  }
}
