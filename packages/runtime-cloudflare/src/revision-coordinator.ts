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

export interface RevisionCoordinator {
  state(): Promise<RevisionState>
  acquire(): Promise<RevisionLease>
  release(lease: RevisionLease): Promise<void>
  abort(lease: RevisionLease): Promise<void>
  commit(lease: RevisionLease, pointer: MarkdownPointer): Promise<{ pointer: MarkdownPointer; version: number }>
  committed(version: number): Promise<MarkdownPointer | null>
  reset(): Promise<void>
}

export class RevisionConflict extends Error {
  constructor(message: string, readonly retryAt?: number) {
    super(message)
  }
}
