export interface BrowserCommandLivenessPolicy {
  wallTimeoutMs?: number
  idleTimeoutMs?: number
  networkSettleTimeoutMs?: number
  readinessStabilizationTimeoutMs?: number
  pollIntervalMs?: number
}

export const BROWSER_COMMAND_LIVENESS_DEFAULTS = {
  wallTimeoutMs: 120_000,
  idleTimeoutMs: 30_000,
  networkSettleTimeoutMs: 1_000,
  readinessStabilizationTimeoutMs: 1_000,
  pollIntervalMs: 250,
} as const

export class BrowserCommandLivenessError extends Error {
  readonly code: "browser-command-wall-timeout" | "browser-command-idle-timeout"

  constructor(readonly details: {
    command: string
    phase: string
    type: "wall" | "idle"
    elapsedMs: number
    timeoutMs: number
    lastProgressSource?: string
  }) {
    const source = details.lastProgressSource ? `; last progress source was ${details.lastProgressSource}` : ""
    super(`Browser command ${details.command} ${details.phase} ${details.type === "wall" ? "exceeded" : "stalled after"} ${details.timeoutMs}ms${source}`)
    this.name = "BrowserCommandLivenessError"
    this.code = details.type === "wall" ? "browser-command-wall-timeout" : "browser-command-idle-timeout"
  }
}

export function browserCommandLivenessPolicy(overrides: BrowserCommandLivenessPolicy = {}): Required<BrowserCommandLivenessPolicy> {
  return {
    wallTimeoutMs: normalizeNonNegative(overrides.wallTimeoutMs, BROWSER_COMMAND_LIVENESS_DEFAULTS.wallTimeoutMs),
    idleTimeoutMs: normalizeNonNegative(overrides.idleTimeoutMs, BROWSER_COMMAND_LIVENESS_DEFAULTS.idleTimeoutMs),
    networkSettleTimeoutMs: normalizeNonNegative(overrides.networkSettleTimeoutMs, BROWSER_COMMAND_LIVENESS_DEFAULTS.networkSettleTimeoutMs),
    readinessStabilizationTimeoutMs: normalizeNonNegative(overrides.readinessStabilizationTimeoutMs, BROWSER_COMMAND_LIVENESS_DEFAULTS.readinessStabilizationTimeoutMs),
    pollIntervalMs: Math.max(10, normalizeNonNegative(overrides.pollIntervalMs, BROWSER_COMMAND_LIVENESS_DEFAULTS.pollIntervalMs)),
  }
}

export async function withBrowserCommandLiveness<T>({
  command,
  phase,
  operation,
  policy: policyOverrides,
  poll,
  idle,
}: {
  command: string
  phase: string
  operation: Promise<T>
  policy?: BrowserCommandLivenessPolicy
  poll?: () => Promise<void> | void
  idle?: () => { idleMs: number; lastProgressSource?: string }
}): Promise<T> {
  const policy = browserCommandLivenessPolicy(policyOverrides)
  if (policy.wallTimeoutMs <= 0 && (!idle || policy.idleTimeoutMs <= 0) && !poll) {
    return operation
  }

  const startedAtMs = Date.now()
  let interval: NodeJS.Timeout | undefined
  operation.catch(() => undefined)

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        interval = setInterval(() => {
          void (async () => {
            try {
              await poll?.()
              if (idle && policy.idleTimeoutMs > 0) {
                const summary = idle()
                if (summary.idleMs >= policy.idleTimeoutMs) {
                  reject(new BrowserCommandLivenessError({
                    command,
                    phase,
                    type: "idle",
                    elapsedMs: summary.idleMs,
                    timeoutMs: policy.idleTimeoutMs,
                    lastProgressSource: summary.lastProgressSource,
                  }))
                  return
                }
              }
              if (policy.wallTimeoutMs > 0) {
                const elapsedMs = Date.now() - startedAtMs
                if (elapsedMs >= policy.wallTimeoutMs) {
                  reject(new BrowserCommandLivenessError({
                    command,
                    phase,
                    type: "wall",
                    elapsedMs,
                    timeoutMs: policy.wallTimeoutMs,
                  }))
                }
              }
            } catch (error) {
              reject(error)
            }
          })()
        }, policy.pollIntervalMs)
        interval.unref()
      }),
    ])
  } finally {
    if (interval) {
      clearInterval(interval)
    }
  }
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, Math.round(value))
}
