import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, sep } from "node:path"
import { calculateArtifactContentDigest, calculateArtifactManifestFileSha256 } from "./artifact-manifest.js"
import type { ArtifactFileDigest, ArtifactManifest, ArtifactManifestFile, ArtifactSpec } from "./artifact-manifest.js"
import { RUNTIME_EPISODE_ACTION_SCHEMA, RUNTIME_EPISODE_OBSERVATION_SCHEMA, RUNTIME_EPISODE_SNAPSHOT_SCHEMA, RUNTIME_EPISODE_TRACE_SCHEMA, validateRuntimeEpisodeTrace } from "./runtime-episode.js"
import { RUNTIME_REFERENCE_MANIFEST_SCHEMA, RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA, runtimeReferenceManifestDigest, runtimeReplayReferenceIndexDigest } from "./runtime-reference.js"
import type { RuntimeReferenceManifest, RuntimeReferenceManifestArtifactBundleRef, RuntimeReferenceManifestFileRef, RuntimeReferenceManifestSnapshotRef, RuntimeReplayReferenceIndex, RuntimeReplayReferenceIndexActionRef, RuntimeReplayReferenceIndexObservationRef } from "./runtime-reference.js"
import { isPlainObject as isRecord } from "./object-utils.js"
import { assertRuntimePolicy } from "./runtime-policy.js"
import type { RuntimePolicy } from "./runtime-policy.js"
import { SANDBOX_WORKSPACE_ROOT } from "./runtime-action-adapter.js"

export * from "./artifact-manifest.js"
export * from "./runtime-policy.js"
export * from "./workspace-policy.js"
export * from "./sandbox-datamachine-tool-policy.js"
export * from "./command-registry.js"
export * from "./task-input.js"
export * from "./browser-interaction.js"
export * from "./recipe-schema.js"
export * from "./runtime-episode.js"
export * from "./runtime-reference.js"
export * from "./object-utils.js"
export * from "./runtime-action-adapter.js"

export type RuntimeBackendKind = "wordpress-playground" | (string & {})

export type SandboxWorkspaceMode = "repo-backed" | "site-backed"

export interface EnvironmentSpec {
  kind: string
  name?: string
  blueprint?: unknown
  version?: string
}

export interface RuntimeCreateSpec {
  backend: RuntimeBackendKind
  environment: EnvironmentSpec
  policy: RuntimePolicy
  artifactsDirectory?: string
  secretEnv?: Record<string, string>
  metadata?: Record<string, unknown>
  preview?: RuntimePreviewSpec
}

export interface RuntimePreviewSpec {
  publicUrl?: string
  siteUrl?: string
  port?: number
  bind?: string
}

export interface WorkspaceRecipeMount {
  type?: "directory" | "file"
  source: string
  target: string
  mode?: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeStagedFile {
  source: string
  target: string
}

export interface WorkspaceRecipeStep {
  command: string
  args?: string[]
}

export interface WorkspaceRecipePluginRuntimePhp {
  memoryLimit?: string
  maxExecutionTime?: number
}

export interface WorkspaceRecipePluginRuntimeHealthProbe {
  name: string
  type: "plugin-active" | "php" | "wp-cli"
  pluginFile?: string
  code?: string
  command?: string
}

export interface WorkspaceRecipePluginRuntime {
  label?: string
  php?: WorkspaceRecipePluginRuntimePhp
  wpConfigDefines?: Record<string, string | number | boolean | null>
  setup?: WorkspaceRecipeStep[]
  healthProbes?: WorkspaceRecipePluginRuntimeHealthProbe[]
}

export interface WorkspaceRecipeExtraPlugin {
  source: string
  slug?: string
  pluginFile?: string
  activate?: boolean
  sha256?: string
  loadAs?: "plugin" | "mu-plugin"
}

export type WorkspaceRecipeSiteSeedType = "fixture" | "parent_site"
export type WorkspaceRecipeSiteSeedFormat = "json" | (string & {})

export interface WorkspaceRecipeSiteSeedScopeSelector {
  ids?: number[]
  slugs?: string[]
  names?: string[]
  postTypes?: string[]
  taxonomies?: string[]
  roles?: string[]
  statuses?: string[]
  includeFiles?: boolean
  anonymize?: boolean
  maxRecords?: number
}

export interface WorkspaceRecipeSiteSeed {
  type: WorkspaceRecipeSiteSeedType
  name: string
  source?: string
  format?: WorkspaceRecipeSiteSeedFormat
  scopes: {
    posts?: WorkspaceRecipeSiteSeedScopeSelector
    terms?: WorkspaceRecipeSiteSeedScopeSelector
    options?: WorkspaceRecipeSiteSeedScopeSelector
    users?: WorkspaceRecipeSiteSeedScopeSelector
    media?: WorkspaceRecipeSiteSeedScopeSelector
    activePlugins?: boolean
    activeTheme?: boolean
  }
}

export type WorkspaceRecipeSeedType = "plugin_scaffold" | "theme_scaffold" | "directory"

export interface WorkspaceRecipeWorkspaceSeed {
  type: WorkspaceRecipeSeedType
  slug?: string
  name?: string
  source?: string
  excludePaths?: string[]
}

export interface WorkspaceRecipeWorkspace {
  target?: string
  mode?: "readonly" | "readwrite"
  sourceMode?: SandboxWorkspaceMode
  seed: WorkspaceRecipeWorkspaceSeed
}

export interface SandboxWorkspaceMountRef {
  target: string
  mode: "readonly" | "readwrite"
  sourceMode: SandboxWorkspaceMode
  workspaceRef?: string
  mountRole?: string
  component?: string
  repo?: string
  gitRef?: string
  defaultBranch?: string
  wpContentPath?: string
}

export interface SandboxWorkspaceContract {
  schema: "wp-codebox/sandbox-workspace/v1"
  root: typeof SANDBOX_WORKSPACE_ROOT | (string & {})
  defaultMode: SandboxWorkspaceMode
  mounts: SandboxWorkspaceMountRef[]
  dmc: {
    safeAbilities: string[]
    parentOnlyAbilities: string[]
  }
}

export interface WorkspaceRecipe {
  schema: "wp-codebox/workspace-recipe/v1"
  runtime?: {
    backend?: RuntimeBackendKind
    name?: string
    wp?: string
    blueprint?: unknown
  }
  inputs?: {
    workspaces?: WorkspaceRecipeWorkspace[]
    mounts?: WorkspaceRecipeMount[]
    extra_plugins?: WorkspaceRecipeExtraPlugin[]
    extraPlugins?: WorkspaceRecipeExtraPlugin[]
    secretEnv?: string[]
    pluginRuntime?: WorkspaceRecipePluginRuntime
    siteSeeds?: WorkspaceRecipeSiteSeed[]
    stagedFiles?: WorkspaceRecipeStagedFile[]
    inherit?: WorkspaceRecipeInheritanceRequest
    inheritance?: WorkspaceRecipeInheritanceResolution
  }
  workflow: {
    before?: WorkspaceRecipeStep[]
    steps: WorkspaceRecipeStep[]
    after?: WorkspaceRecipeStep[]
  }
  artifacts?: {
    directory?: string
    verify?: boolean | WorkspaceRecipeArtifactVerifier
    workspacePolicy?: boolean | WorkspaceRecipeWorkspacePolicyArtifact
  }
}

export interface WorkspaceRecipeArtifactVerifier {
  enabled?: boolean
  strict?: boolean
}

export interface WorkspaceRecipeWorkspacePolicyArtifact {
  enabled?: boolean
  strict?: boolean
  writableRoots?: string[]
  hiddenPaths?: string[]
  gitBacked?: boolean
}

export interface WorkspaceRecipeInheritanceRequest {
  connectors?: string[]
  settings?: string[]
}

export interface WorkspaceRecipeInheritanceConnector {
  name: string
  status: "resolved" | "unresolved" | "skipped" | (string & {})
  provider?: string
  model?: string
  secretEnv?: string[]
  credentials?: ConnectorCredentialEnvelope
}

export type ConnectorCredentialStatus = "available" | "missing" | "denied"

export interface ConnectorCredentialSecret {
  name: string
  status: ConnectorCredentialStatus
  scope?: string
  source?: "parent-env" | "connector" | (string & {})
  reason?: string
}

export interface ConnectorCredentialEnvelope {
  schema: "wp-codebox/connector-credentials/v1"
  connector: string
  scope: "connector"
  status: ConnectorCredentialStatus
  secrets: ConnectorCredentialSecret[]
  reason?: string
}

export interface WorkspaceRecipeInheritanceSetting {
  name: string
  status: "resolved" | "unresolved" | "skipped" | (string & {})
  scope?: string
}

export interface WorkspaceRecipeInheritanceResolution {
  connectors?: WorkspaceRecipeInheritanceConnector[]
  settings?: WorkspaceRecipeInheritanceSetting[]
}

export interface RuntimeInfo {
  id: string
  backend: RuntimeBackendKind
  environment: EnvironmentSpec
  createdAt: string
  status: "created" | "destroyed"
  previewUrl?: string
}

export interface MountSpec {
  type: "directory" | "file" | (string & {})
  source: string
  target: string
  mode: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
}

export interface ExecutionSpec {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

export type RuntimeEpisodeActionKind = "command" | "filesystem" | "http" | "browser"

export interface RuntimeEpisodeActionSpec extends ExecutionSpec {
  kind?: RuntimeEpisodeActionKind
  method?: string
  url?: string
  path?: string
  operation?: string
  selector?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface RuntimeEpisodeContentDigest {
  algorithm: "sha256"
  value: string
}

export interface RuntimeEpisodeTraceRef {
  kind: "action" | "execution" | "observation" | "snapshot" | "artifact-bundle" | (string & {})
  id: string
  digest?: RuntimeEpisodeContentDigest
  artifactId?: string
  path?: string
}

export interface RuntimeEpisodeActionRecord {
  schema: typeof RUNTIME_EPISODE_ACTION_SCHEMA
  id: string
  kind: RuntimeEpisodeActionKind
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
  method?: string
  url?: string
  path?: string
  operation?: string
  selector?: string
  description?: string
  metadata?: Record<string, unknown>
  digest: RuntimeEpisodeContentDigest
}

export interface ExecutionResult {
  id: string
  command: string
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
  startedAt: string
  finishedAt: string
}

export interface ObservationSpec {
  type:
    | "runtime-info"
    | "mounts"
    | "files"
    | "command-result"
    | "wordpress-state"
    | "http-response"
    | "browser-result"
    | "runtime-events"
    | "runtime-logs"
    | (string & {})
  path?: string
  commandId?: string
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  includeBody?: boolean
  sections?: string[]
  redaction?: "safe" | "none" | (string & {})
  includeContent?: boolean
  optionNames?: string[]
  userFields?: string[]
}

export interface ObservationResult {
  schema?: typeof RUNTIME_EPISODE_OBSERVATION_SCHEMA
  id?: string
  type: string
  data: unknown
  observedAt: string
  artifactRefs?: RuntimeEpisodeTraceRef[]
  digest?: RuntimeEpisodeContentDigest
}

export interface LifecycleEvent {
  id: string
  type:
    | "runtime.created"
    | "runtime.mounted"
    | "runtime.command.started"
    | "runtime.command.finished"
    | "runtime.observed"
    | "runtime.snapshot.created"
    | "runtime.artifacts.collected"
    | "runtime.destroyed"
    | (string & {})
  timestamp: string
  data?: Record<string, unknown>
}

export interface Snapshot {
  schema?: typeof RUNTIME_EPISODE_SNAPSHOT_SCHEMA
  id: string
  createdAt: string
  semantics?: "metadata-only" | "partial-replay" | "replayable-runtime-state" | "runtime-state-artifact" | (string & {})
  metadata: Record<string, unknown>
  artifactRefs?: RuntimeEpisodeTraceRef[]
  digest?: RuntimeEpisodeContentDigest
}

export interface RuntimeRestoreSpec {
  runtime?: RuntimeCreateSpec
  mounts?: MountSpec[]
}

export interface ArtifactProvenance {
  task?: Record<string, unknown>
  workspace?: SandboxWorkspaceContract
  runtime: {
    backend: RuntimeBackendKind
    version?: string
    wordpressVersion?: string
  }
  agent?: Record<string, unknown>
  mounts: Array<{
    type: MountSpec["type"]
    source: string
    target: string
    mode: MountSpec["mode"]
    metadata?: Record<string, unknown>
  }>
}

export type ArtifactReviewProgressEventType =
  | "boot"
  | "mount"
  | "agent-start"
  | "tool-activity"
  | "artifact"
  | "complete"
  | (string & {})

export interface ArtifactReviewProgressEvent {
  type: ArtifactReviewProgressEventType
  label: string
  component?: string
  action?: string
  timestamp?: string
}

export type ArtifactReviewActionKind = "approve" | "approve-files" | "discard" | "iterate" | (string & {})

export interface ArtifactReviewAction {
  kind: ArtifactReviewActionKind
  label: string
  requiresApprovedFiles?: boolean
}

export interface ArtifactReviewChangedFile {
  path: string
  status: "added" | "modified" | "deleted"
  label: string
  mountTarget: string
  relativePath: string
}

export interface ArtifactReview {
  schema: "wp-codebox/artifact-review/v1"
  artifactId: string
  createdAt: string
  provenance: ArtifactProvenance
  summary: string
  stats: {
    added: number
    modified: number
    deleted: number
    total: number
  }
  changedFiles: ArtifactReviewChangedFile[]
  preview?: ArtifactPreview
  progress: ArtifactReviewProgressEvent[]
  actions: ArtifactReviewAction[]
  evidence: {
    patch: string
    patchSha256: string
    artifactContentDigest: string
    changedFiles: string
    testResults?: string
    runtimeEpisodeTrace?: string
    runtimeReferenceManifest?: string
    runtimeReplayReferenceIndex?: string
    agentResult?: string
    transcript?: string
  }
  browser?: ArtifactReviewBrowserSummary
  redaction?: ArtifactRedactionSummary
  riskFlags: string[]
}

export interface ArtifactReviewBrowserSummary {
  summary: string
  probes: Array<{
    url: string
    requestedUrl?: string
    finalUrl?: string
    viewport?: {
      width: number
      height: number
      deviceScaleFactor: number
      isMobile: boolean
      hasTouch: boolean
      userAgent: string
    } | null
    replayability?: "artifact-backed" | "partial" | "diagnostic-only"
    consoleMessages: number
    errors: number
    html?: string
    network?: string
    networkEvents?: number
    checkpoints?: string
    memory?: string
    performance?: string
    screenshot?: string
    console?: string
    errorsFile?: string
    actions?: string
    actionCount?: number
    steps?: string
    stepCount?: number
    assertions?: {
      total: number
      passed: number
      failed: number
    }
    summaryFile?: string
  }>
}

export interface ArtifactPreview {
  url: string
  localUrl?: string
  publicUrl?: string
  siteUrl?: string
  status: "available" | "expired-on-completion"
  lifecycle: "held-after-run" | "destroyed-on-completion"
  source: "live-playground" | "public-url-override"
  createdAt: string
  expiresAt?: string
  holdSeconds?: number
}

export interface ArtifactRedactionArtifactSummary {
  path: string
  count: number
  kinds: string[]
}

export interface ArtifactRedactionSummary {
  schema: "wp-codebox/artifact-redaction/v1"
  status: "clean" | "redacted"
  total: number
  byKind: Record<string, number>
  artifacts: ArtifactRedactionArtifactSummary[]
}

export interface ArtifactTestResultsRawLogReference {
  path: string
  kind: string
}

export interface ArtifactTestResultsSuite {
  name: string
  status: "passed" | "failed" | "skipped" | "unknown"
  tests: number
  passed: number
  failed: number
  skipped: number
  unknown: number
  rawLogReferences?: ArtifactTestResultsRawLogReference[]
}

export interface ArtifactTestResults {
  schema: "wp-codebox/test-results/v1"
  status: "passed" | "failed" | "skipped" | "unknown"
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    unknown: number
  }
  suites: ArtifactTestResultsSuite[]
  rawLogReferences: ArtifactTestResultsRawLogReference[]
}

export interface ArtifactBundle {
  id: string
  directory: string
  manifestPath: string
  metadataPath: string
  blueprintAfterPath: string
  blueprintAfterNotesPath: string
  eventsPath: string
  commandsPath: string
  observationsPath: string
  runtimeLogPath: string
  commandsLogPath: string
  mountsPath: string
  capturedMountsPath: string
  diffsPath: string
  changedFilesPath: string
  patchPath: string
  testResultsPath: string
  reviewPath: string
  runAttestationPath?: string
  runtimeEpisodeTracePath?: string
  runtimeEpisodeEventsPath?: string
  artifactVerificationPath?: string
  workspacePolicyPath?: string
  runtimeReferenceManifestPath?: string
  runtimeReferenceIndexPath?: string
  runtimeReplayReferenceIndexPath?: string
  preview?: ArtifactPreview
  contentDigest: string
  createdAt: string
}

export type ArtifactBundleVerificationViolationCode =
  | "missing-manifest"
  | "malformed-manifest"
  | "invalid-manifest-shape"
  | "invalid-path"
  | "missing-file"
  | "orphaned-file"
  | "digest-mismatch"
  | "missing-file-hash"
  | "file-hash-mismatch"
  | "bundle-id-mismatch"
  | "malformed-reference"
  | "review-evidence-mismatch"
  | "unsafe-file"
  | "hardlink"

export interface ArtifactBundleVerificationViolation {
  code: ArtifactBundleVerificationViolationCode
  path: string
  message: string
  file?: string
  details?: Record<string, unknown>
}

export interface ArtifactBundleVerificationResult {
  schema: "wp-codebox/artifact-bundle-verification/v1"
  bundleDirectory: string
  valid: boolean
  violations: ArtifactBundleVerificationViolation[]
  manifest?: ArtifactManifest
}

export interface VerifyArtifactBundleOptions {
  manifestFileName?: string
  allowOrphanedFiles?: boolean
}

export async function verifyArtifactBundle(directory: string, options: VerifyArtifactBundleOptions = {}): Promise<ArtifactBundleVerificationResult> {
  const bundleDirectory = normalize(directory)
  const manifestFileName = options.manifestFileName ?? "manifest.json"
  const manifestPath = join(bundleDirectory, manifestFileName)
  const violations: ArtifactBundleVerificationViolation[] = []
  let manifest: ArtifactManifest | undefined

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactManifest
  } catch (error) {
    violations.push({
      code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing-manifest" : "malformed-manifest",
      path: manifestFileName,
      message: (error as NodeJS.ErrnoException).code === "ENOENT" ? "manifest.json is missing." : "manifest.json is not valid JSON.",
    })
    return artifactBundleVerificationResult(bundleDirectory, violations)
  }

  if (!isArtifactManifestShape(manifest)) {
    violations.push({
      code: "invalid-manifest-shape",
      path: manifestFileName,
      message: "manifest.json does not match the WP Codebox artifact manifest shape.",
    })
    return artifactBundleVerificationResult(bundleDirectory, violations)
  }

  const manifestFiles = new Set<string>()
  for (const [index, file] of manifest.files.entries()) {
    const fieldPath = `manifest.files[${index}].path`
    const pathViolation = artifactPathViolation(file.path, fieldPath)
    if (pathViolation) {
      violations.push(pathViolation)
      continue
    }

    if (manifestFiles.has(file.path)) {
      violations.push({ code: "invalid-manifest-shape", path: fieldPath, file: file.path, message: `Manifest file path is duplicated: ${file.path}` })
    }
    manifestFiles.add(file.path)
    try {
      await verifyBundleFileTopology(bundleDirectory, file.path, fieldPath, violations)
    } catch {
      violations.push({ code: "missing-file", path: fieldPath, file: file.path, message: `Manifest file is missing: ${file.path}` })
    }
  }

  if (!manifestFiles.has(manifestFileName)) {
    violations.push({
      code: "invalid-manifest-shape",
      path: "manifest.files",
      file: manifestFileName,
      message: "manifest.json must list itself in manifest.files.",
    })
  }

  if (!options.allowOrphanedFiles) {
    for (const file of await listBundleFiles(bundleDirectory)) {
      if (!manifestFiles.has(file)) {
        violations.push({ code: "orphaned-file", path: file, file, message: `Bundle file is not listed in manifest.json: ${file}` })
      }
    }
  }

  await verifyManifestFileHashes(bundleDirectory, manifest, manifestFileName, violations)
  await verifyContentDigest(bundleDirectory, manifest, manifestFiles, violations)
  verifyBundleId(manifest, violations)
  await verifyMetadataReferences(bundleDirectory, manifestFiles, violations)
  await verifyReviewEvidence(bundleDirectory, manifest, manifestFiles, violations)
  await verifyRuntimeEpisodeTraceArtifacts(bundleDirectory, manifest, violations)
  await verifyRuntimeReferenceManifestArtifacts(bundleDirectory, manifest, manifestFiles, violations)
  await verifyRuntimeReplayReferenceIndexArtifacts(bundleDirectory, manifest, manifestFiles, violations)

  return artifactBundleVerificationResult(bundleDirectory, violations, manifest)
}

async function verifyBundleFileTopology(directory: string, path: string, fieldPath: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  const absolutePath = join(directory, path)
  const fileStat = await lstat(absolutePath)
  if (!fileStat.isFile()) {
    violations.push({ code: "missing-file", path: fieldPath, file: path, message: `Manifest path is not a regular file: ${path}` })
    return
  }

  if (typeof fileStat.nlink !== "number" || !Number.isFinite(fileStat.nlink)) {
    violations.push({ code: "hardlink", path: fieldPath, file: path, message: `Unable to determine artifact file link count: ${path}`, details: { linkCountAvailable: false } })
  } else if (fileStat.nlink > 1) {
    violations.push({ code: "hardlink", path: fieldPath, file: path, message: `Artifact file must not be hard linked: ${path}`, details: { links: fileStat.nlink } })
  }

  try {
    const [bundleRealpath, fileRealpath] = await Promise.all([realpath(directory), realpath(absolutePath)])
    const realRelative = relative(bundleRealpath, fileRealpath)
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      violations.push({ code: "unsafe-file", path: fieldPath, file: path, message: `Artifact file resolves outside the bundle directory: ${path}` })
    }
  } catch (error) {
    violations.push({ code: "unsafe-file", path: fieldPath, file: path, message: `Unable to prove artifact file stays inside the bundle directory: ${errorMessage(error)}` })
  }
}

async function verifyManifestFileHashes(directory: string, manifest: ArtifactManifest, manifestFileName: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const [index, file] of manifest.files.entries()) {
    if (artifactPathViolation(file.path, `manifest.files[${index}].path`)) {
      continue
    }

    const fieldPath = `manifest.files[${index}].sha256`
    if (!isArtifactFileDigestShape(file.sha256)) {
      violations.push({ code: "missing-file-hash", path: fieldPath, file: file.path, message: `Manifest file entry must include a lowercase SHA-256 digest: ${file.path}` })
      continue
    }

    try {
      const value = await calculateArtifactManifestFileSha256(directory, manifest, file, manifestFileName)
      if (value !== file.sha256.value) {
        violations.push({ code: "file-hash-mismatch", path: fieldPath, file: file.path, message: `Manifest file hash does not match ${file.path}: expected ${value}, got ${file.sha256.value}` })
      }
    } catch (error) {
      violations.push({ code: "file-hash-mismatch", path: fieldPath, file: file.path, message: `Unable to hash manifest file entry ${file.path}: ${errorMessage(error)}` })
    }
  }
}

function artifactBundleVerificationResult(bundleDirectory: string, violations: ArtifactBundleVerificationViolation[], manifest?: ArtifactManifest): ArtifactBundleVerificationResult {
  return {
    schema: "wp-codebox/artifact-bundle-verification/v1",
    bundleDirectory,
    valid: violations.length === 0,
    violations,
    ...(manifest ? { manifest } : {}),
  }
}

function isArtifactManifestShape(value: unknown): value is ArtifactManifest {
  if (!isRecord(value)) {
    return false
  }

  const contentDigest = value.contentDigest
  return typeof value.id === "string"
    && typeof value.createdAt === "string"
    && isRecord(value.runtime)
    && isRecord(contentDigest)
    && contentDigest.algorithm === "sha256"
    && Array.isArray(contentDigest.inputs)
    && contentDigest.inputs.every((input) => typeof input === "string")
    && typeof contentDigest.value === "string"
    && Array.isArray(value.files)
    && value.files.every(isArtifactManifestFileShape)
}

function isArtifactManifestFileShape(value: unknown): value is ArtifactManifestFile {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.kind === "string"
    && typeof value.contentType === "string"
}

function isRuntimeReferenceManifestShape(value: unknown): value is RuntimeReferenceManifest {
  if (!isRecord(value)) {
    return false
  }

  return value.schema === RUNTIME_REFERENCE_MANIFEST_SCHEMA
    && value.version === 1
    && typeof value.id === "string"
    && typeof value.createdAt === "string"
    && isArtifactFileDigestShape(value.digest)
    && isRecord(value.runtime)
    && isRuntimeReferenceManifestArtifactBundleRefShape(value.artifactBundle)
    && Array.isArray(value.files)
    && value.files.every(isRuntimeReferenceManifestFileRefShape)
    && (value.trace === undefined || isRuntimeReferenceManifestFileRefShape(value.trace))
    && (value.events === undefined || isRuntimeReferenceManifestFileRefShape(value.events))
    && Array.isArray(value.snapshots)
    && value.snapshots.every(isRuntimeReferenceManifestSnapshotRefShape)
}

function isRuntimeReferenceManifestArtifactBundleRefShape(value: unknown): value is RuntimeReferenceManifestArtifactBundleRef {
  return isRecord(value)
    && value.kind === "artifact-bundle"
    && typeof value.id === "string"
    && isArtifactFileDigestShape(value.digest)
}

function isRuntimeReferenceManifestFileRefShape(value: unknown): value is RuntimeReferenceManifestFileRef {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.kind === "string"
    && typeof value.contentType === "string"
    && isArtifactFileDigestShape(value.sha256)
}

function isRuntimeReferenceManifestSnapshotRefShape(value: unknown): value is RuntimeReferenceManifestSnapshotRef {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.semantics === "string"
    && validDigest(value.digest)
    && isRecord(value.replay)
    && typeof value.replay.status === "string"
    && Array.isArray(value.replay.limitations)
    && value.replay.limitations.every((limitation) => typeof limitation === "string")
    && Array.isArray(value.artifactRefs)
    && value.artifactRefs.every((ref) => isRecord(ref) && typeof ref.kind === "string" && typeof ref.id === "string" && validDigest(ref.digest))
}

function isRuntimeReplayReferenceIndexShape(value: unknown): value is RuntimeReplayReferenceIndex {
  if (!isRecord(value)) {
    return false
  }

  return value.schema === RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA
    && value.version === 1
    && typeof value.id === "string"
    && typeof value.createdAt === "string"
    && isArtifactFileDigestShape(value.digest)
    && isRecord(value.runtime)
    && isRuntimeReferenceManifestArtifactBundleRefShape(value.artifactBundle)
    && isRuntimeReplayReferenceIndexReferencesShape(value.references)
    && Array.isArray(value.actions)
    && value.actions.every(isRuntimeReplayReferenceIndexActionRefShape)
    && Array.isArray(value.observations)
    && value.observations.every(isRuntimeReplayReferenceIndexObservationRefShape)
    && Array.isArray(value.snapshots)
    && value.snapshots.every(isRuntimeReferenceManifestSnapshotRefShape)
    && isRecord(value.replay)
    && typeof value.replay.status === "string"
    && Array.isArray(value.replay.instructions)
    && value.replay.instructions.every((instruction) => typeof instruction === "string")
    && Array.isArray(value.replay.limitations)
    && value.replay.limitations.every((limitation) => typeof limitation === "string")
}

function isRuntimeReplayReferenceIndexReferencesShape(value: unknown): value is RuntimeReplayReferenceIndex["references"] {
  if (!isRecord(value)) {
    return false
  }

  return Object.values(value).every((reference) => reference === undefined || isRuntimeReferenceManifestFileRefShape(reference))
}

function isRuntimeReplayReferenceIndexActionRefShape(value: unknown): value is RuntimeReplayReferenceIndexActionRef {
  return isRecord(value)
    && typeof value.index === "number"
    && typeof value.id === "string"
    && isRuntimeEpisodeTraceRefShape(value.actionRef)
    && isRuntimeEpisodeTraceRefShape(value.executionRef)
    && (value.observationRef === undefined || isRuntimeEpisodeTraceRefShape(value.observationRef))
}

function isRuntimeReplayReferenceIndexObservationRefShape(value: unknown): value is RuntimeReplayReferenceIndexObservationRef {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.type === "string"
    && isRuntimeEpisodeTraceRefShape(value.ref)
    && Array.isArray(value.artifactRefs)
    && value.artifactRefs.every(isRuntimeEpisodeTraceRefShape)
}

function isRuntimeEpisodeTraceRefShape(value: unknown): value is RuntimeEpisodeTraceRef {
  return isRecord(value)
    && typeof value.kind === "string"
    && typeof value.id === "string"
    && (value.digest === undefined || validDigest(value.digest))
    && (value.artifactId === undefined || typeof value.artifactId === "string")
    && (value.path === undefined || typeof value.path === "string")
}

function isArtifactFileDigestShape(value: unknown): value is ArtifactFileDigest {
  return isRecord(value)
    && value.algorithm === "sha256"
    && typeof value.value === "string"
    && /^[a-f0-9]{64}$/.test(value.value)
}

function artifactPathViolation(path: string, fieldPath: string): ArtifactBundleVerificationViolation | undefined {
  if (path.length === 0) {
    return { code: "invalid-path", path: fieldPath, file: path, message: "Artifact paths must not be empty." }
  }

  if (path.includes("\\") || isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    return { code: "invalid-path", path: fieldPath, file: path, message: `Artifact path must be bundle-relative and local: ${path}` }
  }

  const normalized = normalize(path).split(sep).join("/")
  if (normalized === ".." || normalized.startsWith("../") || path.split("/").includes("..")) {
    return { code: "invalid-path", path: fieldPath, file: path, message: `Artifact path must not contain traversal: ${path}` }
  }

  return undefined
}

async function verifyContentDigest(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const [index, input] of manifest.contentDigest.inputs.entries()) {
    const pathViolation = artifactPathViolation(input, `manifest.contentDigest.inputs[${index}]`)
    if (pathViolation) {
      violations.push(pathViolation)
      return
    }
    if (!manifestFiles.has(input)) {
      violations.push({ code: "malformed-reference", path: `manifest.contentDigest.inputs[${index}]`, file: input, message: `contentDigest input is not listed in manifest.json: ${input}` })
      return
    }
  }

  if (!/^[a-f0-9]{64}$/.test(manifest.contentDigest.value)) {
    violations.push({ code: "invalid-manifest-shape", path: "manifest.contentDigest.value", message: "contentDigest.value must be a lowercase sha256 hex digest." })
    return
  }

  try {
    const value = await calculateArtifactContentDigest(directory, manifest.contentDigest.inputs)
    if (value !== manifest.contentDigest.value) {
      violations.push({
        code: "digest-mismatch",
        path: "manifest.contentDigest.value",
        message: `contentDigest.value does not match declared inputs: expected ${value}, got ${manifest.contentDigest.value}`,
      })
    }
  } catch (error) {
    violations.push({ code: "digest-mismatch", path: "manifest.contentDigest.inputs", message: `Unable to calculate content digest: ${errorMessage(error)}` })
  }
}

function verifyBundleId(manifest: ArtifactManifest, violations: ArtifactBundleVerificationViolation[]): void {
  const prefix = "artifact-bundle-sha256-"
  if (manifest.id.startsWith(prefix) && manifest.id !== `${prefix}${manifest.contentDigest.value}`) {
    violations.push({
      code: "bundle-id-mismatch",
      path: "manifest.id",
      message: `Bundle id must match content digest: expected ${prefix}${manifest.contentDigest.value}, got ${manifest.id}`,
    })
  }
}

async function verifyMetadataReferences(directory: string, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
  } catch {
    return
  }

  const artifacts = isRecord(metadata) ? metadata.artifacts : undefined
  if (!isRecord(artifacts)) {
    return
  }

  for (const [key, value] of Object.entries(artifacts)) {
    for (const reference of artifactReferenceStrings(value)) {
      validateArtifactReference(reference, `metadata.artifacts.${key}`, manifestFiles, violations)
    }
  }
}

async function verifyReviewEvidence(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  let review: unknown
  try {
    review = JSON.parse(await readFile(join(directory, "files/review.json"), "utf8"))
  } catch {
    return
  }

  if (!isRecord(review) || !isRecord(review.evidence)) {
    violations.push({ code: "malformed-reference", path: "files/review.json", file: "files/review.json", message: "Review artifact does not include an evidence object." })
    return
  }

  const evidence = review.evidence
  if (typeof evidence.artifactContentDigest === "string" && evidence.artifactContentDigest !== manifest.contentDigest.value) {
    violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.artifactContentDigest", file: "files/review.json", message: "Review artifact content digest does not match manifest contentDigest.value." })
  }

  if (typeof evidence.patch === "string") {
    validateArtifactReference(evidence.patch, "files/review.json:evidence.patch", manifestFiles, violations)
    if (typeof evidence.patchSha256 === "string") {
      try {
        const patchSha256 = createHash("sha256").update(await readFile(join(directory, evidence.patch))).digest("hex")
        if (patchSha256 !== evidence.patchSha256) {
          violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.patchSha256", file: "files/review.json", message: "Review patchSha256 does not match the referenced patch file." })
        }
      } catch (error) {
        violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.patchSha256", file: evidence.patch, message: `Unable to hash review patch evidence: ${errorMessage(error)}` })
      }
    }
  }

  if (typeof evidence.changedFiles === "string") {
    validateArtifactReference(evidence.changedFiles, "files/review.json:evidence.changedFiles", manifestFiles, violations)
    await verifyChangedFileEvidence(directory, evidence.changedFiles, review, violations)
  }

  if (typeof evidence.runtimeEpisodeTrace === "string") {
    validateArtifactReference(evidence.runtimeEpisodeTrace, "files/review.json:evidence.runtimeEpisodeTrace", manifestFiles, violations)
  }

  if (typeof evidence.runtimeReferenceManifest === "string") {
    validateArtifactReference(evidence.runtimeReferenceManifest, "files/review.json:evidence.runtimeReferenceManifest", manifestFiles, violations)
  }

  if (typeof evidence.runtimeReplayReferenceIndex === "string") {
    validateArtifactReference(evidence.runtimeReplayReferenceIndex, "files/review.json:evidence.runtimeReplayReferenceIndex", manifestFiles, violations)
  }
}

async function verifyRuntimeEpisodeTraceArtifacts(directory: string, manifest: ArtifactManifest, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const file of manifest.files) {
    if (file.kind !== "runtime-episode-trace") {
      continue
    }

    try {
      const trace = JSON.parse(await readFile(join(directory, file.path), "utf8"))
      const validation = validateRuntimeEpisodeTrace(trace)
      if (!validation.valid) {
        violations.push({
          code: "malformed-reference",
          path: file.path,
          file: file.path,
          message: `Runtime episode trace is invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
        })
      }
    } catch (error) {
      violations.push({
        code: "malformed-reference",
        path: file.path,
        file: file.path,
        message: `Runtime episode trace is not valid JSON: ${errorMessage(error)}`,
      })
    }
  }
}

async function verifyRuntimeReferenceManifestArtifacts(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const file of manifest.files) {
    if (file.kind !== "runtime-reference-manifest") {
      continue
    }

    let referenceManifest: unknown
    try {
      referenceManifest = JSON.parse(await readFile(join(directory, file.path), "utf8"))
    } catch (error) {
      violations.push({
        code: "malformed-reference",
        path: file.path,
        file: file.path,
        message: `Runtime reference manifest is not valid JSON: ${errorMessage(error)}`,
      })
      continue
    }

    if (!isRuntimeReferenceManifestShape(referenceManifest)) {
      violations.push({ code: "malformed-reference", path: file.path, file: file.path, message: "Runtime reference manifest does not match wp-codebox/runtime-reference-manifest/v1." })
      continue
    }

    const expectedDigest = runtimeReferenceManifestDigest(referenceManifest)
    if (referenceManifest.digest.value !== expectedDigest.value) {
      violations.push({ code: "digest-mismatch", path: `${file.path}:digest`, file: file.path, message: `Runtime reference manifest digest does not match declared refs: expected ${expectedDigest.value}, got ${referenceManifest.digest.value}` })
    }

    const expectedId = `runtime-reference-manifest-sha256-${referenceManifest.digest.value}`
    if (referenceManifest.id !== expectedId) {
      violations.push({ code: "bundle-id-mismatch", path: `${file.path}:id`, file: file.path, message: `Runtime reference manifest id must match its digest: expected ${expectedId}, got ${referenceManifest.id}` })
    }

    if (referenceManifest.artifactBundle.id !== manifest.id || referenceManifest.artifactBundle.digest.value !== manifest.contentDigest.value) {
      violations.push({ code: "review-evidence-mismatch", path: `${file.path}:artifactBundle`, file: file.path, message: "Runtime reference manifest artifactBundle ref must match manifest id and contentDigest." })
    }

    for (const [index, referencedFile] of referenceManifest.files.entries()) {
      validateArtifactReference(referencedFile.path, `${file.path}:files[${index}].path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referencedFile, `${file.path}:files[${index}].sha256`, violations)
    }

    if (referenceManifest.trace) {
      validateArtifactReference(referenceManifest.trace.path, `${file.path}:trace.path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referenceManifest.trace, `${file.path}:trace.sha256`, violations)
    }

    if (referenceManifest.events) {
      validateArtifactReference(referenceManifest.events.path, `${file.path}:events.path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referenceManifest.events, `${file.path}:events.sha256`, violations)
    }

    for (const [snapshotIndex, snapshot] of referenceManifest.snapshots.entries()) {
      for (const [refIndex, ref] of snapshot.artifactRefs.entries()) {
        if (typeof ref.path !== "string") {
          continue
        }
        validateArtifactReference(ref.path, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].path`, manifestFiles, violations)
        await verifyRuntimeEpisodeTraceRefFileDigest(directory, ref, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].digest`, violations)
      }
    }
  }
}

async function verifyRuntimeReplayReferenceIndexArtifacts(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const file of manifest.files) {
    if (file.kind !== "runtime-replay-index") {
      continue
    }

    let index: unknown
    try {
      index = JSON.parse(await readFile(join(directory, file.path), "utf8"))
    } catch (error) {
      violations.push({
        code: "malformed-reference",
        path: file.path,
        file: file.path,
        message: `Runtime replay reference index is not valid JSON: ${errorMessage(error)}`,
      })
      continue
    }

    if (!isRuntimeReplayReferenceIndexShape(index)) {
      violations.push({ code: "malformed-reference", path: file.path, file: file.path, message: "Runtime replay reference index does not match wp-codebox/runtime-replay-reference-index/v1." })
      continue
    }

    const expectedDigest = runtimeReplayReferenceIndexDigest(index)
    if (index.digest.value !== expectedDigest.value) {
      violations.push({ code: "digest-mismatch", path: `${file.path}:digest`, file: file.path, message: `Runtime replay reference index digest does not match declared refs: expected ${expectedDigest.value}, got ${index.digest.value}` })
    }

    const expectedId = `runtime-replay-reference-index-sha256-${index.digest.value}`
    if (index.id !== expectedId) {
      violations.push({ code: "bundle-id-mismatch", path: `${file.path}:id`, file: file.path, message: `Runtime replay reference index id must match its digest: expected ${expectedId}, got ${index.id}` })
    }

    if (index.artifactBundle.id !== manifest.id || index.artifactBundle.digest.value !== manifest.contentDigest.value) {
      violations.push({ code: "review-evidence-mismatch", path: `${file.path}:artifactBundle`, file: file.path, message: "Runtime replay reference index artifactBundle ref must match manifest id and contentDigest." })
    }

    for (const [key, referencedFile] of Object.entries(index.references)) {
      if (!referencedFile) {
        continue
      }
      validateArtifactReference(referencedFile.path, `${file.path}:references.${key}.path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referencedFile, `${file.path}:references.${key}.sha256`, violations)
    }

    for (const [observationIndex, observation] of index.observations.entries()) {
      for (const [refIndex, ref] of observation.artifactRefs.entries()) {
        if (typeof ref.path !== "string") {
          continue
        }
        validateArtifactReference(ref.path, `${file.path}:observations[${observationIndex}].artifactRefs[${refIndex}].path`, manifestFiles, violations)
        await verifyRuntimeEpisodeTraceRefFileDigest(directory, ref, `${file.path}:observations[${observationIndex}].artifactRefs[${refIndex}].digest`, violations)
      }
    }

    for (const [snapshotIndex, snapshot] of index.snapshots.entries()) {
      for (const [refIndex, ref] of snapshot.artifactRefs.entries()) {
        if (typeof ref.path !== "string") {
          continue
        }
        validateArtifactReference(ref.path, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].path`, manifestFiles, violations)
        await verifyRuntimeEpisodeTraceRefFileDigest(directory, ref, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].digest`, violations)
      }
    }
  }
}

async function verifyRuntimeEpisodeTraceRefFileDigest(directory: string, ref: RuntimeEpisodeTraceRef, path: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  if (!validDigest(ref.digest)) {
    violations.push({ code: "missing-file-hash", path, file: ref.path, message: `Runtime reference artifact ref must include a lowercase SHA-256 digest: ${ref.path ?? ref.id}` })
    return
  }

  if (typeof ref.path !== "string") {
    return
  }

  try {
    const value = createHash("sha256").update(await readFile(join(directory, ref.path))).digest("hex")
    if (value !== ref.digest.value) {
      violations.push({ code: "file-hash-mismatch", path, file: ref.path, message: `Runtime reference artifact ref hash does not match ${ref.path}: expected ${value}, got ${ref.digest.value}` })
    }
  } catch (error) {
    violations.push({ code: "file-hash-mismatch", path, file: ref.path, message: `Unable to hash runtime reference artifact ${ref.path}: ${errorMessage(error)}` })
  }
}

async function verifyReferencedFileDigest(directory: string, file: RuntimeReferenceManifestFileRef, path: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  if (!isArtifactFileDigestShape(file.sha256)) {
    violations.push({ code: "missing-file-hash", path, file: file.path, message: `Runtime reference manifest file ref must include a lowercase SHA-256 digest: ${file.path}` })
    return
  }

  try {
    const value = createHash("sha256").update(await readFile(join(directory, file.path))).digest("hex")
    if (value !== file.sha256.value) {
      violations.push({ code: "file-hash-mismatch", path, file: file.path, message: `Runtime reference manifest file ref hash does not match ${file.path}: expected ${value}, got ${file.sha256.value}` })
    }
  } catch (error) {
    violations.push({ code: "file-hash-mismatch", path, file: file.path, message: `Unable to hash runtime reference file ${file.path}: ${errorMessage(error)}` })
  }
}

async function verifyChangedFileEvidence(directory: string, changedFilesPath: string, review: Record<string, unknown>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  try {
    const changedFiles = JSON.parse(await readFile(join(directory, changedFilesPath), "utf8"))
    const changedFileList = isRecord(changedFiles) && Array.isArray(changedFiles.files) ? changedFiles.files : undefined
    const reviewChangedFiles = Array.isArray(review.changedFiles) ? review.changedFiles : undefined
    if (!changedFileList || !reviewChangedFiles) {
      return
    }

    const changedFileKeys = new Set(changedFileList.filter(isRecord).map((file) => `${file.path}:${file.status}`))
    for (const file of reviewChangedFiles.filter(isRecord)) {
      if (!changedFileKeys.has(`${file.path}:${file.status}`)) {
        violations.push({ code: "review-evidence-mismatch", path: "files/review.json:changedFiles", file: "files/review.json", message: `Review changed-file evidence is not present in ${changedFilesPath}: ${String(file.path)}` })
      }
    }
  } catch (error) {
    violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.changedFiles", file: changedFilesPath, message: `Unable to read changed-file evidence: ${errorMessage(error)}` })
  }
}

function validateArtifactReference(reference: string, fieldPath: string, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): void {
  const pathViolation = artifactPathViolation(reference, fieldPath)
  if (pathViolation) {
    violations.push(pathViolation)
    return
  }

  if (!manifestFiles.has(reference)) {
    violations.push({ code: "malformed-reference", path: fieldPath, file: reference, message: `Artifact reference is not listed in manifest.json: ${reference}` })
  }
}

function artifactReferenceStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
  }

  return []
}

async function listBundleFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await listBundleFiles(directory, path))
    } else {
      files.push(path)
    }
  }

  return files.sort()
}

function validDigest(value: unknown): value is RuntimeEpisodeContentDigest {
  return isRecord(value) && value.algorithm === "sha256" && typeof value.value === "string" && /^[a-f0-9]{64}$/.test(value.value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface Runtime {
  info(): Promise<RuntimeInfo>
  mount(spec: MountSpec): Promise<void>
  execute(spec: ExecutionSpec): Promise<ExecutionResult>
  observe(spec: ObservationSpec): Promise<ObservationResult>
  snapshot(): Promise<Snapshot>
  collectArtifacts(spec?: ArtifactSpec): Promise<ArtifactBundle>
  destroy(): Promise<void>
}

export interface RuntimeEpisodeSpec {
  runtime: RuntimeCreateSpec
  mounts?: MountSpec[]
  resetObservations?: ObservationSpec[]
  stepObservation?: ObservationSpec | false
  artifactSpec?: ArtifactSpec
}

export interface RuntimeEpisodeResetResult {
  id: string
  runtime: RuntimeInfo
  observations: ObservationResult[]
  observationRefs: RuntimeEpisodeTraceRef[]
}

export interface RuntimeEpisodeStepResult {
  id: string
  index: number
  action: RuntimeEpisodeActionRecord
  actionRef: RuntimeEpisodeTraceRef
  execution: ExecutionResult
  executionRef: RuntimeEpisodeTraceRef
  observation?: ObservationResult
  observationRef?: RuntimeEpisodeTraceRef
}

export interface RuntimeEpisodeTrace {
  schema: typeof RUNTIME_EPISODE_TRACE_SCHEMA
  version: 1
  id: string
  createdAt: string
  runtime: RuntimeInfo
  reset: RuntimeEpisodeResetResult
  steps: RuntimeEpisodeStepResult[]
  snapshots: Snapshot[]
  artifacts?: ArtifactBundle
  artifactRef?: RuntimeEpisodeTraceRef
}

export interface RuntimeEpisodeTraceValidationIssue {
  path: string
  message: string
}

export interface RuntimeEpisodeTraceValidationResult {
  valid: boolean
  schema: typeof RUNTIME_EPISODE_TRACE_SCHEMA
  issues: RuntimeEpisodeTraceValidationIssue[]
}

export interface RuntimeEpisode {
  reset(): Promise<RuntimeEpisodeResetResult>
  step(action: RuntimeEpisodeActionSpec, observation?: ObservationSpec | false): Promise<RuntimeEpisodeStepResult>
  observe(spec: ObservationSpec): Promise<ObservationResult>
  snapshot(): Promise<Snapshot>
  collectArtifacts(spec?: ArtifactSpec): Promise<ArtifactBundle>
  trace(): Promise<RuntimeEpisodeTrace>
  close(): Promise<void>
}

export interface RuntimeBackend {
  readonly kind: RuntimeBackendKind
  create(spec: RuntimeCreateSpec): Promise<Runtime>
  restore?(snapshot: Snapshot, spec?: RuntimeRestoreSpec): Promise<Runtime>
}

export async function createRuntime(spec: RuntimeCreateSpec, backend: RuntimeBackend): Promise<Runtime> {
  assertRuntimePolicy(spec.policy)

  if (backend.kind !== spec.backend) {
    throw new Error(`Backend ${backend.kind} cannot create runtime ${spec.backend}`)
  }

  return backend.create(spec)
}

export async function restoreRuntime(snapshot: Snapshot, backend: RuntimeBackend, spec?: RuntimeRestoreSpec): Promise<Runtime> {
  if (!backend.restore) {
    throw new Error(`Backend ${backend.kind} does not support runtime snapshot restore`)
  }

  return backend.restore(snapshot, spec)
}
