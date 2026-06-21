import { randomBytes } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { dirname, join, resolve } from "node:path"
import { HostToolRegistry, RUNTIME_EPISODE_OBSERVATION_SCHEMA, RUNTIME_EPISODE_SNAPSHOT_SCHEMA, assertRuntimeCommandAllowed, commandAgentRunResultJson, createCommandAgentRunResult, createHostToolRegistry, createRuntimeCommandResultEnvelope, parseCommandAgentRunRequest, resolveCommandPath, runtimeEpisodeDigest } from "@automattic/wp-codebox-core"
import { now, sha256 } from "@automattic/wp-codebox-core/internals"
import { recipeCommandDefinitions } from "@automattic/wp-codebox-core/contracts"
import { browserReviewSummary as browserArtifactReviewSummary, type BrowserArtifact } from "./browser-artifacts.js"
import { normalizeBrowserStorageStatePayload, wordpressFixtureUserStorageStatePhpCode, type WordPressFixtureUserSpec } from "./browser-auth-storage-state.js"
import { browserWordPressDiagnosticProvider, isBrowserCommandArtifactError, runBrowserActionsCommand, runBrowserProbeCommand, runBrowserScenarioCommand, runEditorActionsCommand, runEditorCanvasProbeCommand, runEditorOpenCommand, runHtmlCaptureCommand, runVisualCompareCommand, wordpressAdminAuthCookiePhpCode } from "./browser-command-runners.js"
import type { PluginCheckArtifact, ThemeCheckArtifact } from "./check-artifacts.js"
import { executePlaygroundCommand } from "./command-router.js"
import { firstCommandWordPressAdminAuthRequirement } from "./command-auth-requirements.js"
import { cleanWpCliOutput, shellArgv, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { observeHttpResponse as observeHttpResponseArtifact, observeWordPressState as observeWordPressStateArtifact } from "./observation-artifacts.js"
import { PlaygroundCommandCrashError, assertPlaygroundResponseOk, errorMessage, type PlaygroundRunResponse } from "./playground-command-errors.js"
import { startPlaygroundCliServer, type PlaygroundCliModule } from "./playground-cli-runner.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { collectPlaygroundArtifacts } from "./runtime-artifact-helpers.js"
import { materializePlaygroundMountsFromVfs } from "./mount-materialization.js"
import { runAbilityCommand, runBenchCommand, runCorePhpunitCommand, runHttpRequestCommand, runPhpCommand, runPhpunitCommand, runPluginCheckCommand, runPluginStateCommand, runRestRequestCommand, runThemeCheckCommand } from "./wordpress-command-runners.js"
import { PlaygroundSnapshotRestoreError, contentDigest, mountsFromSnapshot, runtimeSnapshotExportPayload, runtimeSnapshotExportPhp, runtimeSnapshotPayload, runtimeSnapshotRestorePhp, runtimeSpecFromSnapshot, snapshotDigest, type RuntimeSnapshotArtifact, type RuntimeSnapshotExportOptions } from "./runtime-snapshot.js"
import { createRuntimeWpCliBridge, type RuntimeWpCliBridge } from "./runtime-wp-cli-bridge.js"
import { writeReplayExportPackage } from "./replayable-wordpress-site-bundle.js"
import { preflightPhpWasmRuntimeAssets } from "./php-wasm-preflight.js"
import { previewReviewerAccess } from "./preview-reviewer-access.js"
import type {
  ArtifactBundle,
  ArtifactManifestFile,
  ArtifactPreview,
  ArtifactReviewerAuthBootstrap,
  ArtifactSpec,
  ExecutionResult,
  ExecutionSpec,
  LifecycleEvent,
  MountSpec,
  ObservationResult,
  ObservationSpec,
  Runtime,
  RuntimeBackend,
  RuntimeBackendProvider,
  BrowserStartupProgressEvent,
  RuntimeCreateSpec,
  RuntimeRestoreSpec,
  RuntimeEpisodeTraceRef,
  RuntimeInfo,
  RuntimeCommandResultEnvelope,
  Snapshot,
  RuntimeCheckpointResult,
  RuntimeCheckpointSpec,
  RuntimeCheckpointMetadata,
} from "@automattic/wp-codebox-core"
function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function commandExitCode(envelope: RuntimeCommandResultEnvelope | undefined): number {
  return envelope?.status === "error" ? 1 : 0
}

function commandEnvelopeStdout(envelope: RuntimeCommandResultEnvelope): string {
  if (typeof envelope.stdout === "string") {
    return envelope.stdout
  }
  return envelope.json === undefined ? "" : `${JSON.stringify(envelope.json, null, 2)}\n`
}

interface ReviewerAuthBootstrapRecord {
  expiresAt: string
  redirectUrl: string
  serverUrl: string
  userId: number
}

function reviewerAuthRedirectUrl(url: string | undefined, serverUrl: string): string | undefined {
  if (!url) {
    return undefined
  }

  try {
    return new URL(url, serverUrl).toString()
  } catch {
    return undefined
  }
}

function isLocalPreviewUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "")
    return hostname === "localhost" || hostname === "0.0.0.0" || hostname === "127.0.0.1" || hostname === "::1" || hostname.startsWith("127.")
  } catch {
    return false
  }
}

function reviewerAuthSetCookieHeader(cookie: { name?: string; value?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" }): string {
  const parts = [
    `${String(cookie.name ?? "")}=${String(cookie.value ?? "")}`,
    `Path=${typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/"}`,
    `Expires=${new Date((typeof cookie.expires === "number" ? cookie.expires : Math.floor(Date.now() / 1000) + 3600) * 1000).toUTCString()}`,
    "SameSite=Lax",
  ]
  if (cookie.httpOnly !== false) {
    parts.push("HttpOnly")
  }
  if (cookie.secure === true) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

export class PlaygroundRuntimeBackend implements RuntimeBackend {
  readonly kind = "wordpress-playground" as const

  constructor(private readonly options: PlaygroundRuntimeBackendOptions = {}) {}

  async create(spec: RuntimeCreateSpec): Promise<Runtime> {
    return PlaygroundRuntime.create(spec, this.options)
  }

  async restore(snapshot: Snapshot, spec: RuntimeRestoreSpec = {}): Promise<Runtime> {
    return PlaygroundRuntime.restore(snapshot, spec, this.options)
  }
}

export interface PlaygroundRuntimeBackendOptions {
  hostTools?: HostToolRegistry
  cliModule?: PlaygroundCliModule
}

class PlaygroundRuntime implements Runtime {
  private status: RuntimeInfo["status"] = "created"
  private readonly runtimeId = id("runtime")
  private readonly createdAt = now()
  private readonly mounts: MountSpec[] = []
  private readonly commands: ExecutionResult[] = []
  private readonly observations: ObservationResult[] = []
  private readonly snapshots: Snapshot[] = []
  private readonly checkpoints = new Map<string, { snapshot: Snapshot; metadata: RuntimeCheckpointMetadata }>()
  private readonly events: LifecycleEvent[] = []
  private readonly browserProbes: BrowserArtifact[] = []
  private readonly pluginChecks: PluginCheckArtifact[] = []
  private readonly themeChecks: ThemeCheckArtifact[] = []
  private readonly artifactRoot: string
  private readonly hostTools?: HostToolRegistry
  private cliServerPromise?: Promise<PlaygroundCliServer>
  private readonly activeExecutionAbortControllers = new Set<AbortController>()
  private activeExecutionSignal?: AbortSignal
  private reviewerAuthBootstrapRouteRegistered = false
  private readonly reviewerAuthBootstraps = new Map<string, ReviewerAuthBootstrapRecord>()

  private constructor(private readonly spec: RuntimeCreateSpec, private readonly backendOptions: PlaygroundRuntimeBackendOptions = {}) {
    this.artifactRoot = resolve(spec.artifactsDirectory ?? "artifacts", this.runtimeId)
    this.hostTools = spec.hostTools instanceof HostToolRegistry
      ? spec.hostTools
      : Array.isArray(spec.hostTools)
        ? createHostToolRegistry(spec.hostTools)
        : backendOptions.hostTools
  }

  static async create(spec: RuntimeCreateSpec, options: PlaygroundRuntimeBackendOptions = {}): Promise<PlaygroundRuntime> {
    const phpWasmRuntimeAssetPreflight = await preflightPhpWasmRuntimeAssets({ phpVersion: spec.environment.phpVersion })
    const runtime = new PlaygroundRuntime({
      ...spec,
      metadata: {
        ...(spec.metadata ?? {}),
        phpWasmRuntimeAssetPreflight,
      },
    }, options)
    await mkdir(runtime.artifactRoot, { recursive: true })
    runtime.recordEvent("runtime.created", {
      backend: "wordpress-playground",
      environment: spec.environment,
      policy: spec.policy,
      hostTools: runtime.hostTools?.list() ?? [],
      phpWasmRuntimeAssetPreflight,
    })
    return runtime
  }

  static async restore(snapshot: Snapshot, spec: RuntimeRestoreSpec = {}, options: PlaygroundRuntimeBackendOptions = {}): Promise<PlaygroundRuntime> {
    const payload = await runtimeSnapshotPayload(snapshot)
    if (payload.compatibility.backend !== "wordpress-playground") {
      throw new PlaygroundSnapshotRestoreError(`Snapshot backend is not compatible with WordPress Playground: ${payload.compatibility.backend}`)
    }

    const runtimeSpec = spec.runtime ?? runtimeSpecFromSnapshot(snapshot)
    const runtime = await PlaygroundRuntime.create(runtimeSpec, options)
    for (const mount of spec.mounts ?? mountsFromSnapshot(snapshot)) {
      await runtime.mount(mount)
    }

    await runtime.restoreSnapshotPayload(payload)
    runtime.recordEvent("runtime.snapshot.restored", {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      snapshotSchema: snapshot.schema ?? null,
    })
    return runtime
  }

  async info(): Promise<RuntimeInfo> {
    const previewUrl = await this.currentPreviewUrl()
    return {
      id: this.runtimeId,
      backend: "wordpress-playground",
      environment: this.spec.environment,
      createdAt: this.createdAt,
      status: this.status,
      ...(previewUrl ? { previewUrl } : {}),
    }
  }

  async mount(spec: MountSpec): Promise<void> {
    if (this.status === "destroyed") {
      throw new Error("Cannot mount into a destroyed runtime")
    }

    const mount = {
      ...spec,
      source: await realpath(spec.source),
    }

    this.mounts.push(mount)
    this.recordEvent("runtime.mounted", { mount })
  }

  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    assertRuntimeCommandAllowed(spec.command, this.spec.policy)

    const startedAt = now()
    const commandId = id("command")
    this.recordEvent("runtime.command.started", {
      id: commandId,
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? null,
      timeoutMs: spec.timeoutMs ?? null,
    })
    const abortController = new AbortController()
    this.activeExecutionAbortControllers.add(abortController)
    this.activeExecutionSignal = abortController.signal
    try {
      const output = await timeoutPlaygroundCommand(executePlaygroundCommand(this, spec, this.hostTools), spec, abortController)
      const envelope = typeof output === "string" ? undefined : output
      const result: ExecutionResult = {
        id: commandId,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: commandExitCode(envelope),
        stdout: typeof output === "string" ? output : commandEnvelopeStdout(output),
        stderr: envelope?.stderr ?? "",
        ...(envelope ? { result: envelope } : {}),
        ...(envelope?.diagnostics !== undefined ? { diagnostics: envelope.diagnostics } : {}),
        ...(envelope?.artifactRefs?.length ? { artifactRefs: envelope.artifactRefs } : {}),
        startedAt,
        finishedAt: now(),
      }

      this.commands.push(result)
      this.recordEvent("runtime.command.finished", {
        id: result.id,
        command: result.command,
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      })
      return result
    } catch (error) {
      const result: ExecutionResult = {
        id: commandId,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: 1,
        stdout: "",
        stderr: errorMessage(error),
        startedAt,
        finishedAt: now(),
      }

      this.commands.push(result)
      this.recordEvent("runtime.command.finished", {
        id: result.id,
        command: result.command,
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      })
      throw error
    } finally {
      this.activeExecutionAbortControllers.delete(abortController)
      if (this.activeExecutionSignal === abortController.signal) {
        this.activeExecutionSignal = undefined
      }
    }
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    const observationId = id("observation")
    const observedAt = now()
    const observed = await this.observeData(spec, observationId)
    const observation: ObservationResult = {
      schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
      id: observationId,
      type: spec.type,
      data: observed.data,
      observedAt,
      ...(observed.artifactRefs.length > 0 ? { artifactRefs: observed.artifactRefs } : {}),
      ...(observed.artifactManifestFiles.length > 0 ? { artifactManifestFiles: observed.artifactManifestFiles } : {}),
    }
    observation.digest = runtimeEpisodeDigest({
      schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
      type: observation.type,
      data: observation.data,
      observedAt: observation.observedAt,
      artifactRefs: observation.artifactRefs ?? [],
    })

    this.observations.push(observation)
    this.recordEvent("runtime.observed", {
      type: observation.type,
      observedAt: observation.observedAt,
    })
    return observation
  }

  async snapshot(options: RuntimeSnapshotExportOptions = {}): Promise<Snapshot> {
    const snapshotId = id("snapshot")
    const createdAt = now()
    const payload = await this.captureRuntimeSnapshotArtifact(snapshotId, createdAt, options)
    const artifactPath = `files/runtime-snapshots/${snapshotId}.json`
    const absoluteArtifactPath = join(this.artifactRoot, artifactPath)
    const artifactJson = `${JSON.stringify(payload, null, 2)}\n`
    await mkdir(dirname(absoluteArtifactPath), { recursive: true })
    await writeFile(absoluteArtifactPath, artifactJson)
    const artifactDigest = { algorithm: "sha256" as const, value: sha256(Buffer.from(artifactJson, "utf8")) }
    const snapshot: Snapshot = {
      schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
      id: snapshotId,
      createdAt,
      semantics: "runtime-state-artifact",
      metadata: {
        runtime: await this.info(),
        mounts: this.mounts,
        compatibility: payload.compatibility,
        artifact: {
          schema: payload.schema,
          path: artifactPath,
          absolutePath: absoluteArtifactPath,
          digest: artifactDigest,
        },
        hashes: payload.hashes,
        summary: {
          databaseTables: payload.database.tables.length,
          wpContentFiles: payload.files.length,
        },
        payload,
      },
      artifactRefs: [
        {
          kind: "runtime-snapshot-artifact",
          id: snapshotId,
          path: artifactPath,
          digest: artifactDigest,
        },
      ],
    }
    snapshot.digest = snapshotDigest(snapshot)

    this.recordEvent("runtime.snapshot.created", {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      artifactPath,
    })

    this.snapshots.push(snapshot)

    return snapshot
  }

  async createCheckpoint(spec: RuntimeCheckpointSpec): Promise<RuntimeCheckpointResult> {
    const name = normalizeCheckpointName(spec.name)
    const snapshot = await this.snapshot(spec.snapshotOptions as RuntimeSnapshotExportOptions | undefined)
    const summary = snapshot.metadata.summary && typeof snapshot.metadata.summary === "object" && !Array.isArray(snapshot.metadata.summary)
      ? snapshot.metadata.summary as Record<string, unknown>
      : undefined
    const checkpoint: RuntimeCheckpointMetadata = {
      name,
      snapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
      ...(summary ? { summary } : {}),
    }
    this.checkpoints.set(name, { snapshot, metadata: checkpoint })
    this.recordEvent("runtime.checkpoint.created", { checkpoint })
    return {
      schema: "wp-codebox/runtime-checkpoint-result/v1",
      status: "created",
      operation: "create",
      checkpoint,
    }
  }

  async restoreCheckpoint(name: string): Promise<RuntimeCheckpointResult> {
    const checkpointName = normalizeCheckpointName(name)
    const checkpointRecord = this.checkpoints.get(checkpointName)
    if (!checkpointRecord) {
      throw new PlaygroundSnapshotRestoreError(`Runtime checkpoint not found: ${checkpointName}`)
    }

    await this.restoreSnapshotPayload(await runtimeSnapshotPayload(checkpointRecord.snapshot))
    const checkpoint: RuntimeCheckpointMetadata = {
      ...checkpointRecord.metadata,
      restoredAt: now(),
    }
    checkpointRecord.metadata = checkpoint
    this.recordEvent("runtime.checkpoint.restored", { checkpoint })
    return {
      schema: "wp-codebox/runtime-checkpoint-result/v1",
      status: "restored",
      operation: "restore",
      checkpoint,
    }
  }

  async listCheckpoints(): Promise<RuntimeCheckpointResult> {
    return {
      schema: "wp-codebox/runtime-checkpoint-result/v1",
      status: "listed",
      operation: "list",
      checkpoints: [...this.checkpoints.values()].map((checkpoint) => checkpoint.metadata),
    }
  }

  private async captureRuntimeSnapshotArtifact(snapshotId: string, createdAt: string, options: RuntimeSnapshotExportOptions = {}): Promise<RuntimeSnapshotArtifact> {
    const server = await this.bootPlayground()
    const response = await this.runPlaygroundCommand("runtime.snapshot", server, {
      code: bootstrapPhpCode(this.spec, runtimeSnapshotExportPhp({ ...options, excludedWpContentPaths: [...this.snapshotExcludedWpContentPaths(), ...(options.excludedWpContentPaths ?? [])] }), []),
    })
    assertPlaygroundResponseOk("runtime.snapshot", response)
    const captured = await runtimeSnapshotExportPayload(server, response.text)
    const databaseDigest = contentDigest(captured.database)
    const filesDigest = contentDigest(captured.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })))

    return {
      schema: "wp-codebox/wordpress-runtime-snapshot/v1",
      version: 1,
      id: snapshotId,
      createdAt,
      ...captured,
      metadata: {
        ...captured.metadata,
        runtime: await this.info(),
        mounts: this.mounts,
        mountedInputs: this.mounts.map((mount) => ({ source: mount.source, target: mount.target, mode: mount.mode, type: mount.type })),
      },
      hashes: {
        database: databaseDigest,
        files: filesDigest,
      },
    }
  }

  private snapshotExcludedWpContentPaths(): string[] {
    return this.mounts.flatMap((mount) => {
      if (mount.mode !== "readonly") {
        return []
      }

      const relativePath = wpContentRelativePath(mount.target)
      return relativePath ? [relativePath] : []
    })
  }

  private async restoreSnapshotPayload(payload: RuntimeSnapshotArtifact): Promise<void> {
    const runtime = await this.info()
    if (runtime.backend !== payload.compatibility.backend) {
      throw new PlaygroundSnapshotRestoreError(`Snapshot backend ${payload.compatibility.backend} cannot be restored into ${runtime.backend}.`)
    }

    const response = await this.runPlaygroundCommand("runtime.snapshot.restore", await this.bootPlayground(), {
      code: bootstrapPhpCode(this.spec, runtimeSnapshotRestorePhp(payload), []),
    })
    assertPlaygroundResponseOk("runtime.snapshot.restore", response)
  }

  async collectArtifacts(spec: ArtifactSpec = {}): Promise<ArtifactBundle> {
    if (this.status !== "destroyed" && this.cliServerPromise) {
      const materialization = await materializePlaygroundMountsFromVfs(await this.cliServerPromise, this.mounts)
      if (materialization.materialized > 0 || materialization.deleted > 0 || materialization.skipped > 0) {
        this.recordEvent("runtime.mounts.materialized", { ...materialization })
      }
    }

    return collectPlaygroundArtifacts({
      artifactRoot: this.artifactRoot,
      runtimeId: this.runtimeId,
      createdAt: this.createdAt,
      spec: this.spec,
      mounts: this.mounts,
      commands: this.commands,
      observations: this.observations,
      snapshots: this.snapshots,
      events: this.events,
      info: () => this.info(),
      previewInfo: (createdAt, previewHoldSeconds, commands) => this.previewInfo(createdAt, previewHoldSeconds, commands),
      recordArtifactsCollected: (bundleId, createdAt, artifactSpec) => this.recordEvent("runtime.artifacts.collected", {
        id: bundleId,
        directory: this.artifactRoot,
        createdAt,
        spec: artifactSpec,
      }),
      browserProbes: this.browserProbes,
      pluginChecks: this.pluginChecks,
      themeChecks: this.themeChecks,
    }, spec)
  }

  async destroy(): Promise<void> {
    if (this.status === "destroyed") {
      return
    }

    this.status = "destroyed"
    for (const controller of this.activeExecutionAbortControllers) {
      controller.abort()
    }
    try {
      const cliServer = await this.cliServerPromise
      await cliServer?.[Symbol.asyncDispose]()
    } finally {
      this.recordEvent("runtime.destroyed", { runtimeId: this.runtimeId })
    }
  }

  private async currentPreviewUrl(): Promise<string | undefined> {
    if (this.status === "destroyed") {
      return undefined
    }

    if (!this.cliServerPromise) {
      return undefined
    }

    try {
      const server = await this.cliServerPromise
      return this.spec.preview?.publicUrl ?? server.serverUrl
    } catch {
      return undefined
    }
  }

  private async previewInfo(createdAt: string, holdSeconds = 0, commands: ExecutionResult[] = []): Promise<ArtifactPreview | undefined> {
    if (this.status === "destroyed") {
      return undefined
    }

    const server = await this.bootPlayground()
    const normalizedHoldSeconds = Math.max(0, Math.floor(holdSeconds))
    const expiresAt = normalizedHoldSeconds > 0 ? new Date(Date.now() + normalizedHoldSeconds * 1000).toISOString() : undefined
    const publicUrl = this.spec.preview?.publicUrl
    const siteUrl = this.spec.preview?.siteUrl

    const preview: ArtifactPreview = {
      url: publicUrl ?? server.serverUrl,
      ...(publicUrl ? { publicUrl, localUrl: server.serverUrl } : {}),
      ...(siteUrl ? { siteUrl } : {}),
      status: normalizedHoldSeconds > 0 ? "available" : "expired-on-completion",
      lifecycle: normalizedHoldSeconds > 0 ? "held-after-run" : "destroyed-on-completion",
      source: publicUrl ? "public-url-override" : "live-playground",
      createdAt,
      ...(expiresAt ? { expiresAt, holdSeconds: normalizedHoldSeconds } : {}),
    }

    const reviewerAuthBootstrap = expiresAt ? this.createReviewerAuthBootstrap(server, preview, expiresAt, commands) : undefined
    const previewWithBootstrap = {
      ...preview,
      ...(reviewerAuthBootstrap ? { reviewerAuthBootstrap } : {}),
    }
    return {
      ...previewWithBootstrap,
      reviewerAccess: previewReviewerAccess(previewWithBootstrap),
    }
  }

  private createReviewerAuthBootstrap(server: PlaygroundCliServer, preview: ArtifactPreview, expiresAt: string, commands: ExecutionResult[]): ArtifactReviewerAuthBootstrap | undefined {
    const authRequirement = firstCommandWordPressAdminAuthRequirement(commands)
    if (!authRequirement || !server.previewRoutes || !isLocalPreviewUrl(preview.localUrl ?? preview.url)) {
      return undefined
    }

    this.registerReviewerAuthBootstrapRoute(server)
    const token = randomBytes(24).toString("base64url")
    const userId = authRequirement.userId
    const redirectUrl = reviewerAuthRedirectUrl(authRequirement.redirectUrl, server.serverUrl) ?? server.serverUrl
    this.reviewerAuthBootstraps.set(token, {
      expiresAt,
      redirectUrl,
      serverUrl: server.serverUrl,
      userId,
    })

    const bootstrapUrl = new URL("/__wp-codebox/reviewer-auth-bootstrap", server.serverUrl)
    bootstrapUrl.searchParams.set("token", token)
    return {
      schema: "wp-codebox/reviewer-auth-bootstrap/v1",
      kind: "local-wordpress-admin-fixture",
      reviewerSafe: true,
      bootstrapUrl: bootstrapUrl.toString(),
      redirectUrl,
      expiresAt,
      evidence: {
        command: authRequirement.command.command,
        auth: "wordpress-admin",
        userId,
      },
    }
  }

  private registerReviewerAuthBootstrapRoute(server: PlaygroundCliServer): void {
    if (this.reviewerAuthBootstrapRouteRegistered || !server.previewRoutes) {
      return
    }

    this.reviewerAuthBootstrapRouteRegistered = true
    server.previewRoutes.add((incoming, outgoing) => this.handleReviewerAuthBootstrapRequest(server, incoming, outgoing))
  }

  private async handleReviewerAuthBootstrapRequest(server: PlaygroundCliServer, incoming: IncomingMessage, outgoing: ServerResponse): Promise<boolean> {
    const requestUrl = new URL(incoming.url ?? "/", server.serverUrl)
    if (requestUrl.pathname !== "/__wp-codebox/reviewer-auth-bootstrap") {
      return false
    }

    const token = requestUrl.searchParams.get("token") ?? ""
    const record = this.reviewerAuthBootstraps.get(token)
    if (!record || Date.parse(record.expiresAt) <= Date.now()) {
      this.writeReviewerAuthBootstrapResponse(outgoing, 410, "Reviewer auth bootstrap expired or unavailable.\n")
      return true
    }

    const response = await this.runPlaygroundCommand("reviewer-auth-bootstrap.auth", server, { code: bootstrapPhpCode(this.spec, wordpressAdminAuthCookiePhpCode([record.serverUrl], record.userId), []) })
    assertPlaygroundResponseOk("reviewer-auth-bootstrap.auth", response)
    const cookies = JSON.parse(cleanWpCliOutput(response.text)) as Array<{ name?: string; value?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" }>
    outgoing.writeHead(302, {
      "location": record.redirectUrl,
      "cache-control": "no-store",
      "set-cookie": cookies.map((cookie) => reviewerAuthSetCookieHeader(cookie)),
    })
    outgoing.end()
    return true
  }

  private writeReviewerAuthBootstrapResponse(outgoing: ServerResponse, status: number, message: string): void {
    const body = Buffer.from(message, "utf8")
    outgoing.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(body.byteLength),
      "cache-control": "no-store",
    })
    outgoing.end(body)
  }

  private recordEvent(type: LifecycleEvent["type"], data?: Record<string, unknown>): LifecycleEvent {
    const event: LifecycleEvent = {
      id: id("event"),
      type,
      timestamp: now(),
      ...(data ? { data } : {}),
    }

    this.events.push(event)
    return event
  }

  async runBrowserProbe(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runBrowserProbeCommand>>
    try {
      result = await runBrowserProbeCommand({ abortSignal: this.activeExecutionSignal, artifactRoot: this.artifactRoot, runtimeSpec: this.spec, runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options), server, spec, onProgress: (event) => this.recordEvent("runtime.browser-command-progress", { ...event, specCommand: spec.command }), diagnosticProviders: [browserWordPressDiagnosticProvider()] })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        this.browserProbes.push(error.artifact)
      }
      throw error
    }
    this.browserProbes.push(...(result.artifacts ?? [result.artifact]))
    return result.output
  }

  async runHtmlCapture(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runHtmlCaptureCommand>>
    try {
      result = await runHtmlCaptureCommand({ artifactRoot: this.artifactRoot, runtimeSpec: this.spec, runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options), server, spec })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        this.browserProbes.push(error.artifact)
      }
      throw error
    }
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runEditorCanvasProbe(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runEditorCanvasProbeCommand>>
    try {
      result = await runEditorCanvasProbeCommand({ artifactRoot: this.artifactRoot, runtimeSpec: this.spec, server, spec })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        this.browserProbes.push(error.artifact)
      }
      throw error
    }
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runBrowserActions(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runBrowserActionsCommand>>
    try {
      result = await runBrowserActionsCommand({ artifactRoot: this.artifactRoot, runtimeSpec: this.spec, runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options), server, spec, onProgress: (event) => this.recordEvent("runtime.browser-command-progress", { ...event, specCommand: spec.command }) })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        this.browserProbes.push(error.artifact)
      }
      throw error
    }
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runBrowserScenario(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runBrowserScenarioCommand>>
    try {
      result = await runBrowserScenarioCommand({ artifactRoot: this.artifactRoot, runtimeSpec: this.spec, runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options), server, spec })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        this.browserProbes.push(error.artifact)
      }
      throw error
    }
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runVisualCompare(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runVisualCompareCommand>>
    try {
      result = await runVisualCompareCommand({ artifactRoot: this.artifactRoot, runtimeSpec: this.spec, server, spec })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        this.browserProbes.push(error.artifact)
      }
      throw error
    }
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runEditorOpen(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const result = await runEditorOpenCommand({
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runEditorActions(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runEditorActionsCommand>>
    try {
      result = await runEditorActionsCommand({
        artifactRoot: this.artifactRoot,
        runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
        runtimeSpec: this.spec,
        server,
        spec,
      })
    } catch (error) {
      if (isBrowserCommandArtifactError(error)) {
        this.browserProbes.push(error.artifact)
      }
      throw error
    }
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runPhp(spec: ExecutionSpec): Promise<RuntimeCommandResultEnvelope | string> {
    const server = await this.bootPlayground()
    return runPhpCommand({
      createRuntimeWpCliBridge: (targetServer) => this.createRuntimeWpCliBridge(targetServer),
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runCommandAgent(spec: ExecutionSpec): Promise<RuntimeCommandResultEnvelope> {
    const request = parseCommandAgentRunRequest(spec.args ?? [])
    assertRuntimeCommandAllowed(request.command, this.spec.policy)
    const execution = await this.execute({
      command: request.command,
      args: request.args,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
    })
    const result = createCommandAgentRunResult({
      request,
      execution,
      runtime: await this.info(),
      environment: {
        runtimeEnvNames: Object.keys(this.spec.runtimeEnv ?? {}),
        secretEnvNames: Object.keys(this.spec.secretEnv ?? {}),
      },
    })
    return createRuntimeCommandResultEnvelope({
      status: result.exitCode === 0 ? "ok" : "error",
      stdout: commandAgentRunResultJson(result),
      stderr: result.stderr,
      json: result,
      ...(result.exitCode === 0 ? {} : { error: { code: "command-agent-run-target-failed", message: `Target command failed: ${result.target.command}` } }),
      diagnostics: result.diagnostics,
      artifactRefs: execution.result?.artifactRefs,
    })
  }

  async runWpCli(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const command = wpCliCommandFromArgs(spec.args ?? [])
    const argv = shellArgv(command)
    if (argv[0] === "wp") {
      argv.shift()
    }

    if (argv.length === 0) {
      throw new Error("wordpress.wp-cli requires a non-empty command")
    }

    if (!server.playground.writeFile) {
      throw new Error("wordpress.wp-cli requires a Playground backend with writeFile support")
    }

    const scriptPath = `/tmp/wp-codebox-wp-cli-${this.commands.length}.php`
    await server.playground.writeFile(scriptPath, wpCliPhpScript(argv))
    const response = await this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
    assertPlaygroundResponseOk("wordpress.wp-cli", response)

    return cleanWpCliOutput(response.text)
  }

  async runExportBrowserStorageState(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const outputDirectory = storageStateOutputDirectory(this.artifactRoot, stringArg(spec.args ?? [], "output-dir"))
    const providedStorageState = await storageStatePayloadFromArgs(spec.args ?? [])
    const payload = providedStorageState?.payload ?? await this.exportWordPressFixtureUserStorageState(spec, server)
    const normalized = normalizeBrowserStorageStatePayload(payload, providedStorageState?.source ?? "inline")
    if (normalized.summary.status !== "ready") {
      throw new Error(`wordpress.export-browser-storage-state returned unsupported storage state: ${JSON.stringify(normalized.summary.diagnostics)}`)
    }

    const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
    const exportedUser = envelope.user && typeof envelope.user === "object" && !Array.isArray(envelope.user) ? envelope.user as Record<string, unknown> : undefined
    const storageStatePath = join(outputDirectory, "storage-state.json")
    const summaryPath = join(outputDirectory, "summary.json")
    const storageStateArtifactPath = artifactRelativePath(this.artifactRoot, storageStatePath)
    const summaryArtifactPath = artifactRelativePath(this.artifactRoot, summaryPath)
    const storageStateJson = `${JSON.stringify(normalized.storageState, null, 2)}\n`
    const summary = {
      schema: "wp-codebox/browser-storage-state-export-summary/v1",
      status: "exported",
      storageState: normalized.summary,
      ...(exportedUser ? { user: storageStateUserSummary(exportedUser) } : {}),
      artifacts: {
        storageState: storageStateArtifactPath,
        summary: summaryArtifactPath,
      },
    }
    const summaryJson = `${JSON.stringify(summary, null, 2)}\n`

    await mkdir(outputDirectory, { recursive: true })
    await writeFile(storageStatePath, storageStateJson)
    await writeFile(summaryPath, summaryJson)

    const storageStateDigest = { algorithm: "sha256" as const, value: sha256(Buffer.from(storageStateJson, "utf8")) }
    const summaryDigest = { algorithm: "sha256" as const, value: sha256(Buffer.from(summaryJson, "utf8")) }

    return `${JSON.stringify({
      schema: "wp-codebox/browser-storage-state-export/v1",
      status: "exported",
      command: "wordpress.export-browser-storage-state",
      storageState: normalized.summary,
      ...(exportedUser ? { user: storageStateUserSummary(exportedUser) } : {}),
      artifacts: {
        storageState: storageStateArtifactPath,
        summary: summaryArtifactPath,
      },
      artifactRefs: [
        { kind: "browser-storage-state", path: storageStateArtifactPath, digest: storageStateDigest, redactionRequired: true },
        { kind: "browser-storage-state-summary", path: summaryArtifactPath, digest: summaryDigest },
      ],
    }, null, 2)}\n`
  }

  private async exportWordPressFixtureUserStorageState(spec: ExecutionSpec, server: PlaygroundCliServer): Promise<unknown> {
    const browserUrls = stringListArg(spec.args ?? [], "browser-urls") ?? [this.spec.preview?.publicUrl ?? server.serverUrl]
    const user = jsonObjectStringArg(spec.args ?? [], "user-json") as WordPressFixtureUserSpec
    const code = wordpressFixtureUserStorageStatePhpCode({ browserUrls, user })
    const response = await this.runPlaygroundCommand("wordpress.export-browser-storage-state", server, {
      code: bootstrapPhpCode(this.spec, code, spec.args ?? []),
    })
    assertPlaygroundResponseOk("wordpress.export-browser-storage-state", response)

    try {
      return JSON.parse(response.text)
    } catch (error) {
      throw new Error(`wordpress.export-browser-storage-state returned invalid JSON: ${errorMessage(error)}`)
    }
  }

  async runCaptureStateBundle(spec: ExecutionSpec): Promise<string> {
    const label = stringArg(spec.args ?? [], "label")
    const snapshotOptions = snapshotOptionsFromArgs(spec.args ?? [])
    const snapshot = await this.snapshot(snapshotOptions)
    const snapshotOptionsMetadata = hasSnapshotOptions(snapshotOptions) ? { snapshotOptions } : {}
    const summary = snapshot.metadata.summary && typeof snapshot.metadata.summary === "object" && !Array.isArray(snapshot.metadata.summary)
      ? snapshot.metadata.summary as Record<string, unknown>
      : {}

    return `${JSON.stringify({
      schema: "wp-codebox/wordpress-state-bundle-capture/v1",
      status: "captured",
      replayStatus: "replayable-runtime-state",
      ...(label ? { label } : {}),
      snapshot: {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        semantics: snapshot.semantics,
        digest: snapshot.digest,
        artifactRefs: snapshot.artifactRefs ?? [],
      },
      summary: {
        databaseTables: summary.databaseTables ?? 0,
        wpContentFiles: summary.wpContentFiles ?? 0,
        ...snapshotOptionsMetadata,
      },
    }, null, 2)}\n`
  }

  async runExportReplayPackage(spec: ExecutionSpec): Promise<string> {
    const label = stringArg(spec.args ?? [], "label")
    const landingPage = stringArg(spec.args ?? [], "landing-page")
    const outputDirectory = replayExportOutputDirectory(this.artifactRoot, stringArg(spec.args ?? [], "output-dir"))
    const importMs = nonNegativeIntegerStringArg(spec.args ?? [], "import-ms") ?? 0
    const snapshotOptions = snapshotOptionsFromArgs(spec.args ?? [])
    const snapshotOptionsMetadata = hasSnapshotOptions(snapshotOptions) ? { snapshotOptions } : {}

    const materializeStartedAtMs = Date.now()
    let materialization: Awaited<ReturnType<typeof materializePlaygroundMountsFromVfs>> | undefined
    if (this.status !== "destroyed" && this.cliServerPromise) {
      materialization = await materializePlaygroundMountsFromVfs(await this.cliServerPromise, this.mounts)
      if (materialization.materialized > 0 || materialization.deleted > 0 || materialization.skipped > 0) {
        this.recordEvent("runtime.mounts.materialized", { ...materialization, source: "wordpress.export-replay-package" })
      }
    }
    const materializeMs = Date.now() - materializeStartedAtMs

    const snapshotStartedAtMs = Date.now()
    const snapshot = await this.snapshot(snapshotOptions)
    const snapshotMs = Date.now() - snapshotStartedAtMs
    const payload = await runtimeSnapshotPayload(snapshot)

    const exportStartedAtMs = Date.now()
    const replayPackage = await writeReplayExportPackage(payload, {
      directory: outputDirectory,
      landingPage,
      importMs,
      materializeMs,
      snapshotMs,
      source: {
        ...(label ? { label } : {}),
        command: "wordpress.export-replay-package",
        runtimeId: this.runtimeId,
        snapshotId: snapshot.id,
        ...snapshotOptionsMetadata,
        artifactRoot: this.artifactRoot,
        ...(materialization ? { materialization } : {}),
      },
    })
    replayPackage.metrics.exportMs = Date.now() - exportStartedAtMs

    this.recordEvent("runtime.replay-package.exported", {
      directory: replayPackage.directory,
      metrics: replayPackage.metrics,
      artifacts: replayPackage.artifacts,
    })

    return `${JSON.stringify({
      schema: "wp-codebox/wordpress-replay-export/v1",
      status: replayPackage.status,
      ...(label ? { label } : {}),
      replayStatus: "replayable-runtime-state",
      directory: replayPackage.directory,
      metrics: replayPackage.metrics,
      artifacts: replayPackage.artifacts,
      manifest: {
        id: replayPackage.manifest.id,
        contentDigest: replayPackage.manifest.contentDigest,
        createdAt: replayPackage.manifest.createdAt,
      },
      ...snapshotOptionsMetadata,
    }, null, 2)}\n`
  }

  async runPluginCheck(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const result = await runPluginCheckCommand({
      artifactRoot: this.artifactRoot,
      runWpCliCommand: (targetServer, argv) => this.runWpCliCommand(targetServer, argv),
      server,
      spec,
    })
    this.pluginChecks.push(result.artifact)
    return result.output
  }

  async runPluginState(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runPluginStateCommand({
      runPlaygroundCommand: this.runPlaygroundCommand.bind(this),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runThemeCheck(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const result = await runThemeCheckCommand({
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runWpCliArgv: (targetServer, argv) => this.runWpCliArgv(targetServer, argv),
      runtimeSpec: this.spec,
      server,
      spec,
    })
    this.themeChecks.push(result.artifact)
    return result.output
  }

  private async runWpCliCommand(server: PlaygroundCliServer, argv: string[]): Promise<PlaygroundRunResponse> {
    if (!server.playground.writeFile) {
      throw new Error("WP-CLI commands require a Playground backend with writeFile support")
    }

    const scriptPath = `/tmp/wp-codebox-wp-cli-${this.commands.length}-${Date.now().toString(36)}.php`
    await server.playground.writeFile(scriptPath, wpCliPhpScript(argv))
    return this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
  }

  private async createRuntimeWpCliBridge(server: PlaygroundCliServer): Promise<RuntimeWpCliBridge> {
    return createRuntimeWpCliBridge((argv) => this.runWpCliCommand(server, argv))
  }

  async runAbility(spec: ExecutionSpec): Promise<RuntimeCommandResultEnvelope> {
    const server = await this.bootPlayground()
    return runAbilityCommand({
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runRestRequest(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runRestRequestCommand({
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runHttpRequest(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runHttpRequestCommand({
      baseUrl: this.spec.preview?.publicUrl ?? server.serverUrl,
      spec,
    })
  }

  async runBench(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runBenchCommand({
      browserProbes: this.browserProbes,
      createRuntimeWpCliBridge: (targetServer) => this.createRuntimeWpCliBridge(targetServer),
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runPhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runPhpunitCommand({
      artifactRoot: this.artifactRoot,
      mounts: this.mounts,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      server,
      spec,
    })
  }

  async runCorePhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runCorePhpunitCommand({
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      server,
      spec,
    })
  }

  private async runWpCliArgv(server: PlaygroundCliServer, argv: string[]): Promise<PlaygroundRunResponse> {
    if (!server.playground.writeFile) {
      throw new Error("WP-CLI commands require a Playground backend with writeFile support")
    }

    const scriptPath = `/tmp/wp-codebox-wp-cli-${this.commands.length}-${Date.now().toString(36)}.php`
    await server.playground.writeFile(scriptPath, wpCliPhpScript(argv))
    return this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
  }

  private async runPlaygroundCommand(command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }): Promise<PlaygroundRunResponse> {
    try {
      return await abortable(server.playground.run(options), this.activeExecutionSignal)
    } catch (error) {
      throw new PlaygroundCommandCrashError(command, error)
    }
  }

  async inspectMountedInputs(): Promise<string> {
    const server = await this.bootPlayground()
    const response = await server.playground.run({
      code: `<?php
$mounts = ${JSON.stringify(JSON.stringify(this.mounts))};
$inspected = array_map(function ($mount) {
    $target = $mount['target'];
    $entries = is_dir($target) ? array_values(array_diff(scandir($target), array('.', '..'))) : array(basename($target));
    sort($entries);

    return array(
        'target' => $target,
        'source' => $mount['source'],
        'entries' => $entries,
        'exists' => file_exists($target),
    );
}, json_decode($mounts, true));

echo json_encode(array('command' => 'inspect-mounted-inputs', 'mounts' => $inspected), JSON_PRETTY_PRINT);
`,
    })

    return response.text
  }

  private async bootPlayground(): Promise<PlaygroundCliServer> {
    if (!this.cliServerPromise) {
      this.cliServerPromise = this.startPlayground()
    }

    return this.cliServerPromise
  }

  private async startPlayground(): Promise<PlaygroundCliServer> {
    return startPlaygroundCliServer(this.spec, this.mounts, {
      onProgress: (event) => this.recordBrowserStartupProgress(event),
      cliModule: this.backendOptions.cliModule,
    })
  }

  private recordBrowserStartupProgress(event: BrowserStartupProgressEvent): void {
    this.recordEvent("runtime.browser-startup-progress", { event })
    void Promise.resolve(this.spec.onBrowserStartupProgress?.(event)).catch(() => undefined)
  }

  private async observeData(spec: ObservationSpec, observationId: string): Promise<{ data: unknown; artifactRefs: RuntimeEpisodeTraceRef[]; artifactManifestFiles: ArtifactManifestFile[] }> {
    const artifactRefs: RuntimeEpisodeTraceRef[] = []
    const artifactManifestFiles: ArtifactManifestFile[] = []

    if (spec.type === "command-result") {
      const command = spec.commandId ? this.commands.find((candidate) => candidate.id === spec.commandId) : this.commands.at(-1)
      return {
        data: command
          ? {
              id: command.id,
              command: command.command,
              args: command.args,
              exitCode: command.exitCode,
              stdout: command.stdout,
              stderr: command.stderr,
              ...(command.result ? { result: command.result } : {}),
              startedAt: command.startedAt,
              finishedAt: command.finishedAt,
            }
          : { commandId: spec.commandId ?? null, found: false },
        artifactRefs,
        artifactManifestFiles,
      }
    }

    if (spec.type === "wordpress-state") {
      return observeWordPressStateArtifact({ artifactRoot: this.artifactRoot, observationId, server: await this.bootPlayground(), spec, runtimeSpec: this.spec })
    }

    if (spec.type === "http-response") {
      return observeHttpResponseArtifact({ artifactRoot: this.artifactRoot, observationId, spec, url: await this.resolveObservationUrl(spec.url ?? spec.path ?? "/") })
    }

    if (spec.type === "browser-result") {
      return { data: browserArtifactReviewSummary(this.browserProbes) ?? { probes: [] }, artifactRefs, artifactManifestFiles }
    }

    if (spec.type === "runtime-events" || spec.type === "runtime-logs") {
      return { data: this.events, artifactRefs, artifactManifestFiles }
    }

    return { data: await this.observeStub(spec), artifactRefs, artifactManifestFiles }
  }

  private async observeStub(spec: ObservationSpec): Promise<unknown> {
    if (spec.type === "runtime-info") {
      return this.info()
    }

    if (spec.type === "mounts") {
      return this.mounts
    }

    return { type: spec.type, path: spec.path ?? null }
  }

  private async resolveObservationUrl(url: string): Promise<string> {
    if (/^https?:\/\//.test(url)) {
      return url
    }

    const previewUrl = await this.currentPreviewUrl()
    const baseUrl = previewUrl ?? (await this.bootPlayground()).serverUrl
    return new URL(url, baseUrl).toString()
  }

}

function normalizeCheckpointName(name: string): string {
  const normalized = name.trim()
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(normalized)) {
    throw new Error("Runtime checkpoint names must use 1-120 letters, numbers, dots, underscores, or hyphens.")
  }
  return normalized
}

export function createPlaygroundRuntimeBackend(options: PlaygroundRuntimeBackendOptions = {}): RuntimeBackend {
  return new PlaygroundRuntimeBackend(options)
}

export const playgroundRuntimeBackendProvider: RuntimeBackendProvider = {
  kind: "wordpress-playground",
  recipePolicy: {
    recipeCommands: recipeCommandDefinitions(),
    wordpressInstallModes: ["install-from-existing-files", "install-from-existing-files-if-needed", "do-not-attempt-installing"],
    runtimeOverlayKinds: ["bundled-library"],
    runtimeOverlayLibraries: ["php-ai-client"],
    runtimeOverlayStrategies: ["wordpress-scoped-bundle"],
  },
  createBackend(context = {}) {
    return createPlaygroundRuntimeBackend({ cliModule: context.cliModule as PlaygroundCliModule | undefined })
  },
}

function stringArg(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim()
  return value && value.length > 0 ? value : undefined
}

function nonNegativeIntegerStringArg(args: string[], name: string): number | undefined {
  const value = stringArg(args, name)
  if (!value) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function stringListArg(args: string[], name: string): string[] | undefined {
  const value = stringArg(args, name)
  if (!value) {
    return undefined
  }

  const values = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
  return values.length > 0 ? values : undefined
}

function jsonObjectStringArg(args: string[], name: string): Record<string, unknown> {
  const value = stringArg(args, name)
  if (!value) {
    return {}
  }

  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

async function storageStatePayloadFromArgs(args: string[]): Promise<{ payload: unknown; source: "inline" | "file" } | undefined> {
  const raw = stringArg(args, "storage-state")
  if (!raw) {
    return undefined
  }

  const source = raw.startsWith("@") ? "file" : "inline"
  const text = source === "file" ? await readFile(resolveCommandPath(raw.slice(1)), "utf8") : raw
  try {
    return { payload: JSON.parse(text), source }
  } catch (error) {
    throw new Error(`wordpress.export-browser-storage-state storage-state must be valid JSON: ${errorMessage(error)}`)
  }
}

function storageStateOutputDirectory(artifactRoot: string, requested: string | undefined): string {
  const relativePath = requested?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "files/browser-storage-state"
  if (relativePath.length === 0 || relativePath.includes("..")) {
    throw new Error("wordpress.export-browser-storage-state output-dir must be a relative path inside the runtime artifact root")
  }

  return join(artifactRoot, relativePath)
}

function artifactRelativePath(artifactRoot: string, absolutePath: string): string {
  return absolutePath.replace(artifactRoot, "").replace(/^\/+/, "")
}

function storageStateUserSummary(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: typeof user.id === "number" ? user.id : undefined,
    username: typeof user.username === "string" ? user.username : undefined,
    email: typeof user.email === "string" ? user.email : undefined,
    role: typeof user.role === "string" ? user.role : undefined,
    created: typeof user.created === "boolean" ? user.created : undefined,
  }
}

function snapshotOptionsFromArgs(args: string[]): RuntimeSnapshotExportOptions {
  const options: RuntimeSnapshotExportOptions = {}
  const includedWpContentPaths = stringListArg(args, "snapshot-include-wp-content")
  const excludedWpContentPaths = stringListArg(args, "snapshot-exclude-wp-content")
  const includedDatabaseTables = stringListArg(args, "snapshot-database-tables")
  const excludedDatabaseTables = stringListArg(args, "snapshot-exclude-database-tables")
  const includedOptionNames = stringListArg(args, "snapshot-option-names")
  const includedPostTypes = stringListArg(args, "snapshot-post-types")

  if (includedWpContentPaths) options.includedWpContentPaths = includedWpContentPaths
  if (excludedWpContentPaths) options.excludedWpContentPaths = excludedWpContentPaths
  if (includedDatabaseTables) options.includedDatabaseTables = includedDatabaseTables
  if (excludedDatabaseTables) options.excludedDatabaseTables = excludedDatabaseTables
  if (includedOptionNames) options.includedOptionNames = includedOptionNames
  if (includedPostTypes) options.includedPostTypes = includedPostTypes

  return options
}

function hasSnapshotOptions(options: RuntimeSnapshotExportOptions): boolean {
  return Object.keys(options).length > 0
}

function replayExportOutputDirectory(artifactRoot: string, requested: string | undefined): string {
  const relativePath = requested?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "files/replay-package"
  if (relativePath.length === 0 || relativePath.includes("..")) {
    throw new Error("wordpress.export-replay-package output-dir must be a relative path inside the runtime artifact root")
  }

  return join(artifactRoot, relativePath)
}

function wpContentRelativePath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "")
  const marker = "/wp-content/"
  const index = normalized.indexOf(marker)
  if (index < 0) {
    return undefined
  }

  const relative = normalized.slice(index + marker.length).replace(/^\/+|\/+$/g, "")
  return relative.length > 0 && !relative.includes("..") ? relative : undefined
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return operation
  }
  operation.catch(() => undefined)
  if (signal.aborted) {
    return Promise.reject(new Error("Runtime execution was aborted during cleanup"))
  }

  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Runtime execution was aborted during cleanup")), { once: true })
    }),
  ])
}

function timeoutPlaygroundCommand<T>(operation: Promise<T>, spec: ExecutionSpec, abortController: AbortController): Promise<T> {
  const timeoutMs = spec.timeoutMs
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation
  }

  operation.catch(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort()
        reject(new Error(`Runtime command ${spec.command} exceeded timeoutMs=${Math.round(timeoutMs)}`))
      }, Math.round(timeoutMs))
      timeout.unref()
    }),
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
}
