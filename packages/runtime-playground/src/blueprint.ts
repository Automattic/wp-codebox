import type { RuntimeCreateSpec } from "@chubes4/wp-codebox-core"

export function normalizeBlueprint(blueprint: unknown): { extraLibraries?: unknown; landingPage?: unknown; preferredVersions?: unknown; steps: unknown[] } {
  if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) {
    return { steps: [] }
  }

  const candidate = blueprint as Record<string, unknown>
  const steps = Array.isArray(candidate.steps) ? candidate.steps : []

  return {
    extraLibraries: candidate.extraLibraries,
    landingPage: candidate.landingPage,
    preferredVersions: candidate.preferredVersions,
    steps,
  }
}

export function playgroundBlueprint(blueprint: unknown, policy: RuntimeCreateSpec["policy"], siteUrl?: string): unknown {
  if (!siteUrl && !policy.commands.includes("wordpress.wp-cli")) {
    return blueprint
  }

  const base = !blueprint || typeof blueprint !== "object" || Array.isArray(blueprint) ? {} : blueprint as Record<string, unknown>
  const steps = Array.isArray(base.steps) ? base.steps : []
  const extraLibraries = Array.isArray(base.extraLibraries) ? base.extraLibraries : []

  return {
    ...base,
    ...(policy.commands.includes("wordpress.wp-cli") ? { extraLibraries: [...new Set([...extraLibraries, "wp-cli"])] } : {}),
    ...(siteUrl ? { steps: [{ step: "defineSiteUrl", siteUrl }, ...steps] } : {}),
  }
}

export function preferredVersionsForEnvironment(
  wpVersion: string | undefined,
  baseBlueprint: { preferredVersions?: unknown },
): unknown {
  if (baseBlueprint.preferredVersions) {
    return baseBlueprint.preferredVersions
  }

  if (!wpVersion) {
    return undefined
  }

  return { wp: wpVersion }
}
