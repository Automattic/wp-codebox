import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { artifactFileDigest, artifactManifestFile, refreshArtifactManifestFileSha256s, upsertArtifactManifestFiles } from "./artifact-manifest.js"
import type { ArtifactManifest, ArtifactSpec } from "./artifact-manifest.js"
import { writeArtifactJson, writeArtifactManifestJson } from "./artifact-layout.js"
import {
  ARTIFACT_MANIFEST_PATH,
  RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH,
  RUNTIME_EPISODE_TRACE_ARTIFACT_PATH,
  RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH,
  RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH,
  normalizeArtifactBundleTraceRef,
  normalizeRuntimeReferenceArtifactBundleRef,
  normalizeRuntimeReferenceManifestFileRefs,
  runtimeReferenceManifestArtifactFiles,
  runtimeReplayReferenceIndexArtifactFiles,
} from "./artifact-references.js"
import { isPlainObject as isRecord } from "./object-utils.js"
import {
  RUNTIME_EPISODE_ACTION_SCHEMA,
  RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
  RUNTIME_EPISODE_TRACE_SCHEMA,
  runtimeEpisodeActionDigestPayload,
  runtimeEpisodeDigest,
  runtimeEpisodeObservationDigestPayload,
  runtimeEpisodeSnapshotDigestPayload,
} from "./runtime-episode-contracts.js"
import { buildRuntimeReferenceManifest, buildRuntimeReplayReferenceIndex } from "./runtime-reference.js"
import type { RuntimeReferenceManifestSnapshotRef } from "./runtime-reference.js"
import { assertRuntimePolicy } from "./runtime-policy.js"
import type {
  ArtifactBundle,
  ObservationResult,
  ObservationSpec,
  Runtime,
  RuntimeBackend,
  RuntimeEpisode,
  RuntimeEpisodeActionSpec,
  RuntimeEpisodeResetResult,
  RuntimeEpisodeSpec,
  RuntimeEpisodeStepResult,
  RuntimeEpisodeTrace,
  RuntimeEpisodeTraceRef,
  Snapshot,
} from "./runtime-contracts.js"
import type { ArtifactReview } from "./index.js"
export {
  RUNTIME_EPISODE_ACTION_SCHEMA,
  RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
  RUNTIME_EPISODE_TRACE_JSON_SCHEMA,
  RUNTIME_EPISODE_TRACE_SCHEMA,
  runtimeEpisodeDigest,
  validateRuntimeEpisodeTrace,
} from "./runtime-episode-contracts.js"

function observationRef(observation: ObservationResult, fallbackId: string): RuntimeEpisodeTraceRef {
  return { kind: "observation", id: observation.id || fallbackId, digest: observation.digest ?? runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation)) }
}

function observationWithId(observation: ObservationResult, fallbackId: string): ObservationResult {
  const enveloped = {
    ...observation,
    schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
    id: observation.id || fallbackId,
  }

  return { ...enveloped, digest: runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(enveloped)) }
}

function snapshotWithSemantics(snapshot: Snapshot): Snapshot {
  const enveloped = {
    ...snapshot,
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    semantics: snapshot.semantics ?? "metadata-only",
  }

  return { ...enveloped, digest: runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload(enveloped)) }
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

function runtimeEpisodeJsonLines(trace: RuntimeEpisodeTrace): string {
  const records: Array<Record<string, unknown>> = [
    {
      type: "episode.reset",
      id: trace.reset.id,
      runtime: trace.reset.runtime,
      observations: trace.reset.observationRefs,
    },
    ...trace.steps.map((step) => ({
      type: "episode.step",
      id: step.id,
      index: step.index,
      actionRef: step.actionRef,
      executionRef: step.executionRef,
      ...(step.observationRef ? { observationRef: step.observationRef } : {}),
    })),
    ...trace.snapshots.map((snapshot) => ({
      type: "episode.snapshot",
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      semantics: snapshot.semantics,
      artifactRefs: snapshot.artifactRefs ?? [],
    })),
  ]

  if (trace.artifactRef) {
    records.push({
      type: "episode.artifacts",
      id: trace.artifactRef.id,
      artifactRef: trace.artifactRef,
    })
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

export async function createRuntimeEpisode(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<RuntimeEpisode> {
  return RuntimeEpisodeRunner.create(spec, backend)
}

class RuntimeEpisodeRunner implements RuntimeEpisode {
  private runtime?: Runtime
  private resetResult?: RuntimeEpisodeResetResult
  private resetCount = 0
  private readonly steps: RuntimeEpisodeStepResult[] = []
  private readonly snapshots: Snapshot[] = []
  private artifacts?: ArtifactBundle
  private traceCreatedAt?: string

  private constructor(
    private readonly spec: RuntimeEpisodeSpec,
    private readonly backend: RuntimeBackend,
  ) {}

  static async create(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<RuntimeEpisodeRunner> {
    const episode = new RuntimeEpisodeRunner(spec, backend)
    await episode.reset()
    return episode
  }

  async reset(): Promise<RuntimeEpisodeResetResult> {
    await this.runtime?.destroy()
    this.runtime = await createEpisodeRuntime(this.spec, this.backend)
    this.steps.length = 0
    this.snapshots.length = 0
    this.artifacts = undefined
    this.traceCreatedAt = undefined

    for (const mount of this.spec.mounts ?? []) {
      await this.runtime.mount(mount)
    }

    const runtime = await this.runtime.info()
    const resetId = `${runtime.id}:reset:${this.resetCount++}`
    const observations = []
    for (const [index, observation] of (this.spec.resetObservations ?? [{ type: "runtime-info" }, { type: "mounts" }]).entries()) {
      observations.push(observationWithId(await this.runtime.observe(observation), `${resetId}:observation:${index}`))
    }
    this.resetResult = {
      id: resetId,
      runtime,
      observations,
      observationRefs: observations.map((observation, index) => observationRef(observation, `${resetId}:observation:${index}`)),
    }

    return this.resetResult
  }

  async step(action: RuntimeEpisodeActionSpec, observation: ObservationSpec | false = this.spec.stepObservation ?? false): Promise<RuntimeEpisodeStepResult> {
    const runtime = this.assertRuntime()
    const execution = await runtime.execute(action)
    const index = this.steps.length
    const stepId = `${execution.id}:step:${index}`
    const actionRecord = {
      schema: RUNTIME_EPISODE_ACTION_SCHEMA,
      id: `${stepId}:action`,
      kind: action.kind ?? "command",
      command: action.command,
      args: action.args ?? [],
      ...(action.cwd ? { cwd: action.cwd } : {}),
      ...(action.timeoutMs !== undefined ? { timeoutMs: action.timeoutMs } : {}),
      ...(action.method ? { method: action.method } : {}),
      ...(action.url ? { url: action.url } : {}),
      ...(action.path ? { path: action.path } : {}),
      ...(action.operation ? { operation: action.operation } : {}),
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.description ? { description: action.description } : {}),
      ...(action.metadata ? { metadata: action.metadata } : {}),
      digest: runtimeEpisodeDigest(runtimeEpisodeActionDigestPayload(action)),
    }
    const stepObservation = observation ? observationWithId(await runtime.observe(observation), `${stepId}:observation`) : undefined
    const result: RuntimeEpisodeStepResult = {
      id: stepId,
      index,
      action: actionRecord,
      actionRef: { kind: "action", id: actionRecord.id, digest: actionRecord.digest },
      execution,
      executionRef: { kind: "execution", id: execution.id, digest: runtimeEpisodeDigest(execution) },
      ...(stepObservation
        ? { observation: stepObservation, observationRef: observationRef(stepObservation, `${stepId}:observation`) }
        : {}),
    }

    this.steps.push(result)
    return result
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    return this.assertRuntime().observe(spec)
  }

  async snapshot(): Promise<Snapshot> {
    const snapshot = snapshotWithSemantics(await this.assertRuntime().snapshot())
    this.snapshots.push(snapshot)
    return snapshot
  }

  async restoreSnapshot(snapshotOrRef: Snapshot | string): Promise<Snapshot> {
    const snapshot = typeof snapshotOrRef === "string"
      ? this.snapshots.find((candidate) => candidate.id === snapshotOrRef)
      : snapshotOrRef
    if (!snapshot) {
      throw new Error(`Runtime episode snapshot not found: ${snapshotOrRef}`)
    }

    const runtime = this.assertRuntime()
    if (!runtime.restoreSnapshot) {
      const runtimeInfo = await runtime.info()
      throw new Error(`Runtime backend does not support same-runtime snapshot restore: ${runtimeInfo.backend}`)
    }

    const restored = snapshotWithSemantics(await runtime.restoreSnapshot(snapshot))
    if (!this.snapshots.some((candidate) => candidate.id === restored.id)) {
      this.snapshots.push(restored)
    }
    return restored
  }

  async collectArtifacts(spec: ArtifactSpec = this.spec.artifactSpec ?? {}): Promise<ArtifactBundle> {
    const artifacts = await this.assertRuntime().collectArtifacts(spec)
    this.artifacts = {
      ...artifacts,
      runtimeEpisodeTracePath: join(artifacts.directory, RUNTIME_EPISODE_TRACE_ARTIFACT_PATH),
      runtimeEpisodeEventsPath: join(artifacts.directory, RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH),
      runtimeReplayReferenceIndexPath: join(artifacts.directory, RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH),
    }
    if (spec.includeRuntimeSnapshotBundles) {
      await this.persistRuntimeSnapshotBundles()
    }
    await this.persistRuntimeEpisodeTraceArtifacts()
    return this.artifacts
  }

  private async persistRuntimeSnapshotBundles(): Promise<void> {
    if (!this.artifacts || this.snapshots.length === 0) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const snapshotDirectory = join(this.artifacts.directory, "files/runtime-snapshots")
    await mkdir(snapshotDirectory, { recursive: true })
    const baseRefs = runtimeReferenceManifestArtifactFiles(manifest.files)
    const snapshotRefs = normalizeRuntimeReferenceManifestFileRefs(baseRefs)

    for (const [index, snapshot] of this.snapshots.entries()) {
      const semantics = snapshot.semantics === "replayable-runtime-state" || snapshot.semantics === "runtime-state-artifact"
        ? snapshot.semantics
        : "partial-replay"
      const replay = runtimeSnapshotReplaySemantics(semantics)
      const relativePath = `files/runtime-snapshots/${snapshot.id}.json`
      const bundleId = `${snapshot.id}:runtime-snapshot-bundle`
      const bundle = {
        schema: "wp-codebox/runtime-snapshot-bundle/v1",
        version: 1,
        id: bundleId,
        snapshot: {
          id: snapshot.id,
          createdAt: snapshot.createdAt,
          originalSemantics: snapshot.semantics ?? "metadata-only",
          semantics,
          metadata: snapshot.metadata,
        },
        replay: {
          status: replay.status,
          limitations: replay.limitations,
          instructions: [
            "Verify every referenced artifact SHA-256 before replay.",
            "Use blueprint.after.json and blueprint.after-notes.json as generated Playground replay guidance when present.",
            "Restore mounted file artifacts from files/mounted-files.json where replayable file contents are available.",
            "Use files/runtime-episode-trace.json and files/runtime-episode.jsonl to inspect actions, observations, and snapshot refs after the episode trace is persisted.",
          ],
        },
        refs: snapshotRefs,
      }
      await writeArtifactJson(join(this.artifacts.directory, relativePath), bundle)
      const digest = artifactFileDigest(await readFile(join(this.artifacts.directory, relativePath)))
      const artifactRef: RuntimeEpisodeTraceRef = {
        kind: "runtime-snapshot-bundle",
        id: bundleId,
        path: relativePath,
        digest,
      }
      this.snapshots[index] = snapshotWithSemantics({
        ...snapshot,
        semantics,
        artifactRefs: [
          ...(snapshot.artifactRefs ?? []).filter((ref) => ref.path !== relativePath),
          artifactRef,
        ],
      })
      upsertArtifactManifestFiles(manifest, [artifactManifestFile(relativePath, "runtime-snapshot-bundle", "application/json")])
    }

    await writeArtifactManifestJson(this.artifacts.directory, ARTIFACT_MANIFEST_PATH, manifest)
  }

  private async persistRuntimeEpisodeTraceArtifacts(): Promise<void> {
    if (!this.artifacts?.runtimeEpisodeTracePath || !this.artifacts.runtimeEpisodeEventsPath || !this.artifacts.runtimeReferenceManifestPath || !this.artifacts.runtimeReplayReferenceIndexPath) {
      return
    }

    const trace = await this.trace()
    const traceRelativePath = RUNTIME_EPISODE_TRACE_ARTIFACT_PATH
    const eventsRelativePath = RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH
    await writeFile(this.artifacts.runtimeEpisodeTracePath, `${JSON.stringify(trace, null, 2)}\n`)
    await writeFile(this.artifacts.runtimeEpisodeEventsPath, `${runtimeEpisodeJsonLines(trace)}`)
    await this.updateArtifactMetadataForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateArtifactReviewForRuntimeEpisodeTrace(traceRelativePath)
    await this.updateArtifactManifestForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateRuntimeReferenceManifestForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateRuntimeReplayReferenceIndexForRuntimeEpisodeTrace(trace, traceRelativePath, eventsRelativePath)
  }

  private async updateRuntimeReferenceManifestForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts?.runtimeReferenceManifestPath) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const fileRefs = runtimeReferenceManifestArtifactFiles(manifest.files)
    const referenceFiles = normalizeRuntimeReferenceManifestFileRefs(fileRefs)
    const traceRef = referenceFiles.find((file) => file.path === traceRelativePath)
    const eventsRef = referenceFiles.find((file) => file.path === eventsRelativePath)
    const artifactBundle = normalizeRuntimeReferenceArtifactBundleRef(manifest)
    if (!artifactBundle) {
      return
    }
    const referenceManifest = buildRuntimeReferenceManifest({
      createdAt: this.artifacts.createdAt,
      runtime: manifest.runtime,
      artifactBundle,
      files: referenceFiles,
      ...(traceRef ? { trace: traceRef } : {}),
      ...(eventsRef ? { events: eventsRef } : {}),
      snapshots: this.snapshots,
    })
    await writeArtifactJson(this.artifacts.runtimeReferenceManifestPath, referenceManifest)
    await refreshArtifactManifestFileSha256s(this.artifacts.directory, manifest)
    await writeArtifactJson(this.artifacts.manifestPath, manifest)
  }

  private async updateRuntimeReplayReferenceIndexForRuntimeEpisodeTrace(trace: RuntimeEpisodeTrace, traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts?.runtimeReplayReferenceIndexPath) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const fileRefs = runtimeReplayReferenceIndexArtifactFiles(manifest.files)
    const referenceFiles = normalizeRuntimeReferenceManifestFileRefs(fileRefs)
    const traceRef = referenceFiles.find((file) => file.path === traceRelativePath)
    const eventsRef = referenceFiles.find((file) => file.path === eventsRelativePath)
    const runtimeReferenceManifestRef = referenceFiles.find((file) => file.path === RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH)
    const artifactBundle = normalizeRuntimeReferenceArtifactBundleRef(manifest)
    if (!artifactBundle) {
      return
    }
    const replayIndex = buildRuntimeReplayReferenceIndex({
      createdAt: this.artifacts.createdAt,
      runtime: manifest.runtime,
      artifactBundle,
      files: referenceFiles,
      ...(traceRef ? { trace: traceRef } : {}),
      ...(eventsRef ? { events: eventsRef } : {}),
      ...(runtimeReferenceManifestRef ? { runtimeReferenceManifest: runtimeReferenceManifestRef } : {}),
      snapshots: this.snapshots,
      episodeTrace: trace,
    })
    await writeArtifactJson(this.artifacts.runtimeReplayReferenceIndexPath, replayIndex)
    await refreshArtifactManifestFileSha256s(this.artifacts.directory, manifest)
    await writeArtifactJson(this.artifacts.manifestPath, manifest)
  }

  private async updateArtifactManifestForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    upsertArtifactManifestFiles(manifest, [
      artifactManifestFile(traceRelativePath, "runtime-episode-trace", "application/json"),
      artifactManifestFile(eventsRelativePath, "runtime-episode-events", "application/x-ndjson"),
      artifactManifestFile(RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH, "runtime-replay-index", "application/json"),
    ])
    await refreshArtifactManifestFileSha256s(this.artifacts.directory, manifest)
    await writeArtifactManifestJson(this.artifacts.directory, ARTIFACT_MANIFEST_PATH, manifest)
  }

  private async updateArtifactMetadataForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const metadata = JSON.parse(await readFile(this.artifacts.metadataPath, "utf8")) as Record<string, unknown>
    metadata.artifacts = {
      ...(isRecord(metadata.artifacts) ? metadata.artifacts : {}),
      runtimeEpisodeTrace: traceRelativePath,
      runtimeEpisodeEvents: eventsRelativePath,
      runtimeReplayReferenceIndex: RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH,
    }
    await writeArtifactJson(this.artifacts.metadataPath, metadata)
  }

  private async updateArtifactReviewForRuntimeEpisodeTrace(traceRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const review = JSON.parse(await readFile(this.artifacts.reviewPath, "utf8")) as ArtifactReview
    review.evidence.runtimeEpisodeTrace = traceRelativePath
    review.evidence.runtimeReplayReferenceIndex = RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH
    if (!review.progress.some((event) => event.type === "artifact" && event.component === "runtime-episode")) {
      review.progress.push({
        type: "artifact",
        component: "runtime-episode",
        label: "Runtime episode trace persisted",
        timestamp: new Date().toISOString(),
      })
    }
    await writeArtifactJson(this.artifacts.reviewPath, review)
  }

  async trace(): Promise<RuntimeEpisodeTrace> {
    const runtime = this.assertRuntime()
    const reset = this.resetResult ?? {
      id: `${(await runtime.info()).id}:reset:unrecorded`,
      runtime: await runtime.info(),
      observations: [],
      observationRefs: [],
    }
    const artifactRef = normalizeArtifactBundleTraceRef(this.artifacts)

    return {
      schema: RUNTIME_EPISODE_TRACE_SCHEMA,
      version: 1,
      id: `trace-${reset.runtime.id}`,
      createdAt: this.traceCreatedAt ??= new Date().toISOString(),
      runtime: await runtime.info(),
      reset,
      steps: [...this.steps],
      snapshots: [...this.snapshots],
      ...(this.artifacts ? { artifacts: this.artifacts } : {}),
      ...(artifactRef ? { artifactRef } : {}),
    }
  }

  async close(): Promise<void> {
    await this.runtime?.destroy()
    this.runtime = undefined
  }

  private assertRuntime(): Runtime {
    if (!this.runtime) {
      throw new Error("Runtime episode is closed")
    }

    return this.runtime
  }
}

async function createEpisodeRuntime(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<Runtime> {
  assertRuntimePolicy(spec.runtime.policy)

  if (backend.kind !== spec.runtime.backend) {
    throw new Error(`Backend ${backend.kind} cannot create runtime ${spec.runtime.backend}`)
  }

  return backend.create(spec.runtime)
}
