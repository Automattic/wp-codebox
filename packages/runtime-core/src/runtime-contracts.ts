import { assertRuntimePolicy } from "./runtime-policy.js"
import type { RuntimePolicy } from "./runtime-policy.js"
import { SANDBOX_WORKSPACE_ROOT } from "./runtime-action-adapter.js"
import type { ArtifactFileDigest, ArtifactManifestFile, ArtifactSpec, ArtifactViewerMetadata } from "./artifact-manifest.js"
import type { HostToolDefinition, HostToolRegistry } from "./host-tool-registry.js"
import type { BackendNeutralRuntimeProvenance, RuntimeWordPressAssetSpec, RuntimeWordPressEnvironmentSpec, RuntimeWordPressInstallModeContract, RuntimeWordPressProvenance } from "./runtime-neutral-contracts.js"
import type {
  RUNTIME_EPISODE_ACTION_SCHEMA,
  RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
  RUNTIME_EPISODE_TRACE_SCHEMA,
} from "./runtime-episode-contracts.js"
import type { PreviewLease, PreviewLeaseLifecycleStatus, PreviewReachabilityEvidence } from "./runtime-boundary-contracts.js"

export type RuntimeBackendKind = "wordpress-playground" | (string & {})

export type SandboxWorkspaceMode = "repo-backed" | "site-backed"

export interface EnvironmentSpec extends RuntimeWordPressEnvironmentSpec {}

export type RuntimeWordPressInstallMode = RuntimeWordPressInstallModeContract

export interface RuntimeAssetSpec extends RuntimeWordPressAssetSpec {}

export interface RuntimeCreateSpec {
  backend: RuntimeBackendKind
  environment: EnvironmentSpec
  policy: RuntimePolicy
  hostTools?: HostToolRegistry | HostToolDefinition[]
  artifactsDirectory?: string
  runtimeEnv?: Record<string, string>
  secretEnv?: Record<string, string>
  metadata?: Record<string, unknown>
  preview?: RuntimePreviewSpec
  onBrowserStartupProgress?: BrowserStartupProgressListener
}

export type BrowserStartupProgressPhase =
  | "preview:start"
  | "preview:loading-client"
  | "preview:loading-wordpress"
  | "preview:applying-blueprint"
  | "preview:installing-dependencies"
  | "preview:activating-dependencies"
  | "preview:connecting-client"
  | "preview:ready"
  | "preview:error"
  | (string & {})

export type BrowserStartupProgressStatus = "running" | "complete" | "failed"

export interface BrowserStartupProgressEvent {
  schema: "wp-codebox/browser-startup-progress/v1"
  phase: BrowserStartupProgressPhase
  status: BrowserStartupProgressStatus
  label?: string
  elapsed_ms?: number
  detail?: Record<string, unknown>
}

export type BrowserStartupProgressListener = (event: BrowserStartupProgressEvent) => void | Promise<void>

export interface RuntimePreviewSpec {
  publicUrl?: string
  siteUrl?: string
  port?: number
  bind?: string
  lease?: PreviewLease
  leaseProvider?: RuntimePreviewLeaseProvider
}

export interface RuntimePreviewLeaseProvider {
  acquire(request: RuntimePreviewLeaseAcquireRequest): Promise<PreviewLease> | PreviewLease
  probe?(lease: PreviewLease): Promise<RuntimePreviewLeaseProbeResult> | RuntimePreviewLeaseProbeResult
  release?(lease: PreviewLease, request: RuntimePreviewLeaseReleaseRequest): Promise<RuntimePreviewLeaseReleaseResult | void> | RuntimePreviewLeaseReleaseResult | void
}

export interface RuntimePreviewLeaseAcquireRequest {
  localUrl: string
  requestedPublicUrl?: string
  requestedSiteUrl?: string
  metadata?: Record<string, unknown>
}

export interface RuntimePreviewLeaseProbeResult {
  status: PreviewReachabilityEvidence["status"]
  lease?: PreviewLease
  reachability?: PreviewReachabilityEvidence
  evidence_refs?: Record<string, unknown>[]
  metadata?: Record<string, unknown>
}

export interface RuntimePreviewLeaseReleaseRequest {
  status: Extract<PreviewLeaseLifecycleStatus, "released"> | "failed"
  reason: "runtime-dispose" | "acquire-failed" | "probe-failed" | "startup-failed" | (string & {})
  error?: Record<string, unknown>
}

export interface RuntimePreviewLeaseReleaseResult {
  status: Extract<PreviewLeaseLifecycleStatus, "released"> | "unknown"
  released_at?: string
  evidence_refs?: Record<string, unknown>[]
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeMount {
  type?: "directory" | "file"
  source: string
  target: string
  mode?: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeRuntimeStack {
  mounts?: WorkspaceRecipeMount[]
}

export type WorkspaceRecipeRuntimeOverlayKind = string
export type WorkspaceRecipeRuntimeOverlayLibrary = string
export type WorkspaceRecipeRuntimeOverlayStrategy = string

export interface WorkspaceRecipeRuntimeOverlay {
  kind: WorkspaceRecipeRuntimeOverlayKind
  library: WorkspaceRecipeRuntimeOverlayLibrary
  source: string
  target?: string
  strategy: WorkspaceRecipeRuntimeOverlayStrategy
  bundle?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeRuntimeBackendPackage {
  kind: string
  source: string
  package?: string
  entrypoint?: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeDistributionSourceMount extends WorkspaceRecipeMount {
  role?: "wordpress-root" | "dependency" | "fixtures" | (string & {})
  ref?: string
}

export interface WorkspaceRecipeDistributionWordPress {
  root: string
  bootstrap?: "standard" | "custom" | "external" | (string & {})
  config?: string
  bootstrapFile?: string
}

export interface WorkspaceRecipeDistributionServiceFake {
  name: string
  source: string
  load?: "pre-bootstrap" | "mu-plugin" | "manual"
  sideEffectsArtifact?: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeDistributionRouteAlias {
  name?: string
  host?: string
  path?: string
  target: string
  targetType?: "wordpress-rest" | "wordpress-route" | "local-url" | (string & {})
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeDistributionStartupProbe {
  name: string
  type: "http" | "browser" | "wp-cli" | "php"
  url?: string
  command?: string
  code?: string
  expectStatus?: number
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeDistributionSetupArtifact {
  name: string
  type: "sql"
  source: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeDistributionArtifact {
  path: string
  kind?: "logs" | "probe-results" | "fake-side-effects" | "runtime" | (string & {})
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeDistributionSafety {
  network?: "deny" | "declared"
  allowedHosts?: string[]
  secretEnv?: string[]
}

export interface WorkspaceRecipeDistribution {
  name: string
  sourceMounts?: WorkspaceRecipeDistributionSourceMount[]
  wordpress: WorkspaceRecipeDistributionWordPress
  env?: Record<string, string | number | boolean | null>
  constants?: Record<string, string | number | boolean | null>
  serviceFakes?: WorkspaceRecipeDistributionServiceFake[]
  routeAliases?: WorkspaceRecipeDistributionRouteAlias[]
  setupArtifacts?: WorkspaceRecipeDistributionSetupArtifact[]
  startupProbes?: WorkspaceRecipeDistributionStartupProbe[]
  artifacts?: WorkspaceRecipeDistributionArtifact[]
  safety?: WorkspaceRecipeDistributionSafety
}

export interface WorkspaceRecipeStagedFile {
  source: string
  target: string
}

export interface WorkspaceRecipeSourcePackageArtifact {
  name?: string
  path?: string
  required?: boolean
}

export interface WorkspaceRecipeSourcePackage {
  name: string
  source: string
  target: string
  allow?: string[]
  deny?: string[]
  artifact?: boolean | WorkspaceRecipeSourcePackageArtifact
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeStep {
  command: string
  args?: string[]
  diagnostics?: RuntimeCommandDiagnosticsCaptureSpec
  allowFailure?: boolean
  advisory?: boolean
}

export interface RuntimeCommandDiagnosticsCaptureSpec {
  capture?: RuntimeCommandDiagnosticsCaptureKind[]
  maxItems?: number
  maxBytes?: number
}

export type RuntimeCommandDiagnosticsCaptureKind = "wpdb-queries"

export type WorkspaceRecipeFuzzCasePhase = "setup" | "action" | "assert" | "teardown"

export interface WorkspaceRecipeFuzzCaseInputDigest {
  algorithm: "sha256" | (string & {})
  value: string
}

export interface WorkspaceRecipeFuzzCaseReplayMetadata {
  seed?: string | number
  inputRef?: string
  notes?: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeFuzzCase {
  case_id: string
  input?: Record<string, unknown>
  inputHash?: WorkspaceRecipeFuzzCaseInputDigest
  metadata?: Record<string, unknown>
  phases: Partial<Record<WorkspaceRecipeFuzzCasePhase, WorkspaceRecipeStep[]>>
  artifacts?: WorkspaceRecipeDeclaredArtifact[]
  replay?: WorkspaceRecipeFuzzCaseReplayMetadata
}

export interface WorkspaceRecipeFuzzRun {
  schema: "wp-codebox/fuzz-run/v1"
  cases: WorkspaceRecipeFuzzCase[]
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeFixtureDatabaseReset {
  strategy?: "none" | "truncate-tables"
  tables?: string[]
}

export interface WorkspaceRecipeFixtureDatabase {
  name: string
  version: string
  source: string
  format?: "sql"
  reset?: WorkspaceRecipeFixtureDatabaseReset
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeFixtureUser {
  name: string
  userId?: number
  username?: string
  email?: string
  role?: string
  displayName?: string
  password?: string
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeSessionArtifact {
  kind: "browser-storage-state" | "cookie-jar" | "token" | (string & {})
  path?: string
  redactionRequired: true
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeUserSession {
  name: string
  user: string
  artifacts?: WorkspaceRecipeSessionArtifact[]
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeProbe {
  name: string
  step: WorkspaceRecipeStep
  expectJson?: boolean
  allowFailure?: boolean
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeDeclaredArtifact {
  name: string
  path: string
  required?: boolean
  parseJson?: boolean
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeTypedArtifact {
  name: string
  type: string
  path: string
  required?: boolean
  contentType?: string
  parseJson?: boolean
  payloadSchema?: string | Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipePluginRuntimePhp {
  memoryLimit?: string
  maxExecutionTime?: number
  iniEntries?: Record<string, string | number | boolean | null>
  bootstrapIniEntries?: Record<string, string | number | boolean | null>
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

export interface WorkspaceRecipeAgentBundle {
  source?: string
  bundle?: Record<string, unknown>
  slug?: string
  on_conflict?: "error" | "skip" | "upgrade"
  owner_id?: number
  token_env?: string
}

export interface WorkspaceRecipeExtraPlugin {
  source: string
  sourceRoot?: string
  sourceSubpath?: string
  originalSource?: string
  slug?: string
  pluginFile?: string
  activate?: boolean
  sha256?: string
  loadAs?: "plugin" | "mu-plugin"
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeComponentManifestEntry {
  slug?: string
  source?: string
  mountedPath?: string
  entrypoint?: string
  pluginFile?: string
  loadAs?: "plugin" | "mu-plugin"
  activate?: boolean
  contractIndex?: number
  requestedPath?: string
  provenance?: Record<string, unknown>
}

export interface WorkspaceRecipeComponentManifest {
  schema: "wp-codebox/component-manifest/v1"
  components?: WorkspaceRecipeComponentManifestEntry[]
  providers?: WorkspaceRecipeComponentManifestEntry[]
}

export interface WorkspaceRecipeDependencyOverlay {
  kind: "composer-package"
  package: string
  source: string
  consumer: string
  metadata?: Record<string, unknown>
}

export type WorkspaceRecipeSiteSeedType = "fixture" | "parent_site"
export type WorkspaceRecipeSiteSeedFormat = "json" | (string & {})
export type WorkspaceRecipeSiteSeedDeterministicIdStrategy = "platform-identifiers" | "numeric"
export type WorkspaceRecipeUnsupportedDeterministicIdPolicy = "block" | "warn"

export interface WorkspaceRecipeSiteSeedDeterministicIds {
  strategy: WorkspaceRecipeSiteSeedDeterministicIdStrategy
  onUnsupported: WorkspaceRecipeUnsupportedDeterministicIdPolicy
}

export interface WorkspaceRecipeSiteSeedBootstrapSite {
  domain: string
  path?: string
  title?: string
}

export interface WorkspaceRecipeSiteSeedBootstrapDomain {
  domain: string
  path?: string
  primary?: boolean
}

export interface WorkspaceRecipeSiteSeedBootstrap {
  multisite?: {
    enabled: boolean
    install?: "subdomain" | "subdirectory"
    sites?: WorkspaceRecipeSiteSeedBootstrapSite[]
  }
  domains?: WorkspaceRecipeSiteSeedBootstrapDomain[]
}

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
  deterministicIds?: WorkspaceRecipeSiteSeedDeterministicIds
  bootstrap?: WorkspaceRecipeSiteSeedBootstrap
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

export interface WorkspaceRecipeWorkspacePreloadRepository {
  name: string
  url: string
  ref?: string
}

export interface WorkspaceRecipeWorkspacePreload {
  type: "agent-runtime/workspace-preload"
  slug?: string
  source?: string
  payload: {
    schema: "agent-runtime/workspace-preload/v1"
    repositories: WorkspaceRecipeWorkspacePreloadRepository[]
    meta?: Record<string, unknown>
  }
  provenance?: Record<string, unknown>
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
  toolPolicy?: unknown
}

export interface WorkspaceRecipe {
  schema: "wp-codebox/workspace-recipe/v1"
  distribution?: WorkspaceRecipeDistribution
  runtime?: {
    backend?: RuntimeBackendKind
    name?: string
    wp?: string
    phpVersion?: string
    wordpressInstallMode?: RuntimeWordPressInstallMode
    blueprint?: unknown
    preview?: RuntimePreviewSpec
    assets?: RuntimeAssetSpec
    backendPackage?: WorkspaceRecipeRuntimeBackendPackage
    stack?: WorkspaceRecipeRuntimeStack
    overlays?: WorkspaceRecipeRuntimeOverlay[]
  }
  inputs?: {
    workspaces?: WorkspaceRecipeWorkspace[]
    workspace_preloads?: WorkspaceRecipeWorkspacePreload[]
    mounts?: WorkspaceRecipeMount[]
    extra_plugins?: WorkspaceRecipeExtraPlugin[]
    component_manifest?: WorkspaceRecipeComponentManifest
    dependency_overlays?: WorkspaceRecipeDependencyOverlay[]
    runtimeEnv?: Record<string, string>
    secretEnv?: string[]
    pluginRuntime?: WorkspaceRecipePluginRuntime
    fixtureDatabases?: WorkspaceRecipeFixtureDatabase[]
    fixtureUsers?: WorkspaceRecipeFixtureUser[]
    userSessions?: WorkspaceRecipeUserSession[]
    siteSeeds?: WorkspaceRecipeSiteSeed[]
    stagedFiles?: WorkspaceRecipeStagedFile[]
    sourcePackages?: WorkspaceRecipeSourcePackage[]
    agent_bundles?: WorkspaceRecipeAgentBundle[]
    inherit?: WorkspaceRecipeInheritanceRequest
    inheritance?: WorkspaceRecipeInheritanceResolution
  }
  workflow: {
    before?: WorkspaceRecipeStep[]
    steps: WorkspaceRecipeStep[]
    after?: WorkspaceRecipeStep[]
  }
  fuzzRun?: WorkspaceRecipeFuzzRun
  artifacts?: {
    directory?: string
    verify?: boolean | WorkspaceRecipeArtifactVerifier
    workspacePolicy?: boolean | WorkspaceRecipeWorkspacePolicyArtifact
    paths?: WorkspaceRecipeDeclaredArtifact[]
    typed?: WorkspaceRecipeTypedArtifact[]
  }
  probes?: WorkspaceRecipeProbe[]
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
  providerPluginPaths?: string[]
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
  diagnostics?: RuntimeCommandDiagnosticsCaptureSpec
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
  result?: RuntimeCommandResultEnvelope
  diagnostics?: unknown
  artifactRefs?: RuntimeEpisodeTraceRef[]
  startedAt: string
  finishedAt: string
}

export const RUNTIME_COMMAND_RESULT_SCHEMA = "wp-codebox/runtime-command-result/v1" as const

export type RuntimeCommandResultStatus = "ok" | "error" | (string & {})

export interface RuntimeCommandResultError {
  code: string
  message: string
  data?: unknown
}

export interface RuntimeCommandResultEnvelope {
  schema: typeof RUNTIME_COMMAND_RESULT_SCHEMA
  status: RuntimeCommandResultStatus
  stdout?: string
  stderr?: string
  json?: unknown
  diagnostics?: unknown
  artifactRefs?: RuntimeEpisodeTraceRef[]
  error?: RuntimeCommandResultError
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
  artifactManifestFiles?: ArtifactManifestFile[]
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
    | "runtime.browser-startup-progress"
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

export type RuntimeCheckpointOperation = "create" | "restore" | "list"

export interface RuntimeCheckpointSpec {
  name: string
  metadata?: Record<string, unknown>
  snapshotOptions?: unknown
}

export interface RuntimeCheckpointMetadata {
  name: string
  snapshotId: string
  createdAt: string
  restoredAt?: string
  metadata?: Record<string, unknown>
  summary?: Record<string, unknown>
}

export interface RuntimeCheckpointResult {
  schema: "wp-codebox/runtime-checkpoint-result/v1"
  status: "created" | "restored" | "listed"
  operation: RuntimeCheckpointOperation
  checkpoint?: RuntimeCheckpointMetadata
  checkpoints?: RuntimeCheckpointMetadata[]
}

export interface RuntimeCheckpointFailureDiagnostic {
  schema: "wp-codebox/runtime-checkpoint-failure/v1"
  status: "unsupported" | "not-found" | "invalid-request" | "failed"
  operation: RuntimeCheckpointOperation
  backend?: RuntimeBackendKind
  name?: string
  code: string
  message: string
  supported: false
}

export class RuntimeCheckpointError extends Error {
  readonly diagnostic: RuntimeCheckpointFailureDiagnostic

  constructor(diagnostic: RuntimeCheckpointFailureDiagnostic) {
    super(diagnostic.message)
    this.name = "RuntimeCheckpointError"
    this.diagnostic = diagnostic
  }

  toJSON(): RuntimeCheckpointFailureDiagnostic & { name: string } {
    return { ...this.diagnostic, name: this.name }
  }
}

export function runtimeCheckpointUnsupportedDiagnostic(operation: RuntimeCheckpointOperation, runtime?: RuntimeInfo, name?: string): RuntimeCheckpointFailureDiagnostic {
  const backend = runtime?.backend
  return {
    schema: "wp-codebox/runtime-checkpoint-failure/v1",
    status: "unsupported",
    operation,
    ...(backend ? { backend } : {}),
    ...(name ? { name } : {}),
    code: "runtime-checkpoints-unsupported",
    message: backend ? `Runtime backend does not support checkpoints: ${backend}` : "Runtime backend does not support checkpoints.",
    supported: false,
  }
}

export interface RuntimeRestoreSpec {
  runtime?: RuntimeCreateSpec
  mounts?: MountSpec[]
}

export interface ArtifactProvenance {
  task?: Record<string, unknown>
  workspace?: SandboxWorkspaceContract
  packages?: ArtifactPackageProvenance
  runtime: RuntimeWordPressProvenance
  agent?: Record<string, unknown>
  mounts: Array<{
    type: MountSpec["type"]
    source: string
    target: string
    mode: MountSpec["mode"]
    metadata?: Record<string, unknown>
  }>
}

export interface ArtifactPackageProvenance {
  schema: "wp-codebox/package-provenance/v1"
  wpCodebox?: ArtifactPackageIdentity
  runtimeCore?: ArtifactPackageIdentity
  runtimePlayground?: ArtifactPackageIdentity
  playground?: {
    cli?: ArtifactPackageIdentity
    wordpressBuilds?: ArtifactPackageIdentity
  }
  environment?: {
    wordpressVersion?: string
    phpVersion?: string
    nodeVersion?: string
  }
}

export interface BackendNeutralArtifactProvenance extends Omit<ArtifactProvenance, "runtime"> {
  runtime: BackendNeutralRuntimeProvenance
}

export interface ArtifactPackageIdentity {
  name: string
  version?: string
  source?: {
    ref?: string
    sha?: string
    digest?: ArtifactFileDigest
  }
}

export interface ArtifactEvidenceRef {
  path: string
  kind: string
  contentType?: string
  sha256?: ArtifactFileDigest
}

export interface ArtifactPreviewSessionEvidence {
  schema: "wp-codebox/preview-session-evidence/v1"
  artifactId: string
  createdAt: string
  session: {
    runtimeId: string
    backend: RuntimeBackendKind
    createdAt: string
    status: RuntimeInfo["status"]
    environment: {
      kind: string
      name?: string
      version?: string
      phpVersion?: string
    }
  }
  preview?: {
    status: ArtifactPreview["status"]
    lifecycle: ArtifactPreview["lifecycle"]
    source: ArtifactPreview["source"]
    createdAt: string
    expiresAt?: string
    holdSeconds?: number
    hasPublicUrl: boolean
    hasSiteUrl: boolean
    lease?: ArtifactPreviewLeaseSummary
    hasReviewerAuthBootstrap?: boolean
    reviewerAccess: ArtifactPreviewReviewerAccess
    blockers?: ArtifactPreviewBlocker[]
  }
  refs: {
    artifactBundle: {
      kind: "artifact-bundle"
      id: string
      digest: RuntimeEpisodeContentDigest
    }
    manifest: ArtifactEvidenceRef
    review: ArtifactEvidenceRef
    runtimeEvents: ArtifactEvidenceRef
    runtimeLog: ArtifactEvidenceRef
    runtimeReferenceManifest: ArtifactEvidenceRef
    runtimeReplayReferenceIndex: ArtifactEvidenceRef
    browserSummary?: ArtifactEvidenceRef
    durablePreview?: ArtifactEvidenceRef
  }
  components?: ArtifactPackageProvenance
}

export interface ArtifactPreview {
  url: string
  localUrl?: string
  publicUrl?: string
  siteUrl?: string
  lease?: PreviewLease
  status: "available" | "expired-on-completion"
  lifecycle: "held-after-run" | "destroyed-on-completion"
  source: "live-playground" | "public-url-override"
  createdAt: string
  expiresAt?: string
  holdSeconds?: number
  blockers?: ArtifactPreviewBlocker[]
  reviewerAuthBootstrap?: ArtifactReviewerAuthBootstrap
  reviewerAccess?: ArtifactPreviewReviewerAccess
}

export interface ArtifactPreviewReviewerAccess {
  schema: "wp-codebox/preview-reviewer-access/v1"
  status: "ready" | "blocked" | "unavailable"
  outcome: "public" | "local" | "bootstrap" | "blocked" | "auth-required"
  mode: "direct-url" | "auth-bootstrap" | "none"
  reviewerSafe: boolean
  openUrl?: string
  targetUrl?: string
  expiresAt?: string
  lease?: ArtifactPreviewLeaseSummary
  bootstrap?: ArtifactReviewerAuthBootstrap
  blockers?: ArtifactPreviewBlocker[]
  reason?: string
}

export interface ArtifactPreviewLeaseSummary {
  schema: "wp-codebox/preview-lease-summary/v1"
  status: PreviewLeaseLifecycleStatus
  publicUrl?: string
  localUrl?: string
  siteUrl?: string
  expiresAt?: string
  owner?: string
  provider?: string
  alignmentStatus?: string
  reachabilityStatus?: string
  reviewerSafe: boolean
}

export interface ArtifactReviewerAuthBootstrap {
  schema: "wp-codebox/reviewer-auth-bootstrap/v1"
  kind: "local-wordpress-admin-fixture"
  reviewerSafe: true
  bootstrapUrl: string
  redirectUrl: string
  expiresAt: string
  evidence: {
    command: string
    auth: "wordpress-admin"
    userId: number
  }
}

export interface ArtifactPreviewBlocker {
  schema: "wp-codebox/preview-blocker/v1"
  kind: "unsupported-preview"
  code: "external-wordpress-admin-auth-unavailable" | (string & {})
  message: string
  retryable: false
  reviewerSafe: false
  evidence: {
    command: string
    auth: "wordpress-admin" | (string & {})
  }
}

export interface ArtifactPreviewUrlRef {
  kind: "preview-url"
  availability: "reviewer-safe" | "local-only" | "unavailable"
  reviewerSafe: boolean
  url?: string
  reason?: string
}

export interface ArtifactDurablePreviewRef {
  kind: "artifact-preview"
  reviewerSafe: true
  durable: true
  entrypoint: string
  manifest: ArtifactEvidenceRef
  source: {
    kind: "browser-runtime-artifact-bundle"
    probe: number
    schema?: string
    root?: string
    entrypoint?: string
  }
  files: ArtifactEvidenceRef[]
}

export interface ArtifactPreviewEvidence {
  schema: "wp-codebox/preview-evidence/v1"
  createdAt: string
  session: {
    kind: "browser-playground-session"
    id: string
    runtimeId: string
    backend: RuntimeBackendKind
    environment: {
      kind: EnvironmentSpec["kind"]
      name: string
      version: string
    }
  }
  run: RuntimeEpisodeTraceRef
  preview: {
    status: ArtifactPreview["status"] | "unavailable"
    lifecycle: ArtifactPreview["lifecycle"] | "not-started"
    source?: ArtifactPreview["source"]
    createdAt?: string
    expiresAt?: string
    holdSeconds?: number
    lease?: ArtifactPreviewLeaseSummary
    url: ArtifactPreviewUrlRef
    publicUrl?: ArtifactPreviewUrlRef
    localUrl?: ArtifactPreviewUrlRef
    siteUrl?: ArtifactPreviewUrlRef
    durablePreview?: ArtifactDurablePreviewRef
    reviewerAccess: ArtifactPreviewReviewerAccess
  }
  readiness: {
    ready: boolean
    status: BrowserStartupProgressEvent["status"] | "not-started"
    phase?: BrowserStartupProgressEvent["phase"]
    events: Array<{
      id: string
      phase: BrowserStartupProgressEvent["phase"]
      status: BrowserStartupProgressEvent["status"]
      label?: string
      elapsed_ms?: number
      timestamp: string
    }>
  }
  components: {
    packages?: ArtifactPackageProvenance
    runtime: {
      backend: RuntimeBackendKind
      wordpressVersion?: string
    }
  }
}

export interface ArtifactBundle {
  id: string
  directory: string
  manifestPath: string
  metadataPath: string
  blueprintAfterPath: string
  blueprintAfterViewer?: ArtifactViewerMetadata
  blueprintAfterNotesPath: string
  eventsPath: string
  commandsPath: string
  observationsPath: string
  runtimeLogPath: string
  commandsLogPath: string
  mountsPath: string
  capturedMountsPath: string
  diffsPath: string
  workspacePatchPath: string
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
  previewEvidencePath?: string
  previewSessionEvidencePath?: string
  previewSessionEvidenceRef?: ArtifactEvidenceRef
  durablePreviewPath?: string
  durablePreview?: ArtifactDurablePreviewRef
  preview?: ArtifactPreview
  contentDigest: string
  createdAt: string
}

export interface Runtime {
  info(): Promise<RuntimeInfo>
  mount(spec: MountSpec): Promise<void>
  execute(spec: ExecutionSpec): Promise<ExecutionResult>
  observe(spec: ObservationSpec): Promise<ObservationResult>
  snapshot(options?: unknown): Promise<Snapshot>
  createCheckpoint?(spec: RuntimeCheckpointSpec): Promise<RuntimeCheckpointResult>
  restoreCheckpoint?(name: string): Promise<RuntimeCheckpointResult>
  listCheckpoints?(): Promise<RuntimeCheckpointResult>
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
