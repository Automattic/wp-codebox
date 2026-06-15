import { validateBlueprint } from "@wp-playground/blueprints"
import { buildReplayExportBlueprint } from "../packages/runtime-playground/src/replayable-wordpress-site-bundle.ts"
import type { RuntimeSnapshotArtifact } from "../packages/runtime-playground/src/runtime-snapshot.ts"

const snapshot: RuntimeSnapshotArtifact = {
  schema: "wp-codebox/wordpress-runtime-snapshot/v1",
  version: 1,
  id: "snapshot-smoke",
  createdAt: "2026-06-15T00:00:00.000Z",
  compatibility: {
    backend: "wordpress-playground",
    wordpressVersion: "latest",
    phpVersion: "8.3.31",
  },
  metadata: {
    runtime: {
      id: "runtime-smoke",
      backend: "wordpress-playground",
      status: "destroyed",
      createdAt: "2026-06-15T00:00:00.000Z",
      environment: {
        kind: "wordpress",
        name: "runtime-smoke",
        version: "latest",
      },
    },
    mounts: [],
    mountedInputs: [],
    activeTheme: "twentytwentyfour",
    activePlugins: [],
    wpContentPath: "/wordpress/wp-content",
  },
  database: { tables: [] },
  files: [
    {
      scope: "wp-content",
      path: "smoke.txt",
      bytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      base64: "aGVsbG8=",
    },
  ],
  hashes: {
    database: { algorithm: "sha256", value: "database-smoke" },
    files: { algorithm: "sha256", value: "files-smoke" },
  },
}

const blueprint = buildReplayExportBlueprint(snapshot)
const validation = validateBlueprint(blueprint)

if (!validation.valid) {
  throw new Error(`Replay export blueprint is not schema-valid: ${JSON.stringify(validation.errors, null, 2)}`)
}

const preferredVersions = blueprint.preferredVersions as Record<string, unknown> | undefined
if (preferredVersions?.php !== "8.3") {
  throw new Error(`Replay export blueprint must normalize patch-level PHP versions, got ${JSON.stringify(preferredVersions?.php)}`)
}

if ("x-wp-codebox" in blueprint) {
  throw new Error("Replay export blueprint must not include top-level x-wp-codebox metadata")
}

if (!Array.isArray(blueprint.steps) || blueprint.steps.length === 0) {
  throw new Error("Replay export blueprint must include restore steps")
}

const serialized = JSON.stringify(blueprint)
if (serialized.includes(snapshot.files[0].base64)) {
  throw new Error("Replay export blueprint must not inline runtime snapshot file payloads")
}

const [writeSnapshotStep, restoreStep] = blueprint.steps as Array<Record<string, unknown>>
if (writeSnapshotStep?.step !== "writeFile") {
  throw new Error("Replay export blueprint must first write the external runtime snapshot into Playground")
}

const writeSnapshotData = writeSnapshotStep.data as Record<string, unknown> | undefined
if (writeSnapshotData?.resource !== "bundled" || writeSnapshotData.path !== "files/runtime-snapshot.json") {
  throw new Error("Replay export blueprint must reference files/runtime-snapshot.json as a bundled external resource")
}

if (restoreStep?.step !== "runPHP" || typeof restoreStep.code !== "string" || !restoreStep.code.includes("file_get_contents")) {
  throw new Error("Replay export blueprint must restore by reading the written runtime snapshot file")
}

console.log("replay-export-blueprint-smoke passed")
