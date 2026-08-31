import { createHash } from "node:crypto";
import { RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH, RUNTIME_EPISODE_TRACE_ARTIFACT_PATH, RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH, normalizeObservationArtifactRefs, normalizeRuntimeReferenceManifestFileRef, } from "./artifact-references.js";
import { stableJson } from "./object-utils.js";
export const RUNTIME_REFERENCE_MANIFEST_SCHEMA = "wp-codebox/runtime-reference-manifest/v1";
export const RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA = "wp-codebox/runtime-replay-reference-index/v1";
export function buildRuntimeReferenceManifest(input) {
    const manifest = {
        schema: RUNTIME_REFERENCE_MANIFEST_SCHEMA,
        version: 1,
        id: "runtime-reference-manifest-pending",
        createdAt: input.createdAt,
        digest: { algorithm: "sha256", value: "0".repeat(64) },
        runtime: input.runtime,
        artifactBundle: input.artifactBundle,
        files: input.files.map(runtimeReferenceManifestFileRef).sort((left, right) => left.path.localeCompare(right.path)),
        ...(input.trace ? { trace: runtimeReferenceManifestFileRef(input.trace) } : {}),
        ...(input.events ? { events: runtimeReferenceManifestFileRef(input.events) } : {}),
        snapshots: (input.snapshots ?? []).map(runtimeReferenceManifestSnapshotRef),
    };
    const digest = runtimeReferenceManifestDigest(manifest);
    return {
        ...manifest,
        id: `runtime-reference-manifest-sha256-${digest.value}`,
        digest,
    };
}
export function runtimeReferenceManifestDigest(manifest) {
    return {
        algorithm: "sha256",
        value: createHash("sha256")
            .update("wp-codebox/runtime-reference-manifest/v1\n")
            .update(stableJson(runtimeReferenceManifestDigestPayload(manifest)))
            .digest("hex"),
    };
}
export function buildRuntimeReplayReferenceIndex(input) {
    const filesByPath = new Map(input.files.map((file) => [file.path, runtimeReferenceManifestFileRef(file)]));
    const references = compactUndefined({
        trace: input.trace ? runtimeReferenceManifestFileRef(input.trace) : filesByPath.get(RUNTIME_EPISODE_TRACE_ARTIFACT_PATH),
        events: input.events ? runtimeReferenceManifestFileRef(input.events) : filesByPath.get(RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH),
        runtimeReferenceManifest: input.runtimeReferenceManifest ? runtimeReferenceManifestFileRef(input.runtimeReferenceManifest) : filesByPath.get(RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH),
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
    });
    const snapshots = (input.snapshots ?? []).map(runtimeReferenceManifestSnapshotRef);
    const index = {
        schema: RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA,
        version: 1,
        id: "runtime-replay-reference-index-pending",
        createdAt: input.createdAt,
        digest: { algorithm: "sha256", value: "0".repeat(64) },
        runtime: input.runtime,
        artifactBundle: input.artifactBundle,
        references,
        actions: runtimeReplayActionRefs(input.episodeTrace),
        observations: runtimeReplayObservationRefs(input.episodeTrace),
        snapshots,
        replay: runtimeReplayInstructions(references, snapshots),
    };
    const digest = runtimeReplayReferenceIndexDigest(index);
    return {
        ...index,
        id: `runtime-replay-reference-index-sha256-${digest.value}`,
        digest,
    };
}
export function runtimeReplayReferenceIndexDigest(index) {
    return {
        algorithm: "sha256",
        value: createHash("sha256")
            .update("wp-codebox/runtime-replay-reference-index/v1\n")
            .update(stableJson(runtimeReplayReferenceIndexDigestPayload(index)))
            .digest("hex"),
    };
}
function runtimeReplayReferenceIndexDigestPayload(index) {
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
    };
}
function runtimeReplayActionRefs(trace) {
    return (trace?.steps ?? []).map((step) => compactUndefined({
        index: step.index,
        id: step.id,
        actionRef: step.actionRef,
        executionRef: step.executionRef,
        observationRef: step.observationRef,
    }));
}
function runtimeReplayObservationRefs(trace) {
    const observations = [
        ...(trace?.reset.observations ?? []),
        ...(trace?.steps.flatMap((step) => step.observation ? [step.observation] : []) ?? []),
    ];
    return observations.map((observation, index) => ({
        id: observation.id ?? `observation:${index}`,
        type: observation.type,
        ref: observationRef(observation, observation.id ?? `observation:${index}`),
        artifactRefs: normalizeObservationArtifactRefs(observation),
    }));
}
function runtimeReplayInstructions(references, snapshots) {
    const limitations = [...new Set(snapshots.flatMap((snapshot) => snapshot.replay.limitations))];
    if (snapshots.some((snapshot) => snapshot.replay.status === "runtime-state-artifact")) {
        return {
            status: "runtime-state-artifact",
            instructions: [
                "Use references.runtimeReferenceManifest for hashed runtime files and snapshot artifact refs.",
                "Use references.trace and references.events to replay recorded actions and lifecycle events.",
            ],
            limitations,
        };
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
    };
}
function runtimeReferenceManifestDigestPayload(manifest) {
    return {
        schema: manifest.schema,
        version: manifest.version,
        runtime: manifest.runtime,
        artifactBundle: manifest.artifactBundle,
        files: manifest.files,
        ...(manifest.trace ? { trace: manifest.trace } : {}),
        ...(manifest.events ? { events: manifest.events } : {}),
        snapshots: manifest.snapshots,
    };
}
function runtimeReferenceManifestFileRef(file) {
    return normalizeRuntimeReferenceManifestFileRef(file) ?? file;
}
function runtimeReferenceManifestSnapshotRef(snapshot) {
    const semantics = snapshot.semantics ?? "metadata-only";
    return {
        id: snapshot.id,
        semantics,
        digest: snapshot.digest ?? runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload({ ...snapshot, semantics })),
        replay: runtimeSnapshotReplaySemantics(semantics),
        artifactRefs: normalizeObservationArtifactRefs(snapshot),
    };
}
function runtimeSnapshotReplaySemantics(semantics) {
    if (semantics === "replayable-runtime-state") {
        return { status: "replayable-runtime-state", limitations: [] };
    }
    if (semantics === "runtime-state-artifact") {
        return { status: "runtime-state-artifact", limitations: [] };
    }
    if (semantics === "partial-replay") {
        return {
            status: "partial-replay",
            limitations: [
                "Snapshot bundle contains replay instructions and artifact references, but not a complete WordPress database checkpoint.",
                "Replay consumers can restore mounted files and inspect runtime evidence; posts, options, terms, users, uploads, active theme/plugins, and browser/editor state may require external capture.",
            ],
        };
    }
    if (semantics === "metadata-only") {
        return {
            status: "metadata-only",
            limitations: [
                "Snapshot records runtime metadata only; it is not a WordPress database or filesystem checkpoint.",
                "Replay consumers must use trace actions and artifact bundle files to reconstruct supported state.",
            ],
        };
    }
    return {
        status: "not-replayable",
        limitations: [`Snapshot semantics are not recognized by this WP Codebox version: ${semantics}`],
    };
}
function observationRef(observation, fallbackId) {
    return { kind: "observation", id: observation.id || fallbackId, digest: observation.digest ?? runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation)) };
}
function runtimeEpisodeDigest(value) {
    return {
        algorithm: "sha256",
        value: createHash("sha256").update("wp-codebox/runtime-episode-trace/v1\n").update(stableJson(value)).digest("hex"),
    };
}
function runtimeEpisodeObservationDigestPayload(observation) {
    return {
        schema: "wp-codebox/runtime-episode-observation/v1",
        type: observation.type,
        data: observation.data,
        observedAt: observation.observedAt,
        artifactRefs: observation.artifactRefs ?? [],
    };
}
function runtimeEpisodeSnapshotDigestPayload(snapshot) {
    return {
        schema: "wp-codebox/runtime-episode-snapshot/v1",
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        semantics: snapshot.semantics,
        metadata: snapshot.metadata,
        artifactRefs: snapshot.artifactRefs ?? [],
    };
}
function compactUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
//# sourceMappingURL=runtime-reference.js.map