import type { WorkspaceRecipe, WorkspaceRecipeExternalServiceBoundary } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"

export interface RecipeExternalServiceBoundarySummary {
  schema: "wp-codebox/external-service-boundary-summary/v1"
  id: string
  label?: string
  environment: WorkspaceRecipeExternalServiceBoundary["environment"]
  allowedHosts: string[]
  blockedHosts: string[]
  writes: WorkspaceRecipeExternalServiceBoundary["writes"]
  secretEnv: string[]
  redaction: {
    policy: NonNullable<WorkspaceRecipeExternalServiceBoundary["redaction"]>["policy"]
    fields: string[]
  }
}

export interface RecipeExternalServiceBoundaryHostCorrelation {
  schema: "wp-codebox/external-service-boundary-host-correlation/v1"
  observedHosts: Array<{
    host: string
    boundaryIds: string[]
    requests?: number
    external?: boolean
    blocked?: number
    routed?: number
  }>
  unmatchedHosts: string[]
}

export function recipeExternalServiceBoundarySummaries(recipe: WorkspaceRecipe): RecipeExternalServiceBoundarySummary[] {
  return (recipe.inputs?.externalServices ?? []).map((boundary) => stripUndefined({
    schema: "wp-codebox/external-service-boundary-summary/v1" as const,
    id: boundary.id,
    label: boundary.label,
    environment: boundary.environment,
    allowedHosts: [...(boundary.allowedHosts ?? [])].map(normalizeHost).filter(Boolean).sort(),
    blockedHosts: [...(boundary.blockedHosts ?? [])].map(normalizeHost).filter(Boolean).sort(),
    writes: boundary.writes,
    secretEnv: [...(boundary.secretEnv ?? [])].sort(),
    redaction: {
      policy: boundary.redaction?.policy ?? "metadata-only",
      fields: [...(boundary.redaction?.fields ?? [])].sort(),
    },
  }))
}

export function correlateObservedHostsToExternalServiceBoundaries(observedHosts: Record<string, unknown> | undefined, boundaries: RecipeExternalServiceBoundarySummary[]): RecipeExternalServiceBoundaryHostCorrelation | undefined {
  if (!observedHosts || boundaries.length === 0) {
    return undefined
  }

  const observed = Object.entries(observedHosts).map(([host, value]) => {
    const normalized = normalizeHost(host)
    const stat = recordValue(value)
    const boundaryIds = boundaries
      .filter((boundary) => boundary.allowedHosts.includes(normalized) || boundary.blockedHosts.includes(normalized))
      .map((boundary) => boundary.id)
      .sort()
    return stripUndefined({
      host: normalized,
      boundaryIds,
      requests: numberValue(stat?.requests),
      external: typeof stat?.external === "boolean" ? stat.external : undefined,
      blocked: numberValue(stat?.blocked),
      routed: numberValue(stat?.routed),
    })
  }).filter((entry) => entry.host !== "")
    .sort((left, right) => left.host.localeCompare(right.host))

  if (observed.length === 0) {
    return undefined
  }

  return {
    schema: "wp-codebox/external-service-boundary-host-correlation/v1",
    observedHosts: observed,
    unmatchedHosts: observed.filter((entry) => entry.boundaryIds.length === 0).map((entry) => entry.host),
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "")
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
