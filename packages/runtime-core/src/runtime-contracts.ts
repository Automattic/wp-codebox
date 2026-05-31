import { assertRuntimePolicy } from "./runtime-policy.js"
import type { RuntimePolicy } from "./runtime-policy.js"
import { SANDBOX_WORKSPACE_ROOT } from "./runtime-action-adapter.js"
import type { ArtifactSpec } from "./artifact-manifest.js"
import type {
  RUNTIME_EPISODE_ACTION_SCHEMA,
  RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
  RUNTIME_EPISODE_TRACE_SCHEMA,
} from "./runtime-episode-contracts.js"

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
  diagnosticsPath: string
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
