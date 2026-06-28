import { isPlainObject } from "./object-utils.js"
import { artifactFileDigest, type ArtifactFileDigest } from "./artifact-manifest.js"

export const STRUCTURED_ARTIFACT_SCHEMA = "wp-codebox/structured-artifact/v1" as const
export const TYPED_ARTIFACT_SCHEMA = "wp-codebox/typed-artifact/v1" as const
export const STRUCTURED_ARTIFACT_INDEX_SCHEMA = "wp-codebox/structured-artifacts-index/v1" as const
export const TYPED_ARTIFACT_INDEX_SCHEMA = "wp-codebox/typed-artifacts-index/v1" as const

export type StructuredArtifactDirection = "input" | "output"

export interface StructuredArtifactPayload {
  schema: typeof STRUCTURED_ARTIFACT_SCHEMA
  name: string
  type: string
  payload_schema?: string | Record<string, unknown>
  payload: unknown
  metadata: Record<string, unknown>
  provenance: {
    direction: StructuredArtifactDirection
    source?: string
  }
}

export interface StructuredArtifactRef extends StructuredArtifactPayload {
  artifact?: {
    path: string
    kind: "structured-artifact"
    contentType: "application/json"
    sha256: string
  }
}

export interface StructuredArtifactIndex {
  schema: typeof STRUCTURED_ARTIFACT_INDEX_SCHEMA
  direction: StructuredArtifactDirection
  artifacts: StructuredArtifactRef[]
}

export interface TypedArtifactRef {
  schema: typeof TYPED_ARTIFACT_SCHEMA
  name: string
  type: string
  payload_schema?: string | Record<string, unknown>
  payload?: unknown
  metadata: Record<string, unknown>
  provenance: {
    direction: "output"
    source: string
  }
  artifact: {
    path: string
    kind: "typed-artifact"
    contentType: string
    sha256: string
  }
}

export interface TypedArtifactDTO extends Omit<TypedArtifactRef, "artifact"> {
  artifact?: TypedArtifactRef["artifact"]
}

export interface TypedArtifactIndex {
  schema: typeof TYPED_ARTIFACT_INDEX_SCHEMA
  direction: "output"
  artifacts: TypedArtifactRef[]
}

export interface NormalizeTypedArtifactDTODefaults {
  name?: string
  type?: string
  source?: string
  contentType?: string
}

export interface MaterializedStructuredArtifactRef extends Omit<StructuredArtifactPayload, "schema" | "payload"> {
  schema: typeof STRUCTURED_ARTIFACT_SCHEMA | typeof TYPED_ARTIFACT_SCHEMA
  payload?: unknown
  artifact?: {
    path: string
    kind: string
    contentType: string
    sha256: string
  }
}

export interface StructuredArtifactMaterializationInput<TArtifact extends StructuredArtifactPayload = StructuredArtifactPayload> {
  artifacts: TArtifact[]
  artifactPathPrefix: string
  artifactKind: string
  indexKind: string
  indexSchema: typeof STRUCTURED_ARTIFACT_INDEX_SCHEMA | typeof TYPED_ARTIFACT_INDEX_SCHEMA
  contentType?: string | ((artifact: TArtifact, index: number) => string)
  contents?: (artifact: TArtifact, index: number) => string | Buffer
  extension?: (contentType: string, artifact: TArtifact, index: number) => string
}

export interface StructuredArtifactMaterializedFile<TArtifact extends StructuredArtifactPayload = StructuredArtifactPayload> {
  path: string
  kind: string
  contentType: string
  contents: string | Buffer
  sha256: ArtifactFileDigest
  artifact?: TArtifact
}

export interface StructuredArtifactMaterializationResult<TRef extends MaterializedStructuredArtifactRef = MaterializedStructuredArtifactRef> {
  refs: TRef[]
  index: StructuredArtifactIndex | TypedArtifactIndex
  files: StructuredArtifactMaterializedFile[]
}

export function materializeStructuredArtifactFiles<TArtifact extends StructuredArtifactPayload, TRef extends MaterializedStructuredArtifactRef = MaterializedStructuredArtifactRef>(input: StructuredArtifactMaterializationInput<TArtifact>): StructuredArtifactMaterializationResult<TRef> {
  const artifactPathPrefix = normalizeArtifactPathPrefix(input.artifactPathPrefix)
  const refs: MaterializedStructuredArtifactRef[] = []
  const files: StructuredArtifactMaterializedFile[] = []

  for (const [index, artifact] of input.artifacts.entries()) {
    const contents = input.contents ? input.contents(artifact, index) : `${JSON.stringify(artifact, null, 2)}\n`
    const contentType = typeof input.contentType === "function" ? input.contentType(artifact, index) : input.contentType ?? "application/json"
    const extension = input.extension ? input.extension(contentType, artifact, index) : structuredArtifactExtension(contentType)
    const path = `${artifactPathPrefix}/${safeStructuredArtifactName(artifact.name)}-${index + 1}${extension}`
    const sha256 = artifactFileDigest(contents)
    const schema = input.artifactKind === "typed-artifact" ? TYPED_ARTIFACT_SCHEMA : artifact.schema
    const ref: MaterializedStructuredArtifactRef = stripUndefined({
      ...artifact,
      schema,
      artifact: {
        path,
        kind: input.artifactKind,
        contentType,
        sha256: sha256.value,
      },
    }) as MaterializedStructuredArtifactRef
    refs.push(ref)
    files.push({ path, kind: input.artifactKind, contentType, contents, sha256, artifact })
  }

  const index: StructuredArtifactIndex | TypedArtifactIndex = {
    schema: input.indexSchema,
    direction: "output",
    artifacts: refs as never,
  }
  const indexContents = `${JSON.stringify(index, null, 2)}\n`
  files.push({
    path: `${artifactPathPrefix}/index.json`,
    kind: input.indexKind,
    contentType: "application/json",
    contents: indexContents,
    sha256: artifactFileDigest(indexContents),
  })

  return { refs: refs as TRef[], index, files }
}

export function normalizeStructuredArtifacts(value: unknown, direction: StructuredArtifactDirection): StructuredArtifactPayload[] {
  const entries = Array.isArray(value) ? value : []
  return entries.flatMap((entry): StructuredArtifactPayload[] => {
    if (!isPlainObject(entry)) return []

    const name = stringValue(entry.name)
    const type = stringValue(entry.type)
    if (!name || !type) return []

    const metadata = isPlainObject(entry.metadata) ? entry.metadata : {}
    const provenance = isPlainObject(entry.provenance) ? entry.provenance : {}
    const payloadSchema = structuredPayloadSchema(entry.payload_schema ?? entry.payloadSchema ?? entry.artifact_schema ?? entry.artifactSchema)

    return [{
      schema: STRUCTURED_ARTIFACT_SCHEMA,
      name,
      type,
      ...(payloadSchema !== undefined ? { payload_schema: payloadSchema } : {}),
      payload: entry.payload,
      metadata,
      provenance: {
        ...provenance,
        direction,
        ...(typeof provenance.source === "string" && provenance.source.trim() ? { source: provenance.source.trim() } : {}),
      },
    }]
  })
}

export function normalizeTypedArtifactDTO(input: unknown, defaults: NormalizeTypedArtifactDTODefaults = {}): TypedArtifactDTO | undefined {
  const entry = isPlainObject(input) ? input : undefined
  if (!entry) return undefined

  const name = stringValue(entry.name) || defaults.name || ""
  const type = stringValue(entry.type) || defaults.type || ""
  if (!name || !type) return undefined

  const artifact = typedArtifactFile(entry.artifact, defaults)
  const hasPayload = "payload" in entry
  if (!artifact && !hasPayload) return undefined

  const provenance = isPlainObject(entry.provenance) ? entry.provenance : {}
  const source = stringValue(provenance.source) || stringValue(entry.source) || defaults.source || "runtime"
  const payloadSchema = structuredPayloadSchema(entry.payload_schema)

  return stripUndefined({
    schema: TYPED_ARTIFACT_SCHEMA,
    name,
    type,
    ...(payloadSchema !== undefined ? { payload_schema: payloadSchema } : {}),
    ...(hasPayload ? { payload: entry.payload } : {}),
    metadata: isPlainObject(entry.metadata) ? entry.metadata : {},
    provenance: {
      ...provenance,
      direction: "output",
      source,
    },
    artifact,
  }) as TypedArtifactDTO
}

export function normalizeTypedArtifactDTOs(input: unknown): TypedArtifactDTO[] {
  const artifacts = Array.isArray(input)
    ? input
    : isPlainObject(input) && Array.isArray(input.artifacts)
      ? input.artifacts
      : []
  return artifacts.flatMap((entry) => {
    const artifact = normalizeTypedArtifactDTO(entry)
    return artifact ? [artifact] : []
  })
}

export function normalizeTypedArtifactIndex(input: unknown): TypedArtifactIndex {
  return {
    schema: TYPED_ARTIFACT_INDEX_SCHEMA,
    direction: "output",
    artifacts: normalizeTypedArtifactDTOs(input).filter((artifact): artifact is TypedArtifactRef => Boolean(artifact.artifact)),
  }
}

function structuredPayloadSchema(value: unknown): string | Record<string, unknown> | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (isPlainObject(value)) return value
  return undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function typedArtifactFile(input: unknown, defaults: NormalizeTypedArtifactDTODefaults): TypedArtifactRef["artifact"] | undefined {
  const value = isPlainObject(input) ? input : undefined
  if (!value) return undefined
  const path = stringValue(value.path) || stringValue(value.relativePath) || stringValue(value.artifact_path) || stringValue(value.artifactPath)
  const sha256 = stringValue(value.sha256) || stringValue(value.digest) || digestValue(value.digest) || digestValue(value.contentDigest)
  if (!path || !sha256) return undefined
  return {
    path,
    kind: "typed-artifact",
    contentType: stringValue(value.contentType) || stringValue(value.content_type) || stringValue(value.mimeType) || stringValue(value.mime) || defaults.contentType || "application/octet-stream",
    sha256,
  }
}

function digestValue(input: unknown): string {
  return isPlainObject(input) && input.algorithm === "sha256" ? stringValue(input.value) : ""
}

function safeStructuredArtifactName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact"
}

function structuredArtifactExtension(contentType: string): string {
  if (contentType === "application/json") return ".json"
  if (contentType.startsWith("text/")) return ".txt"
  return ".bin"
}

function normalizeArtifactPathPrefix(prefix: string): string {
  return prefix.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
