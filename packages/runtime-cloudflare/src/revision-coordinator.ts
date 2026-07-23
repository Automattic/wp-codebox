export interface MarkdownPointer {
  revision: string
  manifestKey: string
  persistedAt: string
}

export interface RevisionLease {
  token: string
  pointer: MarkdownPointer | null
  version: number
  expiresAt: number
}

export interface RevisionState {
  schema: "wp-codebox/cloudflare-wordpress-state/v2"
  store: "durable-object" | "d1"
  pointer: MarkdownPointer | null
  version: number
}

export interface MutationFence {
  token: string
  expiresAt: number
}

export interface MutationFenceStatus {
  active: boolean
  expiresAt?: number
}

export const MIN_MUTATION_FENCE_MS = 30_000
export const MAX_MUTATION_FENCE_MS = 600_000
export const MAX_REVISION_LEASE_MS = 600_000

export function mutationFenceExpiresAt(ttlMs: number, now = Date.now()): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_MUTATION_FENCE_MS || ttlMs > MAX_MUTATION_FENCE_MS) {
    throw new RevisionConflict(`Mutation fence TTL must be between ${MIN_MUTATION_FENCE_MS / 1_000} and ${MAX_MUTATION_FENCE_MS / 1_000} seconds.`)
  }
  return now + ttlMs
}

export function revisionLeaseExpiresAt(ttlMs: number, now = Date.now()): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_REVISION_LEASE_MS) throw new RevisionConflict(`Revision lease TTL must be between 1 and ${MAX_REVISION_LEASE_MS} milliseconds.`)
  return now + ttlMs
}

export interface RevisionCoordinator {
  state(): Promise<RevisionState>
  acquire(ttlMs?: number): Promise<RevisionLease>
  renew(lease: RevisionLease, ttlMs?: number): Promise<RevisionLease>
  release(lease: RevisionLease): Promise<void>
  abort(lease: RevisionLease): Promise<void>
  commit(lease: RevisionLease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }>
  committed(version: number): Promise<MarkdownPointer | null>
  fenceStatus(): Promise<MutationFenceStatus>
  acquireFence(ttlMs: number): Promise<MutationFence>
  renewFence(token: string, ttlMs: number): Promise<MutationFence>
  releaseFence(token: string): Promise<void>
  adopt(pointer: MarkdownPointer, version: number): Promise<{ pointer: MarkdownPointer; version: number }>
  reset(): Promise<void>
}

export class RevisionConflict extends Error {
  constructor(message: string, readonly retryAt?: number) {
    super(message)
  }
}
