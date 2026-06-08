import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  artifactManifestFile,
  calculateArtifactContentDigest,
  refreshArtifactManifestFileSha256s,
  type ArtifactManifest,
  type RuntimeInfo,
} from "@automattic/wp-codebox-core"
import { runtimeSnapshotRestorePhp, type RuntimeSnapshotArtifact } from "./runtime-snapshot.js"

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
    blueprintPath: "blueprint.json"
    snapshotPath: "files/runtime-snapshot.json"
    limitationsPath: "files/replay-limitations.json"
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
