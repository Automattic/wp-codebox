import { mkdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  artifactManifestFile,
  calculateArtifactContentDigest,
  refreshArtifactManifestFileSha256s,
  type ArtifactManifest,
  type RuntimeInfo,
} from "@automattic/wp-codebox-core"
import { runtimeSnapshotRestorePhp, runtimeSnapshotRestorePhpFromFile, type RuntimeSnapshotArtifact } from "./runtime-snapshot.js"

export interface ReplayableWordPressSiteBundleOptions {
  directory: string
  id?: string
  createdAt?: string
  source?: Record<string, unknown>
  landingPage?: string
}

export interface ReplayableWordPressSiteBundleManifest extends ArtifactManifest {
  schema: "wp-codebox/replayable-wordpress-site/v1"
  version: 1
  replayableWordPressSite: {
    blueprintPath: string
    snapshotPath: string
    limitationsPath: string
    replayStatus: "replayable-runtime-state"
    source?: Record<string, unknown>
  }
}

export interface ReplayableWordPressSiteBundle {
  id: string
  directory: string
  manifestPath: string
  blueprintPath: string
  snapshotPath: string
  limitationsPath: string
  contentDigest: string
  createdAt: string
  manifest: ReplayableWordPressSiteBundleManifest
}

export interface ReplayExportPackageOptions extends ReplayableWordPressSiteBundleOptions {
  importMs?: number
  materializeMs?: number
  snapshotMs?: number
  exportMs?: number
}

export interface ReplayExportPackage {
  status: "passed"
  directory: string
  metrics: {
    importMs: number
    materializeMs: number
    snapshotMs: number
    exportMs: number
    databaseTables: number
    wpContentFiles: number
    snapshotBytes: number
    blueprintBytes: number
  }
  artifacts: {
    manifest: "manifest.json"
    blueprint: "blueprint.after.json"
    snapshot: "files/runtime-snapshot.json"
    notes: "blueprint.after-notes.json"
  }
  manifest: ReplayableWordPressSiteBundleManifest
}

export async function writeReplayExportPackage(snapshot: RuntimeSnapshotArtifact, options: ReplayExportPackageOptions): Promise<ReplayExportPackage> {
  const createdAt = options.createdAt ?? new Date().toISOString()
  const directory = options.directory
  const filesDirectory = join(directory, "files")
  await mkdir(filesDirectory, { recursive: true })

  const snapshotPath = join(filesDirectory, "runtime-snapshot.json")
  const blueprintPath = join(directory, "blueprint.after.json")
  const notesPath = join(directory, "blueprint.after-notes.json")
  const manifestPath = join(directory, "manifest.json")
  const blueprint = buildReplayExportBlueprint(snapshot, options)
  const notes = buildReplayableWordPressSiteLimitations(snapshot, {
    source: {
      kind: "wordpress.export-replay-package",
      snapshotPath: "files/runtime-snapshot.json",
      mode: "external-runtime-snapshot",
      ...(options.source ?? {}),
    },
  })

  await writeJson(blueprintPath, blueprint)
  await writeJson(snapshotPath, snapshot)
  await writeJson(notesPath, notes)

  const contentInputs = ["blueprint.after.json", "files/runtime-snapshot.json", "blueprint.after-notes.json"]
  const contentDigest = await calculateArtifactContentDigest(directory, contentInputs)
  const id = options.id ?? `replay-export-package-sha256-${contentDigest}`
  const manifest: ReplayableWordPressSiteBundleManifest = {
    schema: "wp-codebox/replayable-wordpress-site/v1",
    version: 1,
    id,
    contentDigest: {
      algorithm: "sha256",
      inputs: contentInputs,
      value: contentDigest,
    },
    createdAt,
    runtime: runtimeInfoForReplayableWordPressSite(snapshot, id, createdAt, blueprint),
    files: [
      artifactManifestFile("manifest.json", "manifest", "application/json"),
      artifactManifestFile("blueprint.after.json", "blueprint-after", "application/json"),
      artifactManifestFile("files/runtime-snapshot.json", "runtime-snapshot", "application/json"),
      artifactManifestFile("blueprint.after-notes.json", "blueprint-after-notes", "application/json"),
    ],
    replayableWordPressSite: {
      blueprintPath: "blueprint.after.json",
      snapshotPath: "files/runtime-snapshot.json",
      limitationsPath: "blueprint.after-notes.json",
      replayStatus: "replayable-runtime-state",
      source: {
        kind: "wordpress.export-replay-package",
        snapshotPath: "files/runtime-snapshot.json",
        mode: "external-runtime-snapshot",
        ...(options.source ?? {}),
      },
    },
  }

  await refreshArtifactManifestFileSha256s(directory, manifest)
  await writeJson(manifestPath, manifest)
  await refreshArtifactManifestFileSha256s(directory, manifest)
  await writeJson(manifestPath, manifest)

  const [snapshotStats, blueprintStats] = await Promise.all([stat(snapshotPath), stat(blueprintPath)])
  return {
    status: "passed",
    directory,
    metrics: {
      importMs: options.importMs ?? 0,
      materializeMs: options.materializeMs ?? 0,
      snapshotMs: options.snapshotMs ?? 0,
      exportMs: options.exportMs ?? 0,
      databaseTables: snapshot.database.tables.length,
      wpContentFiles: snapshot.files.length,
      snapshotBytes: snapshotStats.size,
      blueprintBytes: blueprintStats.size,
    },
    artifacts: {
      manifest: "manifest.json",
      blueprint: "blueprint.after.json",
      snapshot: "files/runtime-snapshot.json",
      notes: "blueprint.after-notes.json",
    },
    manifest,
  }
}

export async function writeReplayableWordPressSiteBundle(
  snapshot: RuntimeSnapshotArtifact,
  options: ReplayableWordPressSiteBundleOptions,
): Promise<ReplayableWordPressSiteBundle> {
  const createdAt = options.createdAt ?? new Date().toISOString()
  const directory = options.directory
  const filesDirectory = join(directory, "files")
  await mkdir(filesDirectory, { recursive: true })

  const blueprint = buildReplayableWordPressSiteBlueprint(snapshot, options)
  const limitations = buildReplayableWordPressSiteLimitations(snapshot, options)

  await writeJson(join(directory, "blueprint.json"), blueprint)
  await writeJson(join(filesDirectory, "runtime-snapshot.json"), snapshot)
  await writeJson(join(filesDirectory, "replay-limitations.json"), limitations)

  const contentInputs = ["blueprint.json", "files/runtime-snapshot.json", "files/replay-limitations.json"]
  const contentDigest = await calculateArtifactContentDigest(directory, contentInputs)
  const id = options.id ?? `replayable-wordpress-site-sha256-${contentDigest}`
  const manifest: ReplayableWordPressSiteBundleManifest = {
    schema: "wp-codebox/replayable-wordpress-site/v1",
    version: 1,
    id,
    contentDigest: {
      algorithm: "sha256",
      inputs: contentInputs,
      value: contentDigest,
    },
    createdAt,
    runtime: runtimeInfoForReplayableWordPressSite(snapshot, id, createdAt, blueprint),
    files: [
      artifactManifestFile("manifest.json", "manifest", "application/json"),
      artifactManifestFile("blueprint.json", "playground-blueprint", "application/json"),
      artifactManifestFile("files/runtime-snapshot.json", "runtime-snapshot", "application/json"),
      artifactManifestFile("files/replay-limitations.json", "replay-limitations", "application/json"),
    ],
    replayableWordPressSite: {
      blueprintPath: "blueprint.json",
      snapshotPath: "files/runtime-snapshot.json",
      limitationsPath: "files/replay-limitations.json",
      replayStatus: "replayable-runtime-state",
      ...(options.source ? { source: options.source } : {}),
    },
  }

  await refreshArtifactManifestFileSha256s(directory, manifest)
  await writeJson(join(directory, "manifest.json"), manifest)
  await refreshArtifactManifestFileSha256s(directory, manifest)
  await writeJson(join(directory, "manifest.json"), manifest)

  return {
    id,
    directory,
    manifestPath: join(directory, "manifest.json"),
    blueprintPath: join(directory, "blueprint.json"),
    snapshotPath: join(filesDirectory, "runtime-snapshot.json"),
    limitationsPath: join(filesDirectory, "replay-limitations.json"),
    contentDigest,
    createdAt,
    manifest,
  }
}

export function buildReplayableWordPressSiteBlueprint(
  snapshot: RuntimeSnapshotArtifact,
  options: Pick<ReplayableWordPressSiteBundleOptions, "landingPage"> = {},
): Record<string, unknown> {
  return {
    $schema: "https://playground.wordpress.net/blueprint-schema.json",
    preferredVersions: {
      wp: snapshot.compatibility.wordpressVersion,
      php: snapshot.compatibility.phpVersion,
    },
    landingPage: options.landingPage ?? "/",
    steps: [
      {
        step: "runPHP",
        code: runtimeSnapshotRestorePhp(snapshot),
      },
    ],
  }
}

export function buildReplayExportBlueprint(
  snapshot: RuntimeSnapshotArtifact,
  options: Pick<ReplayableWordPressSiteBundleOptions, "landingPage"> = {},
): Record<string, unknown> {
  const snapshotPath = "/tmp/wp-codebox-runtime-snapshot.json"
  return {
    $schema: "https://playground.wordpress.net/blueprint-schema.json",
    preferredVersions: {
      wp: snapshot.compatibility.wordpressVersion,
      php: snapshot.compatibility.phpVersion,
    },
    landingPage: options.landingPage ?? "/",
    steps: [
      {
        step: "writeFile",
        path: snapshotPath,
        data: {
          resource: "bundled",
          path: "files/runtime-snapshot.json",
        },
      },
      {
        step: "runPHP",
        code: runtimeSnapshotRestorePhpFromFile(snapshotPath),
      },
    ],
  }
}

export function buildReplayableWordPressSiteLimitations(
  snapshot: RuntimeSnapshotArtifact,
  options: Pick<ReplayableWordPressSiteBundleOptions, "source"> = {},
): Record<string, unknown> {
  return {
    schema: "wp-codebox/replayable-wordpress-site-limitations/v1",
    replayStatus: "replayable-runtime-state",
    captured: {
      databaseTables: snapshot.database.tables.length,
      wpContentFiles: snapshot.files.length,
      activeTheme: snapshot.metadata.activeTheme,
      activePlugins: snapshot.metadata.activePlugins,
    },
    source: options.source ?? { kind: "unspecified" },
    restore: {
      schema: "wp-codebox/replay-export-blueprint/v1",
      replayStatus: "external-runtime-snapshot",
      snapshotPath: "files/runtime-snapshot.json",
      restoreSteps: ["writeFile", "runPHP"],
      note: "The runtime snapshot is stored beside the blueprint instead of embedded as one large runPHP string.",
    },
    limitations: [
      "The bundle replays captured database tables and wp-content files only.",
      "The exporter input must be policy-approved by the caller; this builder does not acquire or authorize private site sources.",
      "Browser/editor session state and external services are not captured.",
    ],
  }
}

function runtimeInfoForReplayableWordPressSite(
  snapshot: RuntimeSnapshotArtifact,
  id: string,
  createdAt: string,
  blueprint: Record<string, unknown>,
): RuntimeInfo {
  return {
    id,
    backend: "wordpress-playground",
    status: "destroyed",
    createdAt,
    environment: {
      kind: "wordpress",
      name: snapshot.metadata.activeTheme ? `replayable-site-${snapshot.metadata.activeTheme}` : "replayable-wordpress-site",
      version: snapshot.compatibility.wordpressVersion,
      phpVersion: snapshot.compatibility.phpVersion,
      blueprint,
    },
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
