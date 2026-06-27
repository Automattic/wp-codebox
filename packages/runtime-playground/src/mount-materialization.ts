import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { materializationPhaseResult, namedFileTreeSkipPolicyNames, phpStringArrayLiteral, type MaterializationPhaseResult, type MountSpec } from "@automattic/wp-codebox-core"
import type { PlaygroundCliServer } from "./preview-server.js"
import { SKIPPED_CAPTURE_DIRECTORIES } from "./artifacts.js"

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
    .filter(({ mount }) => mount.mode === "readwrite" && mount.type !== "file")
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

export async function materializePlaygroundMountsToVfs(server: PlaygroundCliServer, mounts: MountSpec[]): Promise<MountMaterializationResult> {
  return await materializePlaygroundStagedInputs(server, mounts)
}

export async function materializePlaygroundStagedInputs(server: PlaygroundCliServer, mounts: MountSpec[]): Promise<StagedInputMaterializationResult> {
  const files: HostMountFilePayload[] = []
  let skipped = 0
  for (const mount of mounts) {
    const collected = await hostMountFilesForVfs(mount)
    files.push(...collected.files)
    skipped += collected.skipped
  }
  if (files.length === 0) {
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

  const materializedByPersistentWriter = await materializeHostMountFilesWithPersistentWriter(server, files)
  const materialized = materializedByPersistentWriter?.materialized ?? 0
  const totalSkipped = skipped + (materializedByPersistentWriter?.skipped ?? 0)
  return {
    materialized,
    deleted: 0,
    skipped: totalSkipped,
    phaseResult: materializationPhaseResult({
      phase: "playground-staged-input-materialization",
      status: materialized > 0 ? "completed" : "skipped",
      metadata: { materialized, deleted: 0, skipped: totalSkipped },
    }),
  }
}

async function materializeHostMountFilesWithPersistentWriter(server: PlaygroundCliServer, files: HostMountFilePayload[]): Promise<{ materialized: number; skipped: number } | undefined> {
  if (!server.playground.writeFile) {
    return materializeHostMountFilesWithPhp(server, files)
  }

  const directories = [...new Set(files.map((file) => dirname(file.target.trim())).filter((directory) => directory && directory !== "."))]
  const directoryResult = await createHostMountDirectories(server, directories)
  let materialized = 0
  let skipped = directoryResult.skipped
  for (const file of files) {
    const target = file.target.trim()
    if (!target || target.includes("\0")) {
      skipped++
      continue
    }
    try {
      await server.playground.writeFile(target, Buffer.from(file.contentsBase64, "base64").toString("utf8"))
      materialized++
    } catch {
      skipped++
    }
  }
  return { materialized, skipped }
}

async function createHostMountDirectories(server: PlaygroundCliServer, directories: string[]): Promise<{ created: number; skipped: number }> {
  if (directories.length === 0) {
    return { created: 0, skipped: 0 }
  }
  const response = await server.playground.run({ code: hostMountMkdirPhp(directories) })
  const parsed = JSON.parse(response.text || "{}") as { created?: number; skipped?: number }
  return {
    created: parsed.created ?? 0,
    skipped: parsed.skipped ?? 0,
  }
}

async function materializeHostMountFilesWithPhp(server: PlaygroundCliServer, files: HostMountFilePayload[]): Promise<{ materialized: number; skipped: number }> {
  const response = await server.playground.run({ code: hostMountWritePhp(files) })
  const parsed = JSON.parse(response.text || "{}") as { materialized?: number; skipped?: number }
  return {
    materialized: parsed.materialized ?? 0,
    skipped: parsed.skipped ?? 0,
  }
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

async function hostMountFilesForVfs(mount: MountSpec): Promise<{ files: HostMountFilePayload[]; skipped: number }> {
  const files: HostMountFilePayload[] = []
  let skipped = 0
  let sourceStat
  try {
    sourceStat = await stat(mount.source)
  } catch {
    return { files, skipped: 1 }
  }

  if (mount.type === "file" || sourceStat.isFile()) {
    files.push({ target: mount.target, contentsBase64: (await readFile(mount.source)).toString("base64") })
    return { files, skipped }
  }
  if (!sourceStat.isDirectory()) {
    return { files, skipped: skipped + 1 }
  }

  for (const file of await hostMountDirectoryFiles(mount.source)) {
    files.push({ target: `${mount.target.replace(/\/+$/, "")}/${file.relativePath}`, contentsBase64: file.contentsBase64 })
  }
  return { files, skipped }
}

async function hostMountDirectoryFiles(directory: string, relativeDirectory = ""): Promise<Array<{ relativePath: string; contentsBase64: string }>> {
  const files: Array<{ relativePath: string; contentsBase64: string }> = []
  let entries
  try {
    entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const absolutePath = join(directory, relativePath)
    if (entry.isDirectory()) {
      files.push(...await hostMountDirectoryFiles(directory, relativePath))
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    files.push({ relativePath, contentsBase64: (await readFile(absolutePath)).toString("base64") })
  }
  return files
}

function hostMountWritePhp(files: HostMountFilePayload[]): string {
  const payload = JSON.stringify(JSON.stringify({ files }))
  return `<?php
$payload = json_decode(${payload}, true);
$materialized = 0;
$skipped = 0;
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
echo json_encode(array('schema' => 'wp-codebox/host-mount-materialization/v1', 'materialized' => $materialized, 'skipped' => $skipped), JSON_UNESCAPED_SLASHES);
`
}

function hostMountMkdirPhp(directories: string[]): string {
  const payload = JSON.stringify(JSON.stringify({ directories }))
  return `<?php
$payload = json_decode(${payload}, true);
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
echo json_encode(array('schema' => 'wp-codebox/host-mount-directory-materialization/v1', 'created' => $created, 'skipped' => $skipped), JSON_UNESCAPED_SLASHES);
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
