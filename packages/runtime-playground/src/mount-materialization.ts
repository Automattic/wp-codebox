import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { materializationPhaseResult, namedFileTreeSkipPolicyNames, phpStringArrayLiteral, type MaterializationPhaseResult, type MountSpec } from "@automattic/wp-codebox-core"
import type { PlaygroundCliServer } from "./preview-server.js"
import { SKIPPED_CAPTURE_DIRECTORIES } from "./artifacts.js"
import { assertPlaygroundResponseOk, errorMessage } from "./playground-command-errors.js"

export interface HostMountSnapshot {
  mountIndex: number
  target: string
  files: Record<string, string>
}

export interface VfsMountSnapshot {
  mountIndex: number
  target: string
  authoritative?: boolean
  files: Array<{
    relativePath: string
    sha256: string
    contentsBase64?: string
  }>
}

export interface MountMaterializationResult {
  materialized: number
  deleted: number
  skipped: number
  phaseResult: MaterializationPhaseResult
}

export type StagedInputMaterializationResult = MountMaterializationResult

interface HostMountFilePayload {
  target: string
  contentsBase64: string
}

interface HostMountDirectoryMaterializationResponse {
  schema?: string
  created?: number
  skipped?: number
  missing?: string[]
  unreadable?: string[]
  unresolved?: string[]
}

interface HostMountFileMaterializationResponse {
  schema?: string
  materialized?: number
  created?: number
  skipped?: number
}

const HOST_MOUNT_FILE_BATCH_SIZE = 100
const HOST_MOUNT_DIRECTORY_BATCH_SIZE = 500

function mountMaterializationResult(input: Omit<MountMaterializationResult, "phaseResult">): MountMaterializationResult {
  return {
    ...input,
    phaseResult: materializationPhaseResult({
      phase: "playground-vfs-mount-materialization",
      status: input.materialized > 0 || input.deleted > 0 ? "completed" : "skipped",
      metadata: input,
    }),
  }
}

export async function materializePlaygroundMountsFromVfs(server: PlaygroundCliServer, mounts: MountSpec[]): Promise<MountMaterializationResult> {
  const writableDirectoryMounts = mounts
    .map((mount, mountIndex) => ({ mount, mountIndex }))
    .filter(({ mount }) => mount.mode === "readwrite" && mount.type !== "file" && mountMaterializesVfsToHost(mount))
  if (writableDirectoryMounts.length === 0) {
    return mountMaterializationResult({ materialized: 0, deleted: 0, skipped: 0 })
  }

  const hostSnapshots: HostMountSnapshot[] = []
  for (const { mount, mountIndex } of writableDirectoryMounts) {
    hostSnapshots.push({
      mountIndex,
      target: mount.target,
      files: await hostFileHashes(mount.source),
    })
  }

  const response = await server.playground.run({ code: vfsMountSnapshotPhp(hostSnapshots) })
  const parsed = JSON.parse(response.text || "{}") as { mounts?: VfsMountSnapshot[] }
  return applyVfsMountSnapshots(mounts, parsed.mounts ?? [])
}

function mountMaterializesVfsToHost(mount: MountSpec): boolean {
  return Boolean(mount.metadata && typeof mount.metadata === "object" && !Array.isArray(mount.metadata) && mount.metadata.materializeVfsToHost === true)
}

export async function materializePlaygroundMountsToVfs(server: PlaygroundCliServer, mounts: MountSpec[]): Promise<MountMaterializationResult> {
  return await materializePlaygroundStagedInputs(server, mounts)
}

export async function materializePlaygroundStagedInputs(server: PlaygroundCliServer, mounts: MountSpec[]): Promise<StagedInputMaterializationResult> {
  let materialized = 0
  let created = 0
  let skipped = 0
  for (const mount of mounts) {
    const result = await materializeHostMountToVfs(server, mount)
    materialized += result.materialized
    created += result.created
    skipped += result.skipped
  }
  if (materialized === 0 && created === 0) {
    return {
      materialized: 0,
      deleted: 0,
      skipped,
      phaseResult: materializationPhaseResult({
        phase: "playground-staged-input-materialization",
        status: "skipped",
        metadata: { materialized: 0, deleted: 0, skipped },
      }),
    }
  }

  return {
    materialized,
    deleted: 0,
    skipped,
    phaseResult: materializationPhaseResult({
      phase: "playground-staged-input-materialization",
      status: materialized > 0 || created > 0 ? "completed" : "skipped",
      metadata: { materialized, deleted: 0, skipped, created },
    }),
  }
}

async function materializeHostMountToVfs(server: PlaygroundCliServer, mount: MountSpec): Promise<{ materialized: number; created: number; skipped: number }> {
  let materialized = 0
  let created = 0
  let skipped = 0
  const directoryBatch: string[] = []
  const fileBatch: HostMountFilePayload[] = []

  const flushDirectories = async () => {
    if (directoryBatch.length === 0) {
      return
    }
    const result = await createHostMountDirectories(server, directoryBatch.splice(0, directoryBatch.length))
    created += result.created
    skipped += result.skipped
  }
  const queueDirectory = async (directory: string) => {
    directoryBatch.push(directory)
    if (directoryBatch.length >= HOST_MOUNT_DIRECTORY_BATCH_SIZE) {
      await flushDirectories()
    }
  }
  const flushFileBatch = async () => {
    if (fileBatch.length === 0) {
      return
    }
    const result = await materializeHostMountFilesWithPhp(server, fileBatch.splice(0, fileBatch.length), [])
    materialized += result.materialized
    created += result.created
    skipped += result.skipped
  }
  const writeFilePayload = async (payload: HostMountFilePayload) => {
    if (!server.playground.writeFile) {
      fileBatch.push(payload)
      if (fileBatch.length >= HOST_MOUNT_FILE_BATCH_SIZE) {
        await flushFileBatch()
      }
      return
    }
    const target = payload.target.trim()
    if (!target || target.includes("\0")) {
      skipped++
      return
    }
    try {
      await server.playground.writeFile(target, Buffer.from(payload.contentsBase64, "base64").toString("utf8"))
      materialized++
    } catch {
      const fallback = await materializeHostMountFilesWithPhp(server, [payload], [])
      materialized += fallback.materialized
      created += fallback.created
      skipped += fallback.skipped
    }
  }

  for await (const entry of hostMountEntriesForVfs(mount)) {
    if (entry.type === "skipped") {
      skipped += entry.count
      continue
    }
    if (entry.type === "directory") {
      await queueDirectory(entry.target)
      continue
    }
    await flushDirectories()
    await writeFilePayload(entry.file)
  }
  await flushDirectories()
  await flushFileBatch()
  return { materialized, created, skipped }
}

async function createHostMountDirectories(server: PlaygroundCliServer, directories: string[]): Promise<{ created: number; skipped: number }> {
  if (directories.length === 0) {
    return { created: 0, skipped: 0 }
  }
  const response = await server.playground.run({ code: hostMountMkdirPhp(directories) })
  assertPlaygroundResponseOk("playground-staged-input-mkdir", response)
  const parsed = parseMaterializationJson<HostMountDirectoryMaterializationResponse>(response.text, "wp-codebox/host-mount-directory-materialization/v1", "playground-staged-input-mkdir")
  const failures = [
    ...(parsed.missing ?? []).map((path) => `${path} (missing)`),
    ...(parsed.unreadable ?? []).map((path) => `${path} (unreadable)`),
    ...(parsed.unresolved ?? []).map((path) => `${path} (unresolved)`),
  ]
  if (failures.length > 0) {
    throw new Error(`Staged input mount target directories are not readable in the sandbox after materialization: ${failures.slice(0, 10).join(", ")}${failures.length > 10 ? `, and ${failures.length - 10} more` : ""}`)
  }
  return {
    created: parsed.created ?? 0,
    skipped: parsed.skipped ?? 0,
  }
}

type HostMountEntry =
  | { type: "directory"; target: string }
  | { type: "file"; file: HostMountFilePayload }
  | { type: "skipped"; count: number }

async function* hostMountEntriesForVfs(mount: MountSpec): AsyncGenerator<HostMountEntry> {
  let sourceStat
  try {
    sourceStat = await stat(mount.source)
  } catch {
    yield { type: "skipped", count: 1 }
    return
  }

  if (mount.type === "file" || sourceStat.isFile()) {
    const parent = dirname(mount.target.trim())
    if (parent && parent !== ".") {
      yield { type: "directory", target: parent }
    }
    yield { type: "file", file: { target: mount.target, contentsBase64: (await readFile(mount.source)).toString("base64") } }
    return
  }
  if (!sourceStat.isDirectory()) {
    yield { type: "skipped", count: 1 }
    return
  }

  const source = mount.source
  const target = mount.target.replace(/\/+$/, "")
  yield { type: "directory", target }
  const pending = [""]

  while (pending.length > 0) {
    const currentDirectory = pending.pop() ?? ""
    let entries
    try {
      entries = await readdir(join(source, currentDirectory), { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_CAPTURE_DIRECTORIES.has(entry.name)) {
        continue
      }
      const relativePath = currentDirectory ? `${currentDirectory}/${entry.name}` : entry.name
      const absolutePath = join(source, relativePath)
      if (entry.isDirectory()) {
        yield { type: "directory", target: `${target}/${relativePath}` }
        pending.push(relativePath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      yield { type: "file", file: { target: `${target}/${relativePath}`, contentsBase64: (await readFile(absolutePath)).toString("base64") } }
    }
  }
}

async function materializeHostMountFilesWithPhp(server: PlaygroundCliServer, files: HostMountFilePayload[], directories: string[]): Promise<{ materialized: number; created: number; skipped: number }> {
  const response = await server.playground.run({ code: hostMountWritePhp(files, directories) })
  assertPlaygroundResponseOk("playground-staged-input-write", response)
  const parsed = parseMaterializationJson<HostMountFileMaterializationResponse>(response.text, "wp-codebox/host-mount-materialization/v1", "playground-staged-input-write")
  return {
    materialized: parsed.materialized ?? 0,
    created: parsed.created ?? 0,
    skipped: parsed.skipped ?? 0,
  }
}

function parseMaterializationJson<T extends { schema?: string }>(text: string, schema: string, command: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(text || "{}")
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${errorMessage(error)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { schema?: unknown }).schema !== schema) {
    throw new Error(`${command} did not return ${schema}; received ${text.trim() || "empty response"}`)
  }
  return parsed as T
}

export async function applyVfsMountSnapshots(mounts: MountSpec[], snapshots: VfsMountSnapshot[]): Promise<MountMaterializationResult> {
  const result = { materialized: 0, deleted: 0, skipped: 0 }

  for (const snapshot of snapshots) {
    const mount = mounts[snapshot.mountIndex]
    if (!mount || mount.mode !== "readwrite" || mount.type === "file" || snapshot.authoritative === false) {
      result.skipped++
      continue
    }

    const present = new Set<string>()
    const writableFiles: typeof snapshot.files = []
    for (const file of snapshot.files) {
      if (!containedHostPath(mount.source, file.relativePath)) {
        result.skipped++
        continue
      }
      present.add(file.relativePath)
      writableFiles.push(file)
    }
    for (const file of writableFiles) {
      if (file.contentsBase64 === undefined) {
        continue
      }
      const hostPath = containedHostPath(mount.source, file.relativePath)
      if (!hostPath) {
        result.skipped++
        continue
      }
      await mkdir(dirname(hostPath), { recursive: true })
      await writeFile(hostPath, Buffer.from(file.contentsBase64, "base64"))
      result.materialized++
    }

    if (mount.metadata && typeof mount.metadata === "object" && !Array.isArray(mount.metadata) && (mount.metadata as { materializeDeletes?: unknown }).materializeDeletes === true) {
      const existing = await hostFileHashes(mount.source)
      for (const relativePath of Object.keys(existing)) {
        if (present.has(relativePath)) {
          continue
        }
        const hostPath = containedHostPath(mount.source, relativePath)
        if (!hostPath) {
          result.skipped++
          continue
        }
        await rm(hostPath, { force: true })
        result.deleted++
      }
    }
  }

  return mountMaterializationResult(result)
}

function containedHostPath(root: string, relativePath: string): string | undefined {
  if (!relativePath || isAbsolute(relativePath)) {
    return undefined
  }
  const rootPath = resolve(root)
  const hostPath = resolve(rootPath, relativePath)
  const pathWithinRoot = relative(rootPath, hostPath)
  if (!pathWithinRoot || pathWithinRoot.startsWith("..") || isAbsolute(pathWithinRoot)) {
    return undefined
  }
  return hostPath
}

async function hostFileHashes(directory: string, relativeDirectory = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  let entries
  try {
    entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_CAPTURE_DIRECTORIES.has(entry.name)) {
      continue
    }
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const absolutePath = join(directory, relativePath)
    if (entry.isDirectory()) {
      Object.assign(files, await hostFileHashes(directory, relativePath))
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    files[relativePath] = createHash("sha256").update(await readFile(absolutePath)).digest("hex")
  }

  return files
}

function hostMountWritePhp(files: HostMountFilePayload[], directories: string[]): string {
  const payload = JSON.stringify(JSON.stringify({ files, directories }))
  return `<?php
$payload = json_decode(${payload}, true);
$materialized = 0;
$created = 0;
$skipped = 0;
foreach (($payload['directories'] ?? array()) as $directory) {
    $directory = (string) $directory;
    if ('' === $directory || str_contains($directory, "\0")) {
        $skipped++;
        continue;
    }
    if (is_dir($directory) || mkdir($directory, 0777, true) || is_dir($directory)) {
        $created++;
        continue;
    }
    $skipped++;
}
foreach (($payload['files'] ?? array()) as $file) {
    $target = (string) ($file['target'] ?? '');
    $contents = (string) ($file['contentsBase64'] ?? '');
    if ('' === $target || str_contains($target, "\0")) {
        $skipped++;
        continue;
    }
    $directory = dirname($target);
    if (!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) {
        $skipped++;
        continue;
    }
    $decoded = base64_decode($contents, true);
    if (false === $decoded || false === file_put_contents($target, $decoded)) {
        $skipped++;
        continue;
    }
    $materialized++;
}
echo json_encode(array('schema' => 'wp-codebox/host-mount-materialization/v1', 'materialized' => $materialized, 'created' => $created, 'skipped' => $skipped), JSON_UNESCAPED_SLASHES);
`
}

function hostMountMkdirPhp(directories: string[]): string {
  const payload = JSON.stringify(JSON.stringify({ directories }))
  return `<?php
$payload = json_decode(${payload}, true);
$created = 0;
$skipped = 0;
$missing = array();
$unreadable = array();
$unresolved = array();
foreach (($payload['directories'] ?? array()) as $directory) {
    $directory = (string) $directory;
    if ('' === $directory || str_contains($directory, "\0")) {
        $skipped++;
        continue;
    }
    if (is_dir($directory) || mkdir($directory, 0777, true) || is_dir($directory)) {
        $created++;
        continue;
    }
    $skipped++;
}

foreach (($payload['directories'] ?? array()) as $directory) {
    $directory = (string) $directory;
    if ('' === $directory || str_contains($directory, "\0")) {
        continue;
    }
    if (!is_dir($directory)) {
        $missing[] = $directory;
        continue;
    }
    if (!is_readable($directory)) {
        $unreadable[] = $directory;
        continue;
    }
    if (false === realpath($directory)) {
        $unresolved[] = $directory;
    }
}
echo json_encode(array('schema' => 'wp-codebox/host-mount-directory-materialization/v1', 'created' => $created, 'skipped' => $skipped, 'missing' => $missing, 'unreadable' => $unreadable, 'unresolved' => $unresolved), JSON_UNESCAPED_SLASHES);
`
}

export function vfsMountSnapshotPhp(hostSnapshots: HostMountSnapshot[]): string {
  const payload = JSON.stringify(JSON.stringify({ mounts: hostSnapshots }))
  const skipList = phpStringArrayLiteral(namedFileTreeSkipPolicyNames("captured-mount"))
  return `<?php
$payload = json_decode(${payload}, true);
$skip = array_fill_keys(${skipList}, true);

function wp_codebox_vfs_mount_files(string $root, array $host_hashes, array $skip): array {
    $files = array();
    $walk = function (string $directory, string $relative_directory) use (&$walk, &$files, $root, $host_hashes, $skip): void {
        if (!is_dir($directory)) {
            return;
        }
        $entries = scandir($directory);
        if (false === $entries) {
            return;
        }
        foreach ($entries as $entry) {
            if ('.' === $entry || '..' === $entry) {
                continue;
            }
            if (isset($skip[$entry]) && is_dir($directory . '/' . $entry)) {
                continue;
            }
            $relative_path = '' === $relative_directory ? $entry : $relative_directory . '/' . $entry;
            $path = $directory . '/' . $entry;
            if (is_dir($path)) {
                $walk($path, $relative_path);
                continue;
            }
            if (!is_file($path)) {
                continue;
            }
            $hash = hash_file('sha256', $path);
            $file = array(
                'relativePath' => $relative_path,
                'sha256' => $hash,
            );
            if (($host_hashes[$relative_path] ?? '') !== $hash) {
                $contents = file_get_contents($path);
                $file['contentsBase64'] = false === $contents ? '' : base64_encode($contents);
            }
            $files[] = $file;
        }
    };
    $walk(rtrim($root, '/'), '');
    return $files;
}

$mounts = array();
foreach (($payload['mounts'] ?? array()) as $mount) {
    $target = (string) ($mount['target'] ?? '');
    if ('' === $target || !is_dir($target)) {
        $mounts[] = array(
            'mountIndex' => (int) ($mount['mountIndex'] ?? -1),
            'target' => $target,
            'authoritative' => false,
            'files' => array(),
        );
        continue;
    }
    $mounts[] = array(
        'mountIndex' => (int) ($mount['mountIndex'] ?? -1),
        'target' => $target,
        'authoritative' => true,
        'files' => wp_codebox_vfs_mount_files($target, is_array($mount['files'] ?? null) ? $mount['files'] : array(), $skip),
    );
}

echo json_encode(array('schema' => 'wp-codebox/vfs-mount-snapshot/v1', 'mounts' => $mounts), JSON_UNESCAPED_SLASHES);
`
}
