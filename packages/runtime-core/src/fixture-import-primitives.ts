import type { WorkspaceRecipeSiteSeed, WorkspaceRecipeSiteSeedDeterministicIds } from "./runtime-contracts.js"

export interface FixtureImportUnsupportedDeterministicId {
  scope: "posts" | "terms" | "users" | "media"
  index: number
  field: "id" | "ID"
  reason: string
}

export interface FixtureImportDeterministicIdPlan {
  schema: "wp-codebox/fixture-import-deterministic-ids/v1"
  strategy: WorkspaceRecipeSiteSeedDeterministicIds["strategy"]
  onUnsupported: WorkspaceRecipeSiteSeedDeterministicIds["onUnsupported"]
  status: "supported" | "blocked" | "best_effort"
  supportedIdentifiers: Record<string, string[]>
  unsupported: FixtureImportUnsupportedDeterministicId[]
}

const semanticIdentifiers: Record<string, string[]> = {
  posts: ["slug", "post_name"],
  terms: ["slug", "taxonomy", "name"],
  options: ["name"],
  users: ["user_login", "login", "user_email", "email"],
  media: ["slug", "post_name"],
  activePlugins: ["pluginFile", "file"],
  activeTheme: ["stylesheet", "slug"],
}

export function fixtureImportDeterministicIdPlan(siteSeed: WorkspaceRecipeSiteSeed, fixture?: unknown): FixtureImportDeterministicIdPlan | undefined {
  const deterministicIds = siteSeed.deterministicIds
  if (!deterministicIds) {
    return undefined
  }

  const unsupported = deterministicIds.strategy === "numeric"
    ? [{ scope: "posts" as const, index: -1, field: "id" as const, reason: "Numeric primary-key assignment is not supported by WordPress insert APIs." }]
    : unsupportedNumericIds(fixture)

  const blocked = unsupported.length > 0 && deterministicIds.onUnsupported === "block"

  return {
    schema: "wp-codebox/fixture-import-deterministic-ids/v1",
    strategy: deterministicIds.strategy,
    onUnsupported: deterministicIds.onUnsupported,
    status: blocked ? "blocked" : unsupported.length > 0 ? "best_effort" : "supported",
    supportedIdentifiers: semanticIdentifiers,
    unsupported,
  }
}

export function assertFixtureImportDeterministicIdsSupported(siteSeed: WorkspaceRecipeSiteSeed, fixture?: unknown): void {
  const plan = fixtureImportDeterministicIdPlan(siteSeed, fixture)
  if (!plan || plan.status !== "blocked") {
    return
  }

  const details = plan.unsupported.map((item) => `${item.scope}[${item.index}].${item.field}: ${item.reason}`).join("; ")
  throw new Error(`Fixture import deterministic ID blocker for ${siteSeed.name}: ${details}`)
}

function unsupportedNumericIds(fixture: unknown): FixtureImportUnsupportedDeterministicId[] {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    return []
  }

  const seed = fixture as Record<string, unknown>
  return [
    ...unsupportedNumericIdsForScope("posts", seed.posts),
    ...unsupportedNumericIdsForScope("terms", seed.terms),
    ...unsupportedNumericIdsForScope("users", seed.users),
    ...unsupportedNumericIdsForScope("media", seed.media),
  ]
}

function unsupportedNumericIdsForScope(scope: FixtureImportUnsupportedDeterministicId["scope"], records: unknown): FixtureImportUnsupportedDeterministicId[] {
  if (!Array.isArray(records)) {
    return []
  }

  const unsupported: FixtureImportUnsupportedDeterministicId[] = []
  records.forEach((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return
    }
    const candidate = record as Record<string, unknown>
    for (const field of ["id", "ID"] as const) {
      if (candidate[field] !== undefined) {
        unsupported.push({ scope, index, field, reason: "Numeric primary-key assignment is not supported by WordPress insert APIs." })
      }
    }
  })

  return unsupported
}
