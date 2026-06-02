import type { ArtifactProvenance } from "./runtime-contracts.js"

export const BROWSER_REVIEW_BRIDGE_SCHEMA = "wp-codebox/browser-review-bridge/v1" as const
export const BROWSER_REVIEW_DECISION_SCHEMA = "wp-codebox/browser-review-decision/v1" as const
export const BROWSER_REVIEW_DECISION_MESSAGE = "wp-codebox:artifact-review-decision" as const

export type BrowserReviewDecisionAction = "approve" | "reject" | "request-changes" | (string & {})

export interface BrowserReviewBridgeLabels {
  title?: string
  summary?: string
  approve?: string
  reject?: string
  requestChanges?: string
}

export interface BrowserReviewBridgeMetadata {
  schema: typeof BROWSER_REVIEW_BRIDGE_SCHEMA
  artifactId: string
  sessionId?: string
  provenance?: ArtifactProvenance
  review?: { schema?: string; summary?: string; [key: string]: unknown }
  approvedFiles?: string[]
  contentDigest?: string
  applyTarget?: Record<string, unknown>
  requester?: string
  context?: Record<string, unknown>
  labels?: BrowserReviewBridgeLabels
}

export interface BrowserReviewDecisionInput {
  action: BrowserReviewDecisionAction
  approvedFiles?: string[]
  approver?: string
  reason?: string
  context?: Record<string, unknown>
  decidedAt?: string
}

export interface BrowserReviewDecision {
  schema: typeof BROWSER_REVIEW_DECISION_SCHEMA
  action: BrowserReviewDecisionAction
  artifactId: string
  sessionId?: string
  approvedFiles: string[]
  approver?: string
  reason?: string
  decidedAt: string
  source: "wp-codebox/browser-review-bridge"
  provenance?: ArtifactProvenance
  contentDigest?: string
  applyTarget?: Record<string, unknown>
  requester?: string
  context?: Record<string, unknown>
}

export interface BrowserReviewDecisionMessage {
  type: typeof BROWSER_REVIEW_DECISION_MESSAGE
  payload: BrowserReviewDecision
}

export interface BrowserReviewBridgeOptions {
  metadata: BrowserReviewBridgeMetadata
  targetOrigin?: string
  window?: Pick<Window, "parent" | "postMessage">
  onDecision?: (decision: BrowserReviewDecision) => void
}

export interface BrowserReviewOverlayOptions extends BrowserReviewBridgeOptions {
  document?: Document
  container?: HTMLElement
  actions?: BrowserReviewDecisionAction[]
}

export function buildBrowserReviewDecision(metadata: BrowserReviewBridgeMetadata, input: BrowserReviewDecisionInput): BrowserReviewDecision {
  const approvedFiles = normalizeApprovedFiles(input.approvedFiles ?? metadata.approvedFiles ?? [])
  const context = mergeContext(metadata.context, input.context)
  return stripUndefined({
    schema: BROWSER_REVIEW_DECISION_SCHEMA,
    action: input.action,
    artifactId: metadata.artifactId,
    sessionId: metadata.sessionId,
    approvedFiles,
    approver: trimString(input.approver),
    reason: trimString(input.reason),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
    source: "wp-codebox/browser-review-bridge" as const,
    provenance: metadata.provenance,
    contentDigest: metadata.contentDigest,
    applyTarget: metadata.applyTarget,
    requester: metadata.requester,
    context,
  })
}

export function postBrowserReviewDecision(options: BrowserReviewBridgeOptions, input: BrowserReviewDecisionInput): BrowserReviewDecision {
  const decision = buildBrowserReviewDecision(options.metadata, input)
  const win = options.window ?? globalThis.window
  const target = win.parent ?? win
  target.postMessage({ type: BROWSER_REVIEW_DECISION_MESSAGE, payload: decision }, options.targetOrigin ?? "*")
  options.onDecision?.(decision)
  return decision
}

export function renderBrowserReviewOverlay(options: BrowserReviewOverlayOptions): HTMLElement {
  const documentRef = options.document ?? globalThis.document
  const container = options.container ?? documentRef.body
  const labels = options.metadata.labels ?? {}
  const overlay = documentRef.createElement("section")
  overlay.setAttribute("data-wp-codebox-browser-review", "true")
  overlay.setAttribute("role", "region")
  overlay.setAttribute("aria-label", labels.title ?? "Artifact review")
  overlay.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:16px;border:1px solid #d0d7de;border-radius:12px;background:#fff;color:#1f2328;box-shadow:0 12px 40px rgba(31,35,40,.18);font:14px/1.4 system-ui,sans-serif;"

  const title = documentRef.createElement("strong")
  title.textContent = labels.title ?? "Review artifact"
  title.style.cssText = "display:block;margin:0 0 6px;font-size:15px;"
  overlay.append(title)

  const summary = documentRef.createElement("p")
  summary.textContent = labels.summary ?? options.metadata.review?.summary ?? `Review ${options.metadata.artifactId}.`
  summary.style.cssText = "margin:0 0 12px;color:#59636e;"
  overlay.append(summary)

  const actions = options.actions ?? ["approve", "reject"]
  const buttonRow = documentRef.createElement("div")
  buttonRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;"
  for (const action of actions) {
    const button = documentRef.createElement("button")
    button.type = "button"
    button.textContent = labelForAction(action, labels)
    button.setAttribute("data-wp-codebox-browser-review-action", action)
    button.style.cssText = action === "approve"
      ? "appearance:none;border:0;border-radius:8px;background:#1f883d;color:#fff;padding:8px 12px;font:inherit;cursor:pointer;"
      : "appearance:none;border:1px solid #d0d7de;border-radius:8px;background:#fff;color:#1f2328;padding:8px 12px;font:inherit;cursor:pointer;"
    button.addEventListener("click", () => postBrowserReviewDecision(options, { action }))
    buttonRow.append(button)
  }
  overlay.append(buttonRow)
  container.append(overlay)
  return overlay
}

function labelForAction(action: BrowserReviewDecisionAction, labels: BrowserReviewBridgeLabels): string {
  if (action === "approve") {
    return labels.approve ?? "Approve"
  }
  if (action === "reject") {
    return labels.reject ?? "Reject"
  }
  if (action === "request-changes") {
    return labels.requestChanges ?? "Request changes"
  }
  return action
}

function normalizeApprovedFiles(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
}

function mergeContext(metadataContext?: Record<string, unknown>, inputContext?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadataContext && !inputContext) {
    return undefined
  }
  return { ...(metadataContext ?? {}), ...(inputContext ?? {}) }
}

function trimString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
