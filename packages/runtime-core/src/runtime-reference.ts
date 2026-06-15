import { createHash } from "node:crypto"

import type { ArtifactFileDigest, ArtifactViewerMetadata } from "./artifact-manifest.js"
import { normalizeObservationArtifactRefs, normalizeRuntimeReferenceManifestFileRef } from "./artifact-references.js"
import { stableJson } from "./object-utils.js"
import type {
  ObservationResult,
  RuntimeEpisodeContentDigest,
  RuntimeEpisodeTrace,
  RuntimeEpisodeTraceRef,
  RuntimeInfo,
  Snapshot,
} from "./runtime-contracts.js"

export const RUNTIME_REFERENCE_MANIFEST_SCHEMA = "wp-codebox/runtime-reference-manifest/v1" as const
export const RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA = "wp-codebox/runtime-replay-reference-index/v1" as const

export type RuntimeSnapshotReplayStatus = "metadata-only" | "partial-replay" | "replayable-runtime-state" | "runtime-state-artifact" | "not-replayable" | (string & {})

export interface RuntimeReferenceManifestFileRef {
  path: string
  kind: string
  contentType: string
  sha256: ArtifactFileDigest
  viewer?: ArtifactViewerMetadata
}

export interface RuntimeReferenceManifestArtifactBundleRef {
  kind: "artifact-bundle"
  id: string
  digest: ArtifactFileDigest
}

export interface RuntimeReferenceManifestSnapshotRef {
  id: string
  semantics: string
  digest: RuntimeEpisodeContentDigest
  replay: {
    status: RuntimeSnapshotReplayStatus
    limitations: string[]
  }
  artifactRefs: RuntimeEpisodeTraceRef[]
}

export interface RuntimeReferenceManifest {
  schema: typeof RUNTIME_REFERENCE_MANIFEST_SCHEMA
  version: 1
  id: string
  createdAt: string
  digest: RuntimeEpisodeContentDigest
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  files: RuntimeReferenceManifestFileRef[]
  trace?: RuntimeReferenceManifestFileRef
  events?: RuntimeReferenceManifestFileRef
  snapshots: RuntimeReferenceManifestSnapshotRef[]
}

export interface RuntimeReplayReferenceIndexActionRef {
  index: number
  id: string
  actionRef: RuntimeEpisodeTraceRef
  executionRef: RuntimeEpisodeTraceRef
  observationRef?: RuntimeEpisodeTraceRef
}

export interface RuntimeReplayReferenceIndexObservationRef {
  id: string
  type: string
  ref: RuntimeEpisodeTraceRef
  artifactRefs: RuntimeEpisodeTraceRef[]
}

export interface RuntimeReplayReferenceIndex {
  schema: typeof RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA
  version: 1
  id: string
  createdAt: string
  digest: RuntimeEpisodeContentDigest
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  references: {
    trace?: RuntimeReferenceManifestFileRef
    events?: RuntimeReferenceManifestFileRef
    runtimeReferenceManifest?: RuntimeReferenceManifestFileRef
    observations?: RuntimeReferenceManifestFileRef
    commands?: RuntimeReferenceManifestFileRef
    runtimeEvents?: RuntimeReferenceManifestFileRef
    blueprintAfter?: RuntimeReferenceManifestFileRef
    blueprintAfterNotes?: RuntimeReferenceManifestFileRef
    mountedFiles?: RuntimeReferenceManifestFileRef
    mountDiffs?: RuntimeReferenceManifestFileRef
    changedFiles?: RuntimeReferenceManifestFileRef
    patch?: RuntimeReferenceManifestFileRef
    testResults?: RuntimeReferenceManifestFileRef
  }
  actions: RuntimeReplayReferenceIndexActionRef[]
  observations: RuntimeReplayReferenceIndexObservationRef[]
  snapshots: RuntimeReferenceManifestSnapshotRef[]
  replay: {
    status: "partial" | "runtime-state-artifact" | "metadata-only"
    instructions: string[]
    limitations: string[]
  }
}

export interface BuildRuntimeReferenceManifestInput {
  createdAt: string
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  files: RuntimeReferenceManifestFileRef[]
  trace?: RuntimeReferenceManifestFileRef
  events?: RuntimeReferenceManifestFileRef
  snapshots?: Snapshot[]
}

export interface BuildRuntimeReplayReferenceIndexInput {
  createdAt: string
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  files: RuntimeReferenceManifestFileRef[]
  trace?: RuntimeReferenceManifestFileRef
  events?: RuntimeReferenceManifestFileRef
  runtimeReferenceManifest?: RuntimeReferenceManifestFileRef
  snapshots?: Snapshot[]
  episodeTrace?: RuntimeEpisodeTrace
}

export function buildRuntimeReferenceManifest(input: BuildRuntimeReferenceManifestInput): RuntimeReferenceManifest {
  const manifest = {
    schema: RUNTIME_REFERENCE_MANIFEST_SCHEMA,
    version: 1 as const,
    id: "runtime-reference-manifest-pending",
    createdAt: input.createdAt,
    digest: { algorithm: "sha256" as const, value: "0".repeat(64) },
    runtime: input.runtime,
    artifactBundle: input.artifactBundle,
    files: input.files.map(runtimeReferenceManifestFileRef).sort((left, right) => left.path.localeCompare(right.path)),
    ...(input.trace ? { trace: runtimeReferenceManifestFileRef(input.trace) } : {}),
    ...(input.events ? { events: runtimeReferenceManifestFileRef(input.events) } : {}),
    snapshots: (input.snapshots ?? []).map(runtimeReferenceManifestSnapshotRef),
  }
  const digest = runtimeReferenceManifestDigest(manifest)

  return {
    ...manifest,
    id: `runtime-reference-manifest-sha256-${digest.value}`,
    digest,
  }
}

export function runtimeReferenceManifestDigest(manifest: RuntimeReferenceManifest): RuntimeEpisodeContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256")
      .update("wp-codebox/runtime-reference-manifest/v1\n")
      .update(stableJson(runtimeReferenceManifestDigestPayload(manifest)))
      .digest("hex"),
  }
}

export function buildRuntimeReplayReferenceIndex(input: BuildRuntimeReplayReferenceIndexInput): RuntimeReplayReferenceIndex {
  const filesByPath = new Map(input.files.map((file) => [file.path, runtimeReferenceManifestFileRef(file)]))
  const references = compactUndefined<RuntimeReplayReferenceIndex["references"]>({
    trace: input.trace ? runtimeReferenceManifestFileRef(input.trace) : filesByPath.get("files/runtime-episode-trace.json"),
    events: input.events ? runtimeReferenceManifestFileRef(input.events) : filesByPath.get("files/runtime-episode.jsonl"),
    runtimeReferenceManifest: input.runtimeReferenceManifest ? runtimeReferenceManifestFileRef(input.runtimeReferenceManifest) : filesByPath.get("files/runtime-reference-manifest.json"),
    observations: filesByPath.get("observations.jsonl"),
    commands: filesByPath.get("commands.jsonl"),
    runtimeEvents: filesByPath.get("events.jsonl"),
    blueprintAfter: filesByPath.get("blueprint.after.json"),
    blueprintAfterNotes: filesByPath.get("blueprint.after-notes.json"),
    mountedFiles: filesByPath.get("files/mounted-files.json"),
    mountDiffs: filesByPath.get("files/diffs.json"),
    changedFiles: filesByPath.get("files/changed-files.json"),
    patch: filesByPath.get("files/patch.diff"),
    testResults: filesByPath.get("files/test-results.json"),
  })
  const snapshots = (input.snapshots ?? []).map(runtimeReferenceManifestSnapshotRef)
  const index = {
    schema: RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA,
    version: 1 as const,
    id: "runtime-replay-reference-index-pending",
    createdAt: input.createdAt,
    digest: { algorithm: "sha256" as const, value: "0".repeat(64) },
    runtime: input.runtime,
    artifactBundle: input.artifactBundle,
    references,
    actions: runtimeReplayActionRefs(input.episodeTrace),
    observations: runtimeReplayObservationRefs(input.episodeTrace),
    snapshots,
    replay: runtimeReplayInstructions(references, snapshots),
  }
  const digest = runtimeReplayReferenceIndexDigest(index)

  return {
    ...index,
    id: `runtime-replay-reference-index-sha256-${digest.value}`,
    digest,
  }
}

export function runtimeReplayReferenceIndexDigest(index: RuntimeReplayReferenceIndex): RuntimeEpisodeContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256")
      .update("wp-codebox/runtime-replay-reference-index/v1\n")
      .update(stableJson(runtimeReplayReferenceIndexDigestPayload(index)))
      .digest("hex"),
  }
}

function runtimeReplayReferenceIndexDigestPayload(index: RuntimeReplayReferenceIndex): Record<string, unknown> {
  return {
    schema: index.schema,
    version: index.version,
    runtime: index.runtime,
    artifactBundle: index.artifactBundle,
    references: index.references,
    actions: index.actions,
    observations: index.observations,
    snapshots: index.snapshots,
    replay: index.replay,
  }
}

function runtimeReplayActionRefs(trace: RuntimeEpisodeTrace | undefined): RuntimeReplayReferenceIndexActionRef[] {
  return (trace?.steps ?? []).map((step) => compactUndefined({
    index: step.index,
    id: step.id,
    actionRef: step.actionRef,
    executionRef: step.executionRef,
    observationRef: step.observationRef,
  }))
}

function runtimeReplayObservationRefs(trace: RuntimeEpisodeTrace | undefined): RuntimeReplayReferenceIndexObservationRef[] {
  const observations = [
    ...(trace?.reset.observations ?? []),
    ...(trace?.steps.flatMap((step) => step.observation ? [step.observation] : []) ?? []),
  ]

  return observations.map((observation, index) => ({
    id: observation.id ?? `observation:${index}`,
    type: observation.type,
    ref: observationRef(observation, observation.id ?? `observation:${index}`),
    artifactRefs: normalizeObservationArtifactRefs(observation),
  }))
}

function runtimeReplayInstructions(
  references: RuntimeReplayReferenceIndex["references"],
  snapshots: RuntimeReferenceManifestSnapshotRef[],
): RuntimeReplayReferenceIndex["replay"] {
  const limitations = [...new Set(snapshots.flatMap((snapshot) => snapshot.replay.limitations))]
  if (snapshots.some((snapshot) => snapshot.replay.status === "runtime-state-artifact")) {
    return {
      status: "runtime-state-artifact",
      instructions: [
        "Use references.runtimeReferenceManifest for hashed runtime files and snapshot artifact refs.",
        "Use references.trace and references.events to replay recorded actions and lifecycle events.",
      ],
      limitations,
    }
  }

  return {
    status: snapshots.length > 0 ? "metadata-only" : "partial",
    instructions: [
      "Use references.trace for ordered runtime actions and execution records.",
      "Use references.observations plus observation artifact refs for captured runtime observations.",
      "Use references.blueprintAfter, references.mountedFiles, references.changedFiles, and references.patch for filesystem and mount-state evidence.",
      "Use references.runtimeReferenceManifest for snapshot metadata and replay limitations.",
    ],
    limitations: limitations.length > 0 ? limitations : [
      "This index points to replay evidence; it is not a complete WordPress database or filesystem checkpoint.",
    ],
  }
}

function runtimeReferenceManifestDigestPayload(manifest: RuntimeReferenceManifest): Record<string, unknown> {
  return {
    schema: manifest.schema,
    version: manifest.version,
    runtime: manifest.runtime,
    artifactBundle: manifest.artifactBundle,
    files: manifest.files,
    ...(manifest.trace ? { trace: manifest.trace } : {}),
    ...(manifest.events ? { events: manifest.events } : {}),
    snapshots: manifest.snapshots,
  }
}

function runtimeReferenceManifestFileRef(file: RuntimeReferenceManifestFileRef): RuntimeReferenceManifestFileRef {
  return normalizeRuntimeReferenceManifestFileRef(file) ?? file
}

function runtimeReferenceManifestSnapshotRef(snapshot: Snapshot): RuntimeReferenceManifestSnapshotRef {
  const semantics = snapshot.semantics ?? "metadata-only"

  return {
    id: snapshot.id,
    semantics,
    digest: snapshot.digest ?? runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload({ ...snapshot, semantics })),
    replay: runtimeSnapshotReplaySemantics(semantics),
    artifactRefs: normalizeObservationArtifactRefs(snapshot),
  }
}

function runtimeSnapshotReplaySemantics(semantics: string): RuntimeReferenceManifestSnapshotRef["replay"] {
  if (semantics === "replayable-runtime-state") {
    return { status: "replayable-runtime-state", limitations: [] }
  }

  if (semantics === "runtime-state-artifact") {
    return { status: "runtime-state-artifact", limitations: [] }
  }

  if (semantics === "partial-replay") {
    return {
      status: "partial-replay",
      limitations: [
        "Snapshot bundle contains replay instructions and artifact references, but not a complete WordPress database checkpoint.",
        "Replay consumers can restore mounted files and inspect runtime evidence; posts, options, terms, users, uploads, active theme/plugins, and browser/editor state may require external capture.",
      ],
    }
  }

  if (semantics === "metadata-only") {
    return {
      status: "metadata-only",
      limitations: [
        "Snapshot records runtime metadata only; it is not a WordPress database or filesystem checkpoint.",
        "Replay consumers must use trace actions and artifact bundle files to reconstruct supported state.",
      ],
    }
  }

  return {
    status: "not-replayable",
    limitations: [`Snapshot semantics are not recognized by this WP Codebox version: ${semantics}`],
  }
}

function observationRef(observation: ObservationResult, fallbackId: string): RuntimeEpisodeTraceRef {
  return { kind: "observation", id: observation.id || fallbackId, digest: observation.digest ?? runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation)) }
}

function runtimeEpisodeDigest(value: unknown): RuntimeEpisodeContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update("wp-codebox/runtime-episode-trace/v1\n").update(stableJson(value)).digest("hex"),
  }
}

function runtimeEpisodeObservationDigestPayload(observation: ObservationResult): Record<string, unknown> {
  return {
    schema: "wp-codebox/runtime-episode-observation/v1",
    type: observation.type,
    data: observation.data,
    observedAt: observation.observedAt,
    artifactRefs: observation.artifactRefs ?? [],
  }
}

function runtimeEpisodeSnapshotDigestPayload(snapshot: Snapshot): Record<string, unknown> {
  return {
    schema: "wp-codebox/runtime-episode-snapshot/v1",
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    semantics: snapshot.semantics,
    metadata: snapshot.metadata,
    artifactRefs: snapshot.artifactRefs ?? [],
  }
}

function compactUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
