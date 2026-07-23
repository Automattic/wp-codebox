import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { materializationPhaseResult, namedFileTreeSkipPolicyNames, phpStringArrayLiteral, type MaterializationDiagnostic, type MaterializationPhaseResult, type MountSpec } from "@automattic/wp-codebox-core"
import type { PlaygroundCliServer } from "./preview-server.js"
import { SKIPPED_CAPTURE_DIRECTORIES } from "./artifacts.js"
import { assertPlaygroundResponseOk, errorMessage } from "./playground-command-errors.js"

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

export type StagedInputMaterializationResult = MountMaterializationResult

export interface ReadonlyMountStaging {
  mounts: MountSpec[]
  diagnostics: MaterializationDiagnostic[]
  phaseResult: MaterializationPhaseResult
  [Symbol.asyncDispose](): Promise<void>
}

interface HostMountFilePayload {
  target: string
  source: string
  size: number
}

interface HostMountFileVerificationPayload {
  target: string
  contentsBase64?: string
  sha256?: string
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

interface HostMountFileVerificationResponse {
  schema?: string
  repaired?: number
  skipped?: number
}

const HOST_MOUNT_FILE_BATCH_SIZE = 100
const HOST_MOUNT_DIRECTORY_BATCH_SIZE = 500
const HOST_MOUNT_CHUNKED_WRITE_THRESHOLD = 1024 * 1024
const HOST_MOUNT_WRITE_CHUNK_SIZE = 256 * 1024

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
      await cp(mount.source, source, {
        recursive: mount.type !== "file",
        dereference: true,
        async filter(entry) {
          if (!(await lstat(entry)).isSymbolicLink()) {
            return true
          }
          let reason: "dangling-target" | "source-escape"
          try {
            const target = await realpath(entry)
            const relativeTarget = relative(sourceRoot, target)
            if (relativeTarget !== ".." && !relativeTarget.startsWith(`..${sep}`) && !isAbsolute(relativeTarget)) {
              return true
            }
            reason = "source-escape"
          } catch {
            reason = "dangling-target"
          }
          const path = relative(mount.source, entry).replace(/\\/g, "/") || "."
          diagnostics.push({
            code: "readonly-mount-symlink-skipped",
            message: `Skipped ${reason} symlink in readonly mount: ${path}`,
            severity: "warning",
            phase: "playground-readonly-mount-staging",
            metadata: {
              mountIndex: index,
              mountTarget: mount.target,
              path,
              reason,
            },
          })
          return false
        },
      })
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
  const fileBatch: Array<HostMountFilePayload & { contentsBase64: string }> = []
  const verificationBatch: HostMountFileVerificationPayload[] = []

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
  const flushVerificationBatch = async () => {
    if (verificationBatch.length === 0) {
      return
    }
    const result = await verifyHostMountFilesWithPhp(server, verificationBatch.splice(0, verificationBatch.length))
    skipped += result.skipped
  }
  const writeFilePayload = async (payload: HostMountFilePayload) => {
    const target = payload.target.trim()
    if (!target || target.includes("\0")) {
      skipped++
      return
    }
    if (payload.size > HOST_MOUNT_CHUNKED_WRITE_THRESHOLD) {
      const verification = await materializeHostMountFileInChunks(server, { ...payload, target })
      materialized++
      verificationBatch.push(verification)
      if (verificationBatch.length >= HOST_MOUNT_FILE_BATCH_SIZE) {
        await flushVerificationBatch()
      }
      return
    }
    const contents = await readFile(payload.source)
    const contentsBase64 = contents.toString("base64")
    if (!server.playground.writeFile) {
      fileBatch.push({ ...payload, contentsBase64 })
      if (fileBatch.length >= HOST_MOUNT_FILE_BATCH_SIZE) {
        await flushFileBatch()
      }
      return
    }
    const text = contents.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(contents)) {
      fileBatch.push({ ...payload, contentsBase64 })
      if (fileBatch.length >= HOST_MOUNT_FILE_BATCH_SIZE) {
        await flushFileBatch()
      }
      return
    }
    try {
      await server.playground.writeFile(target, text)
      materialized++
      verificationBatch.push({ target, contentsBase64 })
      if (verificationBatch.length >= HOST_MOUNT_FILE_BATCH_SIZE) {
        await flushVerificationBatch()
      }
    } catch {
      const fallback = await materializeHostMountFilesWithPhp(server, [{ ...payload, contentsBase64 }], [])
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
  await flushVerificationBatch()
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
    yield { type: "file", file: { target: mount.target, source: mount.source, size: sourceStat.size } }
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
      const fileStat = await stat(absolutePath)
      yield { type: "file", file: { target: `${target}/${relativePath}`, source: absolutePath, size: fileStat.size } }
    }
  }
}

async function materializeHostMountFilesWithPhp(server: PlaygroundCliServer, files: Array<HostMountFilePayload & { contentsBase64: string }>, directories: string[]): Promise<{ materialized: number; created: number; skipped: number }> {
  const response = await server.playground.run({ code: hostMountWritePhp(files, directories) })
  assertPlaygroundResponseOk("playground-staged-input-write", response)
  const parsed = parseMaterializationJson<HostMountFileMaterializationResponse>(response.text, "wp-codebox/host-mount-materialization/v1", "playground-staged-input-write")
  return {
    materialized: parsed.materialized ?? 0,
    created: parsed.created ?? 0,
    skipped: parsed.skipped ?? 0,
  }
}

async function materializeHostMountFileInChunks(server: PlaygroundCliServer, file: HostMountFilePayload): Promise<HostMountFileVerificationPayload> {
  const hash = createHash("sha256")
  const snapshotDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-staged-file-"))
  const snapshot = join(snapshotDirectory, basename(file.source) || "staged-file")
  try {
    await cp(file.source, snapshot)
    const handle = await open(snapshot, "r")
    try {
      const truncateResponse = await server.playground.run({ code: hostMountChunkWritePhp(file.target) })
      assertPlaygroundResponseOk("playground-staged-input-chunked-write", truncateResponse)
      assertChunkWriteResult(truncateResponse.text, file.target, 0)

      const buffer = Buffer.allocUnsafe(HOST_MOUNT_WRITE_CHUNK_SIZE)
      let position = 0
      let chunk = 0
      while (position < file.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - position), position)
        if (bytesRead === 0) {
          throw new Error(`playground-staged-input-chunked-write could not read ${boundedTarget(file.target)} after ${position} byte(s)`)
        }
        const contents = buffer.subarray(0, bytesRead)
        hash.update(contents)
        const response = await server.playground.run({ code: hostMountChunkWritePhp(file.target, contents.toString("base64")) })
        assertPlaygroundResponseOk("playground-staged-input-chunked-write", response)
        assertChunkWriteResult(response.text, file.target, ++chunk)
        position += bytesRead
      }
    } finally {
      await handle.close()
    }
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
  return { target: file.target, sha256: hash.digest("hex") }
}

function assertChunkWriteResult(text: string, target: string, chunk: number): void {
  const parsed = parseMaterializationJson<HostMountFileMaterializationResponse>(text, "wp-codebox/host-mount-chunk-materialization/v1", "playground-staged-input-chunked-write")
  if ((parsed.skipped ?? 0) > 0 || (chunk > 0 && (parsed.materialized ?? 0) !== 1)) {
    throw new Error(`playground-staged-input-chunked-write could not write ${boundedTarget(target)} at chunk ${chunk}`)
  }
}

function boundedTarget(target: string): string {
  return target.length <= 200 ? target : `${target.slice(0, 197)}...`
}

async function verifyHostMountFilesWithPhp(server: PlaygroundCliServer, files: HostMountFileVerificationPayload[]): Promise<{ repaired: number; skipped: number }> {
  const response = await server.playground.run({ code: hostMountVerifyPhp(files) })
  assertPlaygroundResponseOk("playground-staged-input-verify", response)
  const parsed = parseMaterializationJson<HostMountFileVerificationResponse>(response.text, "wp-codebox/host-mount-verification/v1", "playground-staged-input-verify")
  if ((parsed.skipped ?? 0) > 0) {
    throw new Error(`playground-staged-input-verify could not preserve ${parsed.skipped} staged input file(s)`)
  }
  return {
    repaired: parsed.repaired ?? 0,
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

function hostMountWritePhp(files: Array<HostMountFilePayload & { contentsBase64: string }>, directories: string[]): string {
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

function hostMountVerifyPhp(files: HostMountFileVerificationPayload[]): string {
  const payload = JSON.stringify(JSON.stringify({ files }))
  return `<?php
$payload = json_decode(${payload}, true);
$repaired = 0;
$skipped = 0;
foreach (($payload['files'] ?? array()) as $file) {
    $target = (string) ($file['target'] ?? '');
    $expected_hash = (string) ($file['sha256'] ?? '');
    $contents = base64_decode((string) ($file['contentsBase64'] ?? ''), true);
    if ('' === $target || str_contains($target, "\0") || ('' === $expected_hash && false === $contents)) {
        $skipped++;
        continue;
    }
    $target_hash = is_file($target) ? hash_file('sha256', $target) : false;
    if (is_string($target_hash) && hash_equals('' === $expected_hash ? hash('sha256', $contents) : $expected_hash, $target_hash)) {
        continue;
    }
    if ('' !== $expected_hash) {
        $skipped++;
        continue;
    }
    $directory = dirname($target);
    if ((!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) || false === file_put_contents($target, $contents)) {
        $skipped++;
        continue;
    }
    $repaired_hash = hash_file('sha256', $target);
    if (!is_string($repaired_hash) || !hash_equals(hash('sha256', $contents), $repaired_hash)) {
        $skipped++;
        continue;
    }
    $repaired++;
}
echo json_encode(array('schema' => 'wp-codebox/host-mount-verification/v1', 'repaired' => $repaired, 'skipped' => $skipped), JSON_UNESCAPED_SLASHES);
`
}

function hostMountChunkWritePhp(target: string, contentsBase64?: string): string {
  const payload = JSON.stringify(JSON.stringify({ target, contentsBase64 }))
  return `<?php
$payload = json_decode(${payload}, true);
$target = (string) ($payload['target'] ?? '');
$contents_base64 = $payload['contentsBase64'] ?? null;
$materialized = 0;
$skipped = 0;
if ('' === $target || str_contains($target, "\0")) {
    $skipped++;
} elseif (null === $contents_base64) {
    $handle = fopen($target, 'wb');
    if (false === $handle) {
        $skipped++;
    } else {
        fclose($handle);
    }
} else {
    $contents = base64_decode((string) $contents_base64, true);
    if (false === $contents || strlen($contents) !== file_put_contents($target, $contents, FILE_APPEND)) {
        $skipped++;
    } else {
        $materialized++;
    }
}
echo json_encode(array('schema' => 'wp-codebox/host-mount-chunk-materialization/v1', 'materialized' => $materialized, 'skipped' => $skipped), JSON_UNESCAPED_SLASHES);
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
