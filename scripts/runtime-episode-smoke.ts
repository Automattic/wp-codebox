import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Ajv from "ajv"
import {
  RUNTIME_EPISODE_TRACE_JSON_SCHEMA,
  RUNTIME_EPISODE_TRACE_SCHEMA,
  RUNTIME_EPISODE_ACTION_SCHEMA,
  RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
  RUNTIME_REFERENCE_MANIFEST_SCHEMA,
  RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA,
  runtimeReferenceManifestDigest,
  runtimeReplayReferenceIndexDigest,
  createRuntimeEpisode,
  validateRuntimeEpisodeTrace,
  verifyArtifactBundle,
} from "@automattic/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-episode-"))

try {
  const episode = await createRuntimeEpisode(
    {
      runtime: {
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "episode-smoke", version: "7.0", blueprint: { steps: [] } },
        policy: {
          network: "deny",
          filesystem: "readwrite-mounts",
          commands: ["wordpress.wp-cli", "wordpress.run-php"],
          secrets: "none",
          approvals: "never",
        },
        artifactsDirectory,
        metadata: {
          runtime: { version: "0.0.0" },
          task: { kind: "runtime-episode-smoke" },
        },
      },
      resetObservations: [{ type: "runtime-info" }],
      stepObservation: { type: "runtime-info" },
      artifactSpec: { includeLogs: true, includeObservations: true },
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    const createPost = await episode.step({
      command: "wordpress.wp-cli",
      args: ["command=post create --post_type=page --post_status=publish --post_title='Episode Smoke' --porcelain"],
    })
    assert.match(createPost.id, /^command-.+:step:0$/)
    assert.equal(createPost.index, 0)
    assert.equal(createPost.action.schema, RUNTIME_EPISODE_ACTION_SCHEMA)
    assert.equal(createPost.action.kind, "command")
    assert.deepEqual(createPost.action.args, ["command=post create --post_type=page --post_status=publish --post_title='Episode Smoke' --porcelain"])
    assert.match(createPost.action.id, /:action$/)
    assert.equal(createPost.actionRef.id, createPost.action.id)
    assert.equal(createPost.actionRef.kind, "action")
    assert.equal(createPost.actionRef.digest?.algorithm, "sha256")
    assert.equal(createPost.actionRef.digest?.value, createPost.action.digest.value)
    assert.equal(createPost.execution.exitCode, 0)
    assert.equal(createPost.executionRef.id, createPost.execution.id)
    assert.equal(createPost.executionRef.digest?.value.length, 64)
    assert.match(createPost.execution.stdout, /\d+/)
    assert.equal(createPost.observation?.schema, RUNTIME_EPISODE_OBSERVATION_SCHEMA)
    assert.equal(createPost.observation?.type, "runtime-info")
    assert.ok(createPost.observation?.id)
    assert.equal(createPost.observation?.digest?.algorithm, "sha256")
    assert.equal(createPost.observationRef?.id, createPost.observation?.id)
    assert.equal(createPost.observationRef?.digest?.value, createPost.observation?.digest?.value)

    const queryPost = await episode.step({
      command: "wordpress.run-php",
      args: ["code=$post = get_page_by_title('Episode Smoke'); echo $post ? $post->post_title : '';"],
    })
    assert.equal(queryPost.index, 1)
    assert.equal(queryPost.execution.stdout.trim(), "Episode Smoke")

    const semanticHttpAction = await episode.step({
      kind: "http",
      method: "GET",
      url: "/?p=1",
      command: "wordpress.run-php",
      args: ["code=echo get_bloginfo('name');"],
      metadata: { source: "runtime-episode-smoke" },
    }, { type: "wordpress-state" })
    assert.equal(semanticHttpAction.index, 2)
    assert.equal(semanticHttpAction.action.kind, "http")
    assert.equal(semanticHttpAction.action.command, "wordpress.run-php")
    assert.equal(semanticHttpAction.action.method, "GET")
    assert.equal(semanticHttpAction.action.url, "/?p=1")
    assert.equal(semanticHttpAction.actionRef.digest?.value, semanticHttpAction.action.digest.value)
    assert.equal(semanticHttpAction.executionRef.id, semanticHttpAction.execution.id)
    assert.equal(semanticHttpAction.observation?.type, "wordpress-state")
    assert.equal((semanticHttpAction.observation?.data as { schema?: string }).schema, "wp-codebox/wordpress-state-export/v1")
    assert.equal(typeof (((semanticHttpAction.observation?.data as { sections?: { summary?: { wordpressVersion?: unknown } } }).sections?.summary?.wordpressVersion)), "string")
    assert.equal(semanticHttpAction.observation?.artifactRefs?.[0].kind, "wordpress-state-section")
    assert.equal(semanticHttpAction.observationRef?.digest?.value, semanticHttpAction.observation?.digest?.value)

    const fullStateObservation = await episode.observe({
      type: "wordpress-state",
      sections: ["summary", "posts", "terms", "menus", "templates", "media", "options", "users", "rest-routes", "abilities"],
      optionNames: ["blogname"],
      userFields: ["user_login", "roles"],
    })
    const fullStateData = fullStateObservation.data as {
      config?: { sections?: string[] }
      sections?: { posts?: { count?: number }; users?: { count?: number }; options?: { keys?: string[] } }
      artifacts?: Record<string, { artifact?: string; sha256?: string; bytes?: number }>
    }
    assert.deepEqual(fullStateData.config?.sections, ["summary", "posts", "terms", "menus", "templates", "media", "options", "users", "rest-routes", "abilities"])
    assert.ok((fullStateData.sections?.posts?.count ?? 0) >= 2)
    assert.equal(fullStateData.sections?.users?.count, 1)
    assert.deepEqual(fullStateData.sections?.options?.keys, ["blogname"])
    assert.match(fullStateData.artifacts?.posts?.sha256 ?? "", /^[a-f0-9]{64}$/)
    assert.equal(fullStateObservation.artifactRefs?.some((ref) => ref.kind === "wordpress-state-section" && ref.path?.endsWith("wordpress-state-users.json")), true)

    const usersArtifactRef = fullStateObservation.artifactRefs?.find((ref) => ref.path?.endsWith("wordpress-state-users.json"))
    assert.ok(usersArtifactRef?.path, "users state export should be artifact-backed")
    const usersArtifactPath = usersArtifactRef.path

    const templateHashesObservation = await episode.observe({ type: "wordpress-state", sections: ["templates"] })
    const templateHashesArtifactRef = templateHashesObservation.artifactRefs?.find((ref) => ref.path?.endsWith("wordpress-state-templates.json"))
    assert.ok(templateHashesArtifactRef?.path, "template state export should be artifact-backed")
    const templateHashesArtifactPath = templateHashesArtifactRef.path

    const templateContentObservation = await episode.observe({ type: "wordpress-state", sections: ["templates"], includeContent: true })
    const templateContentArtifactRef = templateContentObservation.artifactRefs?.find((ref) => ref.path?.endsWith("wordpress-state-templates.json"))
    assert.ok(templateContentArtifactRef?.path, "template content state export should be artifact-backed")
    const templateContentArtifactPath = templateContentArtifactRef.path

    const httpObservation = await episode.observe({ type: "http-response", url: "/" })
    assert.equal(httpObservation.type, "http-response")
    assert.equal(httpObservation.digest?.algorithm, "sha256")
    assert.equal((httpObservation.data as { status?: number }).status, 200)
    assert.match((httpObservation.data as { bodySha256?: string }).bodySha256 ?? "", /^[a-f0-9]{64}$/)
    assert.equal(httpObservation.artifactRefs?.[0].kind, "observation-artifact")
    assert.match(httpObservation.artifactRefs?.[0].path ?? "", /^files\/observations\/observation-.+-body\.txt$/)
    assert.equal(httpObservation.artifactRefs?.[0].digest?.value, (httpObservation.data as { bodySha256?: string }).bodySha256)

    const snapshot = await episode.snapshot()
    assert.match(snapshot.id, /^snapshot-/)
    assert.equal(snapshot.schema, RUNTIME_EPISODE_SNAPSHOT_SCHEMA)
    assert.equal(snapshot.semantics, "runtime-state-artifact")
    assert.equal(snapshot.digest?.algorithm, "sha256")
    assert.equal(snapshot.digest?.value.length, 64)

    const artifacts = await episode.collectArtifacts({ includeLogs: true, includeObservations: true, includeRuntimeSnapshotBundles: true })
    const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8"))
    assert.equal(metadata.provenance.task.kind, "runtime-episode-smoke")
    assert.ok(artifacts.runtimeEpisodeTracePath, "artifact bundle should expose runtimeEpisodeTracePath")
    assert.ok(artifacts.runtimeEpisodeEventsPath, "artifact bundle should expose runtimeEpisodeEventsPath")
    assert.ok(artifacts.runtimeReplayReferenceIndexPath, "artifact bundle should expose runtimeReplayReferenceIndexPath")
    assert.equal(metadata.artifacts.runtimeEpisodeTrace, "files/runtime-episode-trace.json")
    assert.equal(metadata.artifacts.runtimeEpisodeEvents, "files/runtime-episode.jsonl")
    assert.equal(metadata.artifacts.runtimeReplayReferenceIndex, "files/runtime-replay-index.json")

    const templateHashesArtifact = JSON.parse(await readFile(join(artifacts.directory, templateHashesArtifactPath), "utf8")) as {
      data?: {
        templates?: Array<Record<string, unknown>>
        templateParts?: Array<Record<string, unknown>>
        globalStyles?: Record<string, unknown> | null
      }
    }
    assert.equal(Object.hasOwn(templateHashesArtifact.data?.globalStyles ?? {}, "stylesheetHash"), true)
    assert.equal(Object.hasOwn(templateHashesArtifact.data?.globalStyles ?? {}, "stylesheet"), false)
    assert.equal(templateHashesArtifact.data?.templates?.some((template) => Object.hasOwn(template, "content")), false)
    assert.equal(templateHashesArtifact.data?.templateParts?.some((templatePart) => Object.hasOwn(templatePart, "content")), false)

    const templateContentArtifact = JSON.parse(await readFile(join(artifacts.directory, templateContentArtifactPath), "utf8")) as {
      data?: {
        templates?: Array<Record<string, unknown>>
        templateParts?: Array<Record<string, unknown>>
        globalStyles?: Record<string, unknown> | null
      }
    }
    assert.equal(typeof templateContentArtifact.data?.globalStyles?.stylesheetHash, "string")
    assert.equal(typeof templateContentArtifact.data?.globalStyles?.stylesheet, "string")
    if ((templateContentArtifact.data?.templates?.length ?? 0) > 0) {
      assert.equal(typeof templateContentArtifact.data?.templates?.[0]?.content, "string")
    }
    if ((templateContentArtifact.data?.templateParts?.length ?? 0) > 0) {
      assert.equal(typeof templateContentArtifact.data?.templateParts?.[0]?.content, "string")
    }

    const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
    assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-episode-trace.json" && file.kind === "runtime-episode-trace"))
    assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-episode.jsonl" && file.kind === "runtime-episode-events"))
    assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === httpObservation.artifactRefs?.[0].path && file.kind === "observation-artifact"))
    assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === usersArtifactPath && file.kind === "wordpress-state-section"))
    assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-reference-manifest.json" && file.kind === "runtime-reference-manifest"))
    assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-replay-index.json" && file.kind === "runtime-replay-index"))
    const blueprintAfterManifestFile = manifest.files.find((file: { path: string; sha256: { value: string }; viewer?: any }) => file.path === "blueprint.after.json")
    assert.equal(blueprintAfterManifestFile?.viewer?.kind, "wordpress-playground-blueprint")
    assert.equal(blueprintAfterManifestFile?.viewer?.query?.parameter, "blueprint-url")
    assert.equal(blueprintAfterManifestFile?.viewer?.replay?.status, "partial")
    const snapshotBundleEntry = manifest.files.find((file: { path: string; kind: string }) => file.path.startsWith("files/runtime-snapshots/") && file.kind === "runtime-snapshot-bundle")
    assert.ok(snapshotBundleEntry, "runtime snapshot bundle should be listed in manifest")

    const usersArtifact = JSON.parse(await readFile(join(artifacts.directory, usersArtifactPath), "utf8")) as { schema?: string; version?: number; section?: string; data?: Array<Record<string, unknown>> }
    assert.equal(usersArtifact.schema, "wp-codebox/wordpress-state-section/v1")
    assert.equal(usersArtifact.version, 1)
    assert.equal(usersArtifact.section, "users")
    assert.equal(usersArtifact.data?.[0]?.redacted, true)
    assert.equal(Object.hasOwn(usersArtifact.data?.[0] ?? {}, "user_login"), false)
    assert.deepEqual(usersArtifact.data?.[0]?.roles, ["administrator"])

    const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8"))
    assert.equal(review.evidence.runtimeEpisodeTrace, "files/runtime-episode-trace.json")
    assert.equal(review.evidence.runtimeReferenceManifest, "files/runtime-reference-manifest.json")
    assert.equal(review.evidence.runtimeReplayReferenceIndex, "files/runtime-replay-index.json")
    assert.ok(review.progress.some((event: { component?: string; label?: string }) => event.component === "runtime-episode" && event.label === "Runtime episode trace persisted"))

    const referenceManifest = JSON.parse(await readFile(artifacts.runtimeReferenceManifestPath ?? "", "utf8"))
    const replayIndex = JSON.parse(await readFile(artifacts.runtimeReplayReferenceIndexPath ?? "", "utf8"))
    assert.equal(replayIndex.schema, RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA)
    assert.equal(replayIndex.artifactBundle.id, artifacts.id)
    assert.equal(replayIndex.references.trace.path, "files/runtime-episode-trace.json")
    assert.equal(replayIndex.references.events.path, "files/runtime-episode.jsonl")
    assert.equal(replayIndex.references.runtimeReferenceManifest.path, "files/runtime-reference-manifest.json")
    assert.equal(replayIndex.references.blueprintAfter.viewer.kind, "wordpress-playground-blueprint")
    assert.equal(replayIndex.references.blueprintAfter.viewer.query.value.source, "public-artifact-url")
    assert.equal(replayIndex.references.blueprintAfter.viewer.query.value.path, "blueprint.after.json")
    if (replayIndex.references.blueprintAfter.viewer.query.value.kind) {
      assert.equal(replayIndex.references.blueprintAfter.viewer.query.value.kind, "blueprint-after")
      assert.equal(replayIndex.references.blueprintAfter.viewer.query.value.sha256.value, blueprintAfterManifestFile?.sha256.value)
    }
    assert.equal(replayIndex.references.observations.path, "observations.jsonl")
    assert.equal(replayIndex.actions.length, 3)
    assert.equal(replayIndex.observations.some((observation: { type: string }) => observation.type === "runtime-info"), true)
    assert.equal(replayIndex.snapshots.length, 1)
    assert.equal(replayIndex.snapshots[0].id, snapshot.id)
    assert.equal(replayIndex.snapshots[0].replay.status, "runtime-state-artifact")
    assert.ok(replayIndex.replay.instructions.some((instruction: string) => instruction.includes("references.runtimeReferenceManifest")))
    assert.equal(replayIndex.replay.limitations.length, 0)
    assert.equal(replayIndex.digest.value, runtimeReplayReferenceIndexDigest(replayIndex).value)
    assert.equal(replayIndex.id, `runtime-replay-reference-index-sha256-${replayIndex.digest.value}`)
    assert.equal(referenceManifest.schema, RUNTIME_REFERENCE_MANIFEST_SCHEMA)
    assert.equal(referenceManifest.artifactBundle.id, artifacts.id)
    assert.equal(referenceManifest.artifactBundle.digest.value, artifacts.contentDigest)
    assert.equal(referenceManifest.trace.path, "files/runtime-episode-trace.json")
    assert.equal(referenceManifest.events.path, "files/runtime-episode.jsonl")
    assert.deepEqual(referenceManifest.files.find((file: { path: string }) => file.path === "blueprint.after.json")?.viewer, blueprintAfterManifestFile?.viewer)
    assert.equal(referenceManifest.snapshots.length, 1)
    assert.equal(referenceManifest.snapshots[0].id, snapshot.id)
    assert.equal(referenceManifest.snapshots[0].semantics, "runtime-state-artifact")
    assert.equal(referenceManifest.snapshots[0].replay.status, "runtime-state-artifact")
    assert.equal(referenceManifest.snapshots[0].replay.limitations.length, 0)
    assert.ok(referenceManifest.snapshots[0].artifactRefs.some((ref: { path: string }) => ref.path === snapshotBundleEntry.path))
    assert.equal(referenceManifest.digest.value, runtimeReferenceManifestDigest(referenceManifest).value)
    assert.equal(referenceManifest.id, `runtime-reference-manifest-sha256-${referenceManifest.digest.value}`)
    const snapshotBundle = JSON.parse(await readFile(join(artifacts.directory, snapshotBundleEntry.path), "utf8"))
    assert.equal(snapshotBundle.schema, "wp-codebox/runtime-snapshot-bundle/v1")
    assert.equal(snapshotBundle.snapshot.id, snapshot.id)
    assert.equal(snapshotBundle.snapshot.originalSemantics, "runtime-state-artifact")
    assert.equal(snapshotBundle.replay.status, "runtime-state-artifact")
    assert.ok(snapshotBundle.refs.some((ref: { path: string }) => ref.path === "blueprint.after.json"))

    const trace = await episode.trace()
    const persistedTrace = JSON.parse(await readFile(artifacts.runtimeEpisodeTracePath, "utf8"))
    assert.deepEqual(persistedTrace, trace)
    const persistedEvents = (await readFile(artifacts.runtimeEpisodeEventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(persistedEvents.some((event: { type: string }) => event.type === "episode.step"), true)
    assert.equal(persistedEvents.some((event: { type: string }) => event.type === "episode.artifacts"), true)

    assert.equal(RUNTIME_EPISODE_TRACE_JSON_SCHEMA.$id, RUNTIME_EPISODE_TRACE_SCHEMA)
    const validateJsonSchema = new Ajv({ strict: false }).compile(RUNTIME_EPISODE_TRACE_JSON_SCHEMA)
    assert.equal(validateJsonSchema(trace), true, JSON.stringify(validateJsonSchema.errors, null, 2))
    assert.equal(trace.schema, RUNTIME_EPISODE_TRACE_SCHEMA)
    assert.equal(trace.version, 1)
    assert.match(trace.id, /^trace-runtime-/)
    assert.equal(trace.steps.length, 3)
    assert.equal(trace.snapshots.length, 1)
    assert.equal(trace.snapshots[0].schema, RUNTIME_EPISODE_SNAPSHOT_SCHEMA)
    assert.equal(trace.snapshots[0].semantics, "runtime-state-artifact")
    assert.ok(trace.snapshots[0].artifactRefs?.some((ref) => ref.path === snapshotBundleEntry.path))
    assert.notEqual(trace.snapshots[0].digest?.value, snapshot.digest?.value)
    assert.equal(trace.reset.observations.length, 1)
    assert.equal(trace.reset.observationRefs.length, 1)
    assert.equal(trace.artifacts?.id, artifacts.id)
    assert.equal(trace.artifactRef?.id, artifacts.id)
    assert.equal(trace.artifactRef?.digest?.value, artifacts.contentDigest)
    const validation = validateRuntimeEpisodeTrace(trace)
    assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2))
    const artifactVerification = await verifyArtifactBundle(artifacts.directory)
    assert.equal(artifactVerification.valid, true, JSON.stringify(artifactVerification.violations, null, 2))
    assert.equal(
      validateRuntimeEpisodeTrace({ ...trace, reward: 1 }).valid,
      false,
      "trace validator must reject eval-specific fields",
    )

    const evalSemanticAction = structuredClone(trace)
    ;(evalSemanticAction.steps[2].action as unknown as { grader: string }).grader = "not-generic"
    assert.equal(
      validateRuntimeEpisodeTrace(evalSemanticAction).valid,
      false,
      "trace validator must reject eval-specific fields inside semantic action envelopes",
    )

    const malformedActionKind = structuredClone(trace)
    ;(malformedActionKind.steps[2].action as unknown as { kind: string }).kind = "grader"
    assert.equal(
      validateRuntimeEpisodeTrace(malformedActionKind).valid,
      false,
      "trace validator must reject non-generic action kinds",
    )

    const missingActionSchema = structuredClone(trace)
    delete (missingActionSchema.steps[0].action as Partial<typeof missingActionSchema.steps[0]["action"]>).schema
    assert.equal(
      validateRuntimeEpisodeTrace(missingActionSchema).valid,
      false,
      "trace validator must reject action envelopes without a schema",
    )

    const malformedActionArgs = structuredClone(trace)
    ;(malformedActionArgs.steps[0].action as unknown as { args: unknown }).args = "command=post list"
    assert.equal(
      validateRuntimeEpisodeTrace(malformedActionArgs).valid,
      false,
      "trace validator must reject action envelopes with non-array args",
    )

    const mismatchedActionRefDigest = structuredClone(trace)
    mismatchedActionRefDigest.steps[0].actionRef.digest = { algorithm: "sha256", value: "0".repeat(64) }
    assert.equal(
      validateRuntimeEpisodeTrace(mismatchedActionRefDigest).valid,
      false,
      "trace validator must reject action refs whose digest does not match the action envelope",
    )

    const missingObservationDigest = structuredClone(trace)
    delete missingObservationDigest.steps[0].observation?.digest
    assert.equal(
      validateRuntimeEpisodeTrace(missingObservationDigest).valid,
      false,
      "trace validator must reject observation envelopes without digests",
    )

    const malformedResetObservation = structuredClone(trace)
    ;(malformedResetObservation.reset.observations[0] as unknown as { observedAt: unknown }).observedAt = null
    assert.equal(
      validateRuntimeEpisodeTrace(malformedResetObservation).valid,
      false,
      "trace validator must reject malformed reset observation envelopes",
    )

    const tamperedSnapshotMetadata = structuredClone(trace)
    tamperedSnapshotMetadata.snapshots[0].metadata = { tampered: true }
    assert.equal(
      validateRuntimeEpisodeTrace(tamperedSnapshotMetadata).valid,
      false,
      "trace validator must reject snapshots whose digest no longer matches metadata",
    )

    const missingSnapshotDigest = structuredClone(trace)
    delete missingSnapshotDigest.snapshots[0].digest
    assert.equal(
      validateRuntimeEpisodeTrace(missingSnapshotDigest).valid,
      false,
      "trace validator must reject snapshots without digests",
    )

    const invalidSnapshotArtifactRef = structuredClone(trace)
    invalidSnapshotArtifactRef.snapshots[0].artifactRefs = [{ kind: "runtime-state-artifact", id: "state-1" }]
    assert.equal(
      validateRuntimeEpisodeTrace(invalidSnapshotArtifactRef).valid,
      false,
      "trace validator must reject snapshot artifact refs without digests",
    )
  } finally {
    await episode.close()
  }

  console.log("Runtime episode smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
