export const BROWSER_ARTIFACT_GRANT_SCHEMA = "wp-codebox/browser-artifact-grant/v1" as const
export const BROWSER_ARTIFACT_REF_SCHEMA = "wp-codebox/browser-artifact-ref/v1" as const
export const BROWSER_ARTIFACT_WRITE_SCOPE = "artifact:write" as const

export interface BrowserArtifactAuthorization {
  schema: "wp-codebox/trusted-orchestrator-authorization/v1"
  caller: string
  scope: typeof BROWSER_ARTIFACT_WRITE_SCOPE
}

export interface BrowserArtifactGrantInput {
  caller: string
  sessionId: string
  expiresAt?: string | Date
  artifactsPath?: string
  metadata?: Record<string, unknown>
}

export interface BrowserArtifactGrant {
  schema: typeof BROWSER_ARTIFACT_GRANT_SCHEMA
  scope: typeof BROWSER_ARTIFACT_WRITE_SCOPE
  session_id: string
  authorization: BrowserArtifactAuthorization
  expires_at?: string
  artifacts_path?: string
  metadata?: Record<string, unknown>
}

export interface BrowserArtifactRefInput {
  artifactId?: string
  artifact_id?: string
  contentDigest?: string
  content_digest?: string
  artifactsPath?: string
  artifacts_path?: string
  directory?: string
  status?: string
  sessionId?: string
  session_id?: string
  grant?: BrowserArtifactGrant
  authorization?: BrowserArtifactAuthorization
}

export interface BrowserArtifactLifecycleRef {
  schema: typeof BROWSER_ARTIFACT_REF_SCHEMA
  artifact_id: string
  content_digest: string
  artifacts_path?: string
  status?: string
  session_id?: string
  grant?: BrowserArtifactGrant
  authorization?: BrowserArtifactAuthorization
}

export function browserArtifactGrant(input: BrowserArtifactGrantInput): BrowserArtifactGrant {
  const caller = requiredString(input.caller, "caller")
  const sessionId = requiredString(input.sessionId, "sessionId")
  return stripUndefined({
    schema: BROWSER_ARTIFACT_GRANT_SCHEMA,
    scope: BROWSER_ARTIFACT_WRITE_SCOPE,
    session_id: sessionId,
    authorization: {
      schema: "wp-codebox/trusted-orchestrator-authorization/v1",
      caller,
      scope: BROWSER_ARTIFACT_WRITE_SCOPE,
    },
    expires_at: normalizeOptionalDate(input.expiresAt),
    artifacts_path: optionalString(input.artifactsPath),
    metadata: input.metadata,
  })
}

export function browserArtifactRef(input: BrowserArtifactRefInput): BrowserArtifactLifecycleRef {
  const artifactId = requiredString(input.artifactId ?? input.artifact_id, "artifact_id")
  const contentDigest = requiredString(input.contentDigest ?? input.content_digest, "content_digest")
  const artifactsPath = optionalString(input.artifactsPath ?? input.artifacts_path ?? input.directory)
  return stripUndefined({
    schema: BROWSER_ARTIFACT_REF_SCHEMA,
    artifact_id: artifactId,
    content_digest: contentDigest,
    artifacts_path: artifactsPath,
    status: optionalString(input.status),
    session_id: optionalString(input.sessionId ?? input.session_id),
    grant: input.grant,
    authorization: input.authorization,
  })
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new Error(`Browser artifact ${field} is required`)
  }
  return normalized
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeOptionalDate(value: string | Date | undefined): string | undefined {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return optionalString(value)
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
