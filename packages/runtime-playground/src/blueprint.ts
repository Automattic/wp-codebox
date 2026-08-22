import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { playgroundSiteSeedMultisiteBlueprintSteps, playgroundSiteSeedPrimaryUrl } from "./site-seed-multisite.js"

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
  const needsWpCli = policy.commands.includes("wordpress.wp-cli") || policy.commands.includes("wordpress.plugin-check") || policy.commands.includes("wordpress.theme-check")
  const needsPluginCheck = policy.commands.includes("wordpress.plugin-check")
  const needsThemeCheck = policy.commands.includes("wordpress.theme-check")
  if (!siteUrl && !needsWpCli && !needsPluginCheck) {
    return blueprint
  }

  const base = !blueprint || typeof blueprint !== "object" || Array.isArray(blueprint) ? {} : blueprint as Record<string, unknown>
  const steps = Array.isArray(base.steps) ? base.steps : []
  const extraLibraries = Array.isArray(base.extraLibraries) ? base.extraLibraries : []

  return {
    ...base,
    ...(needsWpCli ? { extraLibraries: [...new Set([...extraLibraries, "wp-cli"])] } : {}),
    steps: [
      ...(siteUrl ? [{ step: "defineSiteUrl", siteUrl }] : []),
      ...(needsPluginCheck ? [{
        step: "installPlugin",
        pluginData: { resource: "wordpress.org/plugins", slug: "plugin-check" },
        options: { activate: true },
      }] : []),
      ...(needsThemeCheck ? [{
        step: "installPlugin",
        pluginData: { resource: "wordpress.org/plugins", slug: "theme-check" },
        options: { activate: true },
      }] : []),
      ...steps,
    ],
  }
}

export function playgroundRuntimeBlueprint(spec: RuntimeCreateSpec): unknown {
  const siteUrl = playgroundRuntimeSiteUrl(spec)
  const base = playgroundBlueprint(spec.environment.blueprint, spec.policy, siteUrl)
  const multisiteSteps = playgroundSiteSeedMultisiteBlueprintSteps(spec)
  if (multisiteSteps.length === 0) return base

  const normalized = !base || typeof base !== "object" || Array.isArray(base) ? {} : base as Record<string, unknown>
  const steps = Array.isArray(normalized.steps) ? normalized.steps : []
  const defineSiteUrlIndex = steps.findIndex((step) => Boolean(step) && typeof step === "object" && !Array.isArray(step) && (step as { step?: unknown }).step === "defineSiteUrl")
  const insertAt = defineSiteUrlIndex < 0 ? 0 : defineSiteUrlIndex + 1
  return {
    ...normalized,
    steps: [...steps.slice(0, insertAt), ...multisiteSteps, ...steps.slice(insertAt)],
  }
}

export function playgroundRuntimeSiteUrl(spec: RuntimeCreateSpec | undefined): string | undefined {
  const declaredSiteUrl = playgroundSiteSeedPrimaryUrl(spec) ?? spec?.preview?.siteUrl
  if (declaredSiteUrl || !spec || !blueprintNeedsPortlessMultisiteUrl(spec.environment.blueprint)) {
    return declaredSiteUrl
  }

  return "http://127.0.0.1"
}

function blueprintNeedsPortlessMultisiteUrl(blueprint: unknown): boolean {
  if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) return false
  const steps = Array.isArray((blueprint as Record<string, unknown>).steps) ? (blueprint as { steps: unknown[] }).steps : []
  let hasDefinedSiteUrl = false
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue
    const stepName = (step as { step?: unknown }).step
    if (stepName === "defineSiteUrl") hasDefinedSiteUrl = true
    if (stepName === "enableMultisite") return !hasDefinedSiteUrl
  }
  return false
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
