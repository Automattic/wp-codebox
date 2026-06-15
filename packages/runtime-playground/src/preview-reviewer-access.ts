import type { ArtifactPreview, ArtifactPreviewReviewerAccess } from "@automattic/wp-codebox-core"

export function previewReviewerAccess(preview: ArtifactPreview | undefined): ArtifactPreviewReviewerAccess {
  if (!preview || preview.status !== "available" || preview.lifecycle !== "held-after-run") {
    return {
      schema: "wp-codebox/preview-reviewer-access/v1",
      status: "unavailable",
      mode: "none",
      reviewerSafe: false,
      reason: "preview-not-held",
    }
  }

  if (preview.reviewerAuthBootstrap) {
    return {
      schema: "wp-codebox/preview-reviewer-access/v1",
      status: "ready",
      mode: "auth-bootstrap",
      reviewerSafe: true,
      openUrl: preview.reviewerAuthBootstrap.bootstrapUrl,
      targetUrl: preview.reviewerAuthBootstrap.redirectUrl,
      expiresAt: preview.reviewerAuthBootstrap.expiresAt,
      bootstrap: preview.reviewerAuthBootstrap,
    }
  }

  if (preview.blockers?.length) {
    return {
      schema: "wp-codebox/preview-reviewer-access/v1",
      status: "blocked",
      mode: "none",
      reviewerSafe: false,
      blockers: preview.blockers,
      expiresAt: preview.expiresAt,
      reason: preview.blockers[0]?.code,
    }
  }

  const safeUrl = preview.publicUrl ?? safeNonLocalPreviewUrl(preview.url)
  if (safeUrl) {
    return {
      schema: "wp-codebox/preview-reviewer-access/v1",
      status: "ready",
      mode: "direct-url",
      reviewerSafe: true,
      openUrl: safeUrl,
      targetUrl: safeUrl,
      expiresAt: preview.expiresAt,
    }
  }

  return {
    schema: "wp-codebox/preview-reviewer-access/v1",
    status: "blocked",
    mode: "none",
    reviewerSafe: false,
    expiresAt: preview.expiresAt,
    reason: "local-preview-requires-auth-bootstrap-or-public-url",
  }
}

function safeNonLocalPreviewUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined
  }
  try {
    const parsed = new URL(url)
    return isLocalPreviewHost(parsed.hostname) ? undefined : url
  } catch {
    return undefined
  }
}

function isLocalPreviewHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost"
    || normalized === "0.0.0.0"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized.startsWith("127.")
}
