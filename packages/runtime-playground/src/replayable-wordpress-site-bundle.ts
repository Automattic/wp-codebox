import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ARTIFACT_MANIFEST_PATH,
  RUNTIME_SNAPSHOT_ARTIFACT_PATH,
  artifactJson,
  artifactManifestFile,
  calculateArtifactContentDigest,
  writeArtifactJson,
  writeArtifactManifestJson,
  type ArtifactManifest,
  type RuntimeInfo,
} from "@automattic/wp-codebox-core"
import { ArtifactBundleWriter } from "./artifact-bundle-writer.js"
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
    playgroundBundlePath?: string
    publicViewerArtifactPath?: string
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
    playgroundBundle: "blueprint.zip"
    snapshot: "files/runtime-snapshot.json"
    notes: "blueprint.after-notes.json"
  }
  manifest: ReplayableWordPressSiteBundleManifest
}

export async function writeReplayExportPackage(snapshot: RuntimeSnapshotArtifact, options: ReplayExportPackageOptions): Promise<ReplayExportPackage> {
  const createdAt = options.createdAt ?? new Date().toISOString()
  const directory = options.directory
  const writer = new ArtifactBundleWriter(directory)
  const snapshotPath = RUNTIME_SNAPSHOT_ARTIFACT_PATH
  const blueprintPath = "blueprint.after.json"
  const playgroundBundlePath = "blueprint.zip"
  const notesPath = "blueprint.after-notes.json"
  const blueprint = buildReplayExportBlueprint(snapshot, options)
  const notes = buildReplayableWordPressSiteLimitations(snapshot, {
    source: {
      kind: "wordpress.export-replay-package",
      snapshotPath,
      mode: "external-runtime-snapshot",
      ...(options.source ?? {}),
    },
  })

  await writer.writeJson(blueprintPath, blueprint, { kind: "blueprint-after" })
  await writer.writeJson(snapshotPath, snapshot, { kind: "runtime-snapshot" })
  await writer.writeJson(notesPath, notes, { kind: "blueprint-after-notes" })
  await writer.writeGenerated(playgroundBundlePath, { kind: "playground-blueprint-bundle", contentType: "application/zip" }, (path) => writePlaygroundBlueprintBundle(path, [
    { path: "blueprint.json", data: artifactJson(blueprint) },
    { path: RUNTIME_SNAPSHOT_ARTIFACT_PATH, data: artifactJson(snapshot) },
  ]))

  const contentInputs = [blueprintPath, playgroundBundlePath, snapshotPath, notesPath]
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
    files: [],
    replayableWordPressSite: {
      blueprintPath,
      playgroundBundlePath,
      publicViewerArtifactPath: playgroundBundlePath,
      snapshotPath,
      limitationsPath: notesPath,
      replayStatus: "replayable-runtime-state",
      source: {
        kind: "wordpress.export-replay-package",
        snapshotPath,
        mode: "external-runtime-snapshot",
        ...(options.source ?? {}),
      },
    },
  }

  await writer.writeManifest(manifest)

  const [snapshotStats, blueprintStats] = await Promise.all([stat(writer.path(snapshotPath)), stat(writer.path(blueprintPath))])
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
      manifest: ARTIFACT_MANIFEST_PATH,
      blueprint: blueprintPath,
      playgroundBundle: playgroundBundlePath,
      snapshot: snapshotPath,
      notes: notesPath,
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

  const blueprint = buildReplayableWordPressSiteBlueprint(snapshot, options)
  const limitations = buildReplayableWordPressSiteLimitations(snapshot, options)

  await writeArtifactJson(join(directory, "blueprint.json"), blueprint)
  await writeArtifactJson(join(filesDirectory, "runtime-snapshot.json"), snapshot)
  await writeArtifactJson(join(filesDirectory, "replay-limitations.json"), limitations)

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
      artifactManifestFile(ARTIFACT_MANIFEST_PATH, "manifest", "application/json"),
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

  await writeArtifactManifestJson(directory, ARTIFACT_MANIFEST_PATH, manifest)

  return {
    id,
    directory,
    manifestPath: join(directory, ARTIFACT_MANIFEST_PATH),
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
      php: playgroundBlueprintPhpVersion(snapshot.compatibility.phpVersion),
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
      php: playgroundBlueprintPhpVersion(snapshot.compatibility.phpVersion),
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

function playgroundBlueprintPhpVersion(version: string): string {
  return version.replace(/^(\d+\.\d+)\.\d+$/, "$1")
}

async function writePlaygroundBlueprintBundle(path: string, entries: Array<{ path: string; data: string }>): Promise<void> {
  const records: Buffer[] = []
  const centralDirectoryRecords: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const fileName = Buffer.from(entry.path, "utf8")
    const data = Buffer.from(entry.data, "utf8")
    const crc = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(fileName.length, 26)
    localHeader.writeUInt16LE(0, 28)
    records.push(localHeader, fileName, data)

    const centralDirectoryRecord = Buffer.alloc(46)
    centralDirectoryRecord.writeUInt32LE(0x02014b50, 0)
    centralDirectoryRecord.writeUInt16LE(20, 4)
    centralDirectoryRecord.writeUInt16LE(20, 6)
    centralDirectoryRecord.writeUInt16LE(0, 8)
    centralDirectoryRecord.writeUInt16LE(0, 10)
    centralDirectoryRecord.writeUInt16LE(0, 12)
    centralDirectoryRecord.writeUInt16LE(0, 14)
    centralDirectoryRecord.writeUInt32LE(crc, 16)
    centralDirectoryRecord.writeUInt32LE(data.length, 20)
    centralDirectoryRecord.writeUInt32LE(data.length, 24)
    centralDirectoryRecord.writeUInt16LE(fileName.length, 28)
    centralDirectoryRecord.writeUInt16LE(0, 30)
    centralDirectoryRecord.writeUInt16LE(0, 32)
    centralDirectoryRecord.writeUInt16LE(0, 34)
    centralDirectoryRecord.writeUInt16LE(0, 36)
    centralDirectoryRecord.writeUInt32LE(0, 38)
    centralDirectoryRecord.writeUInt32LE(offset, 42)
    centralDirectoryRecords.push(centralDirectoryRecord, fileName)

    offset += localHeader.length + fileName.length + data.length
  }

  const centralDirectoryOffset = offset
  const centralDirectorySize = centralDirectoryRecords.reduce((size, record) => size + record.length, 0)
  const endOfCentralDirectory = Buffer.alloc(22)
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
  endOfCentralDirectory.writeUInt16LE(0, 4)
  endOfCentralDirectory.writeUInt16LE(0, 6)
  endOfCentralDirectory.writeUInt16LE(entries.length, 8)
  endOfCentralDirectory.writeUInt16LE(entries.length, 10)
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12)
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16)
  endOfCentralDirectory.writeUInt16LE(0, 20)

  await writeFile(path, Buffer.concat([...records, ...centralDirectoryRecords, endOfCentralDirectory]))
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  return value >>> 0
})
