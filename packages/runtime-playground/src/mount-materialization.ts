import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { materializationPhaseResult, namedFileTreeSkipPolicy, namedFileTreeSkipPolicyNames, phpStringArrayLiteral, type MaterializationDiagnostic, type MaterializationPhaseResult, type MountSpec } from "@automattic/wp-codebox-core"
import type { PlaygroundCliServer } from "./preview-server.js"
import { SKIPPED_CAPTURE_DIRECTORIES } from "./artifacts.js"

export interface HostMountSnapshot {
  mountIndex: number
  target: string
  files: Record<string, string>
  excludedPaths?: string[]
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

export interface ReadonlyMountStaging {
  mounts: MountSpec[]
  diagnostics: MaterializationDiagnostic[]
  phaseResult: MaterializationPhaseResult
  [Symbol.asyncDispose](): Promise<void>
}

const READONLY_MOUNT_SKIPPED_DIRECTORIES = namedFileTreeSkipPolicy("captured-mount")
const STAGED_FILE_CHUNK_SIZE = 256 * 1024

/**
 * Playground's Node filesystem mount handler is writable. Snapshot readonly
 * inputs into a runtime-owned directory before handing them to that handler.
 */
export async function stageReadonlyPlaygroundMounts(mounts: MountSpec[]): Promise<ReadonlyMountStaging> {
  const readonlyMounts = mounts.filter((mount) => mount.mode === "readonly")
  if (readonlyMounts.length === 0) {
    return {
      mounts,
      diagnostics: [],
      phaseResult: readonlyMountStagingPhaseResult(0, []),
      async [Symbol.asyncDispose]() {},
    }
  }

  const root = await mkdtemp(join(tmpdir(), "wp-codebox-readonly-mounts-"))
  try {
    const stagedMountResults = await Promise.allSettled(mounts.map(async (mount, index) => {
      if (mount.mode !== "readonly") {
        return { mount, diagnostics: [] }
      }
      const source = join(root, `${index}-${basename(mount.source) || "mount"}`)
      const sourceRoot = await realpath(mount.source)
      const diagnostics: MaterializationDiagnostic[] = []
      if (mount.type === "file") {
        await cp(mount.source, source, { dereference: true })
      } else {
        await stageReadonlyDirectory(mount, index, sourceRoot, source, diagnostics)
      }
      diagnostics.sort((left, right) => String(left.metadata?.path) < String(right.metadata?.path) ? -1 : String(left.metadata?.path) > String(right.metadata?.path) ? 1 : 0)
      return { mount: { ...mount, source }, diagnostics }
    }))
    const failedMount = stagedMountResults.find((result) => result.status === "rejected")
    if (failedMount?.status === "rejected") {
      throw failedMount.reason
    }
    const stagedMounts = stagedMountResults.map((result) => {
      if (result.status !== "fulfilled") {
        throw result.reason
      }
      return result.value.mount
    })
    const diagnostics = stagedMountResults.flatMap((result) => result.status === "fulfilled" ? result.value.diagnostics : [])
    return {
      mounts: stagedMounts,
      diagnostics,
      phaseResult: readonlyMountStagingPhaseResult(readonlyMounts.length, diagnostics),
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function stageReadonlyDirectory(mount: MountSpec, mountIndex: number, sourceRoot: string, destination: string, diagnostics: MaterializationDiagnostic[]): Promise<void> {
  const visit = async (directory: string, stagedDirectory: string, relativeDirectory: string, ancestors: ReadonlySet<string>): Promise<void> => {
    await mkdir(stagedDirectory, { recursive: true })
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const path = join(directory, entry.name)
      const stagedPath = join(stagedDirectory, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const entryStat = await lstat(path)
      if (!entryStat.isSymbolicLink()) {
        if (entryStat.isDirectory()) {
          if (READONLY_MOUNT_SKIPPED_DIRECTORIES.has(entry.name)) {
            continue
          }
          const target = await realpath(path)
          await visit(target, stagedPath, relativePath, new Set([...ancestors, target]))
        } else {
          await cp(path, stagedPath)
        }
        continue
      }

      let target: string
      try {
        target = await realpath(path)
      } catch {
        addReadonlySymlinkDiagnostic(diagnostics, mount, mountIndex, relativePath, "dangling-target")
        continue
      }
      if (!pathIsWithinRoot(sourceRoot, target)) {
        addReadonlySymlinkDiagnostic(diagnostics, mount, mountIndex, relativePath, "source-escape")
        continue
      }
      const targetStat = await stat(target)
      if (!targetStat.isDirectory()) {
        await cp(target, stagedPath)
        continue
      }
      if (READONLY_MOUNT_SKIPPED_DIRECTORIES.has(entry.name)) {
        continue
      }
      if (ancestors.has(target)) {
        addReadonlySymlinkDiagnostic(diagnostics, mount, mountIndex, relativePath, "directory-cycle")
        continue
      }
      await visit(target, stagedPath, relativePath, new Set([...ancestors, target]))
    }
  }

  await visit(sourceRoot, destination, "", new Set([sourceRoot]))
}

function pathIsWithinRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function addReadonlySymlinkDiagnostic(diagnostics: MaterializationDiagnostic[], mount: MountSpec, mountIndex: number, path: string, reason: "dangling-target" | "source-escape" | "directory-cycle"): void {
  diagnostics.push({
    code: "readonly-mount-symlink-skipped",
    message: `Skipped ${reason} symlink in readonly mount: ${path}`,
    severity: "warning",
    phase: "playground-readonly-mount-staging",
    metadata: {
      mountIndex,
      mountTarget: mount.target,
      path,
      reason,
    },
  })
}

function readonlyMountStagingPhaseResult(mounts: number, diagnostics: MaterializationDiagnostic[]): MaterializationPhaseResult {
  return materializationPhaseResult({
    phase: "playground-readonly-mount-staging",
    status: mounts > 0 ? "completed" : "skipped",
    metadata: { mounts, skipped: diagnostics.length, diagnostics },
  })
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
      excludedPaths: nestedMountPaths(mounts, mountIndex, mount.target),
    })
  }

  const response = await server.playground.run({ code: vfsMountSnapshotPhp(hostSnapshots) })
  const parsed = JSON.parse(response.text || "{}") as { mounts?: VfsMountSnapshot[] }
  return applyVfsMountSnapshots(mounts, parsed.mounts ?? [])
}

export async function materializePlaygroundStagedFiles(server: PlaygroundCliServer, mounts: MountSpec[]): Promise<number> {
  let materialized = 0
  for (const mount of mounts) {
    if (mount.type !== "file") continue

    const handle = await open(mount.source, "r")
    try {
      const buffer = Buffer.allocUnsafe(STAGED_FILE_CHUNK_SIZE)
      let position = 0
      let append = false
      do {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        const response = await server.playground.run({ code: stagedFileWritePhp(mount.target, buffer.subarray(0, bytesRead).toString("base64"), append) })
        const result = JSON.parse(response.text || "{}") as { schema?: string; written?: number }
        if (result.schema !== "wp-codebox/staged-file-write/v1" || result.written !== bytesRead) {
          throw new Error(`Could not materialize staged file at ${mount.target}`)
        }
        position += bytesRead
        append = true
        if (bytesRead === 0 || bytesRead < buffer.length) break
      } while (true)
    } finally {
      await handle.close()
    }
    materialized++
  }
  return materialized
}

function stagedFileWritePhp(target: string, contentsBase64: string, append: boolean): string {
  const payload = JSON.stringify(JSON.stringify({ target, contentsBase64, append }))
  return `<?php
$payload = json_decode(${payload}, true);
$target = (string) ($payload['target'] ?? '');
$contents = base64_decode((string) ($payload['contentsBase64'] ?? ''), true);
$written = false;
if ('' !== $target && !str_contains($target, "\0") && false !== $contents) {
    $directory = dirname($target);
    if ((is_dir($directory) || mkdir($directory, 0777, true) || is_dir($directory))) {
        $written = file_put_contents($target, $contents, !empty($payload['append']) ? FILE_APPEND : 0);
    }
}
echo json_encode(array('schema' => 'wp-codebox/staged-file-write/v1', 'written' => false === $written ? -1 : $written), JSON_UNESCAPED_SLASHES);
`
}

function nestedMountPaths(mounts: MountSpec[], mountIndex: number, parentTarget: string): string[] {
  const normalizedParent = parentTarget.replace(/\/+$/, "")
  return mounts
    .slice(mountIndex + 1)
    .map((mount) => mount.target.replace(/\/+$/, ""))
    .filter((target) => target.startsWith(`${normalizedParent}/`))
    .map((target) => target.slice(normalizedParent.length + 1))
}

function mountMaterializesVfsToHost(mount: MountSpec): boolean {
  return Boolean(mount.metadata && typeof mount.metadata === "object" && !Array.isArray(mount.metadata) && mount.metadata.materializeVfsToHost === true)
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

export function vfsMountSnapshotPhp(hostSnapshots: HostMountSnapshot[]): string {
  const payload = JSON.stringify(JSON.stringify({ mounts: hostSnapshots }))
  const skipList = phpStringArrayLiteral(namedFileTreeSkipPolicyNames("captured-mount"))
  return `<?php
$payload = json_decode(${payload}, true);
$skip = array_fill_keys(${skipList}, true);

function wp_codebox_vfs_mount_files(string $root, array $host_hashes, array $skip, array $excluded_paths): array {
    $files = array();
    $walk = function (string $directory, string $relative_directory) use (&$walk, &$files, $root, $host_hashes, $skip, $excluded_paths): void {
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
            $excluded = false;
            foreach ($excluded_paths as $excluded_path) {
                if ($relative_path === $excluded_path || str_starts_with($relative_path, $excluded_path . '/')) {
                    $excluded = true;
                    break;
                }
            }
            if ($excluded) {
                continue;
            }
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
        'files' => wp_codebox_vfs_mount_files($target, is_array($mount['files'] ?? null) ? $mount['files'] : array(), $skip, is_array($mount['excludedPaths'] ?? null) ? $mount['excludedPaths'] : array()),
    );
}

echo json_encode(array('schema' => 'wp-codebox/vfs-mount-snapshot/v1', 'mounts' => $mounts), JSON_UNESCAPED_SLASHES);
`
}
