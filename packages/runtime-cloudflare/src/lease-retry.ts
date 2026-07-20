const DEFAULT_RETRY_DELAY_MS = 1_000

export function leaseRetryDelayMs(retryAfterSeconds: number | undefined, remainingMs: number): number {
  const requestedMs = retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1_000
    : DEFAULT_RETRY_DELAY_MS
  return Math.max(0, Math.min(remainingMs, requestedMs))
}
