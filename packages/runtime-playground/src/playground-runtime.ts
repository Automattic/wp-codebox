import { randomBytes } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { dirname, join, resolve } from "node:path"
import { HostToolRegistry, PREVIEW_LEASE_SCHEMA, RUNTIME_EPISODE_OBSERVATION_SCHEMA, RUNTIME_EPISODE_SNAPSHOT_SCHEMA, assertRuntimeCommandAllowed, commandAgentRunResultJson, createCommandAgentRunResult, createHostToolRegistry, createRuntimeCommandResultEnvelope, parseCommandAgentRunRequest, previewLease, resolveCommandPath, runtimeCommandResultEnvelopeFromOutput, runtimeEpisodeDigest } from "@automattic/wp-codebox-core"
import { now, sha256 } from "@automattic/wp-codebox-core/internals"
import { recipeCommandDefinitions } from "@automattic/wp-codebox-core/contracts"
import { browserReviewSummary as browserArtifactReviewSummary, type BrowserArtifact } from "./browser-artifacts.js"
import { normalizeBrowserStorageStatePayload, wordpressFixtureUserStorageStatePhpCode, type WordPressFixtureUserSpec } from "./browser-auth-storage-state.js"
import { adminFuzzInputFromArgs, adminFuzzPhpCode } from "./admin-fuzz-command-handlers.js"
import { adminActionInputFromArgs, adminActionPhpCode } from "./admin-action-command-handlers.js"
import { browserWordPressDiagnosticProvider, isBrowserCommandArtifactError, runBrowserActionsCommand, runBrowserProbeCommand, runBrowserScenarioCommand, runEditorActionsCommand, runEditorCanvasProbeCommand, runEditorOpenCommand, runEditorValidateBlocksCommand, runHtmlCaptureCommand, runVisualCompareCommand, wordpressAdminAuthCookiePhpCode } from "./browser-command-runners.js"
import type { PluginCheckArtifact, ThemeCheckArtifact } from "./check-artifacts.js"
import { executePlaygroundCommand } from "./command-router.js"
import { firstCommandWordPressAdminAuthRequirement } from "./command-auth-requirements.js"
import { argValue, cleanWpCliOutput, shellArgv, wordpressBlockExerciseInputFromArgs, wordpressBlockExercisePhpCode, wordpressCrudOperationFromArgs, wordpressCrudOperationPhpCode, wordpressDbOperationFromArgs, wordpressDbOperationPhpCode, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { observeHttpResponse as observeHttpResponseArtifact, observeWordPressState as observeWordPressStateArtifact } from "./observation-artifacts.js"
import { PlaygroundCommandCrashError, assertPlaygroundResponseOk, errorMessage, type PlaygroundRunResponse } from "./playground-command-errors.js"
import { startPlaygroundCliServer, type PlaygroundCliModule } from "./playground-cli-runner.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { collectPlaygroundArtifacts } from "./runtime-artifact-helpers.js"
import { materializePlaygroundMountsFromVfs, materializePlaygroundStagedInputs } from "./mount-materialization.js"
import { runAbilityCommand, runAdminActionInventoryCommand, runBenchCommand, runCacheChurnObservationCommand, runCorePhpunitCommand, runHttpRequestCommand, runPageLoadCommand, runPhpCommand, runPhpunitCommand, runPluginCheckCommand, runPluginSetupCommand, runPluginStateCommand, runRestPerformanceObservationCommand, runRestRequestCommand, runRuntimeDiscoveryCommand, runRuntimeInventoryCommand, runServerPageLoadCommand, runThemeCheckCommand, runThemeSetupCommand, runWordPressExecutionActionCommand } from "./wordpress-command-runners.js"
import { PlaygroundSnapshotRestoreError, contentDigest, mountsFromSnapshot, runtimeSnapshotExportPayload, runtimeSnapshotExportPhp, runtimeSnapshotPayload, runtimeSnapshotRestorePhp, runtimeSpecFromSnapshot, snapshotDigest, type RuntimeSnapshotArtifact, type RuntimeSnapshotExportOptions } from "./runtime-snapshot.js"
import { createRuntimeWpCliBridge, type RuntimeWpCliBridge } from "./runtime-wp-cli-bridge.js"
import { writeReplayExportPackage } from "./replayable-wordpress-site-bundle.js"
import { preflightPhpWasmRuntimeAssets } from "./php-wasm-preflight.js"
import { previewReviewerAccess } from "./preview-reviewer-access.js"
import { wordpressActionAuthNoncePhpCode, wordpressFixtureUserWithoutPassword, wordpressUserSessionFromCommandArgs, type WordPressUserSessionResolution } from "./wordpress-user-sessions.js"
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
  PreviewLease,
  Snapshot,
  RuntimeCheckpointResult,
  RuntimeCheckpointSpec,
  RuntimeCheckpointMetadata,
} from "@automattic/wp-codebox-core"
function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function pluginModuleOptionsTablesInventoryPhpCode(): string {
  return `<?php
global $wpdb;
$wp_codebox_plugin_inventory_options = array();
$wp_codebox_plugin_inventory_core_prefixes = array('siteurl', 'home', 'blogname', 'blogdescription', 'users_can_register', 'admin_email', 'start_of_week', 'use_balanceTags', 'use_smilies', 'require_name_email', 'comments_notify', 'posts_per_rss', 'rss_use_excerpt', 'default_category', 'default_comment_status', 'default_ping_status', 'default_pingback_flag', 'posts_per_page', 'date_format', 'time_format', 'links_updated_date_format', 'comment_moderation', 'moderation_notify', 'permalink_structure', 'rewrite_rules', 'stylesheet', 'template', 'current_theme', 'active_plugins', 'recently_activated', 'sidebars_widgets', 'widget_', 'theme_mods_', 'cron', 'db_version', 'initial_db_version', 'WPLANG');
function wp_codebox_plugin_inventory_is_core_option(string $name, array $core_prefixes): bool {
    foreach ($core_prefixes as $prefix) {
        if ($name === $prefix || str_starts_with($name, $prefix)) {
            return true;
        }
    }
    return false;
}
function wp_codebox_plugin_inventory_value_shape($value): array {
    $serialized = is_string($value) && is_serialized($value);
    $decoded = $serialized ? maybe_unserialize($value) : $value;
    $type = gettype($decoded);
    return array('type' => $type, 'serialized' => $serialized, 'bytes' => is_string($value) ? strlen($value) : strlen(wp_json_encode($value)), 'itemCount' => is_array($decoded) ? count($decoded) : null);
}
$wp_codebox_plugin_inventory_rows = $wpdb->get_results("SELECT option_name, option_value, autoload FROM {$wpdb->options} ORDER BY option_name ASC LIMIT 500", ARRAY_A);
foreach ((array) $wp_codebox_plugin_inventory_rows as $wp_codebox_plugin_inventory_row) {
    $wp_codebox_plugin_inventory_name = (string) ($wp_codebox_plugin_inventory_row['option_name'] ?? '');
    if ($wp_codebox_plugin_inventory_name === '' || wp_codebox_plugin_inventory_is_core_option($wp_codebox_plugin_inventory_name, $wp_codebox_plugin_inventory_core_prefixes)) {
        continue;
    }
    $wp_codebox_plugin_inventory_options[] = array('name' => $wp_codebox_plugin_inventory_name, 'autoload' => (string) ($wp_codebox_plugin_inventory_row['autoload'] ?? ''), 'valueShape' => wp_codebox_plugin_inventory_value_shape($wp_codebox_plugin_inventory_row['option_value'] ?? ''), 'safety' => array('read' => true, 'update' => false, 'reason' => 'read_only_inventory'));
    if (count($wp_codebox_plugin_inventory_options) >= 100) {
        break;
    }
}
$wp_codebox_plugin_inventory_core_tables = array();
foreach ((array) $wpdb->tables('all') as $wp_codebox_plugin_inventory_base_table) {
    $wp_codebox_plugin_inventory_core_tables[(string) $wp_codebox_plugin_inventory_base_table] = true;
    $wp_codebox_plugin_inventory_core_tables[$wpdb->prefix . $wp_codebox_plugin_inventory_base_table] = true;
}
$wp_codebox_plugin_inventory_tables = array();
$wp_codebox_plugin_inventory_table_names = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($wpdb->prefix) . '%'));
foreach ((array) $wp_codebox_plugin_inventory_table_names as $wp_codebox_plugin_inventory_table_name) {
    $wp_codebox_plugin_inventory_table_name = (string) $wp_codebox_plugin_inventory_table_name;
    if (isset($wp_codebox_plugin_inventory_core_tables[$wp_codebox_plugin_inventory_table_name])) {
        continue;
    }
    $wp_codebox_plugin_inventory_columns = array();
    $wp_codebox_plugin_inventory_safe_table = str_replace('\`', '\`\`', $wp_codebox_plugin_inventory_table_name);
    foreach ((array) $wpdb->get_results('DESCRIBE \`' . $wp_codebox_plugin_inventory_safe_table . '\`', ARRAY_A) as $wp_codebox_plugin_inventory_column) {
        $wp_codebox_plugin_inventory_columns[] = array('name' => (string) ($wp_codebox_plugin_inventory_column['Field'] ?? ''), 'type' => (string) ($wp_codebox_plugin_inventory_column['Type'] ?? ''), 'nullable' => strtoupper((string) ($wp_codebox_plugin_inventory_column['Null'] ?? '')) === 'YES', 'key' => (string) ($wp_codebox_plugin_inventory_column['Key'] ?? ''));
    }
    $wp_codebox_plugin_inventory_tables[] = array('name' => $wp_codebox_plugin_inventory_table_name, 'baseName' => str_starts_with($wp_codebox_plugin_inventory_table_name, $wpdb->prefix) ? substr($wp_codebox_plugin_inventory_table_name, strlen($wpdb->prefix)) : $wp_codebox_plugin_inventory_table_name, 'columns' => $wp_codebox_plugin_inventory_columns, 'safety' => array('read' => true, 'write' => false, 'reason' => 'read_only_inventory'));
    if (count($wp_codebox_plugin_inventory_tables) >= 100) {
        break;
    }
}
echo wp_json_encode(array('schema' => 'wp-codebox/wordpress-plugin-module-options-tables-inventory/v1', 'command' => 'wordpress.inventory-plugin-module-options-tables', 'status' => 'ok', 'options' => $wp_codebox_plugin_inventory_options, 'tables' => $wp_codebox_plugin_inventory_tables, 'totals' => array('options' => count($wp_codebox_plugin_inventory_options), 'tables' => count($wp_codebox_plugin_inventory_tables)), 'diagnostics' => array(), 'artifactRefs' => array()), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function commandExitCode(envelope: RuntimeCommandResultEnvelope | undefined): number {
  return envelope?.status === "error" ? 1 : 0
}

function previewAlignment(publicUrl: string | undefined, siteUrl: string | undefined, localUrl: string, checkedAt: string): PreviewLease["alignment"] {
  const previewMatchesSite = originsMatch(publicUrl, siteUrl)
  const previewMatchesLocal = originsMatch(publicUrl, localUrl)
  return {
    status: previewMatchesSite === undefined ? "unknown" : (previewMatchesSite ? "aligned" : "misaligned"),
    checked_at: checkedAt,
    ...(previewMatchesSite === undefined ? {} : { preview_matches_site: previewMatchesSite }),
    ...(previewMatchesLocal === undefined ? {} : { preview_matches_local: previewMatchesLocal }),
    evidence: {
      publicUrlDeclared: Boolean(publicUrl),
      siteUrlDeclared: Boolean(siteUrl),
      localUrlDeclared: Boolean(localUrl),
    },
  }
}

function originsMatch(left: string | undefined, right: string | undefined): boolean | undefined {
  if (!left || !right) {
    return undefined
  }

  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function commandEnvelopeStdout(envelope: RuntimeCommandResultEnvelope): string {
  if (typeof envelope.stdout === "string") {
    return envelope.stdout
  }
  return envelope.json === undefined ? "" : `${JSON.stringify(envelope.json, null, 2)}\n`
}

function runtimeCommandTiming(startedAt: string, finishedAt: string): { startedAt: string; finishedAt: string; durationMs: number } {
  return {
    startedAt,
    finishedAt,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
  }
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

  async materializeStagedInputs(mounts: MountSpec[]): Promise<unknown> {
    if (this.status === "destroyed" || mounts.length === 0) {
      return undefined
    }

    const materialization = await materializePlaygroundStagedInputs(await this.bootPlayground(), mounts)
    this.recordEvent("runtime.staged-inputs.materialized", { ...materialization, source: "host-to-vfs" })
    return materialization
  }

  async materializeMounts(mounts: MountSpec[]): Promise<unknown> {
    return await this.materializeStagedInputs(mounts)
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
      const finishedAt = now()
      const envelope = typeof output === "string"
        ? runtimeCommandResultEnvelopeFromOutput({
          status: "ok",
          stdout: output,
          diagnostics: {
            command: spec.command,
            timing: runtimeCommandTiming(startedAt, finishedAt),
          },
        })
        : output
      const result: ExecutionResult = {
        id: commandId,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: commandExitCode(envelope),
        stdout: commandEnvelopeStdout(envelope),
        stderr: envelope?.stderr ?? "",
        result: envelope,
        ...(envelope?.diagnostics !== undefined ? { diagnostics: envelope.diagnostics } : {}),
        ...(envelope?.artifactRefs?.length ? { artifactRefs: envelope.artifactRefs } : {}),
        startedAt,
        finishedAt,
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

  async restoreSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    await this.restoreSnapshotPayload(await runtimeSnapshotPayload(snapshot))
    this.recordEvent("runtime.snapshot.restored", {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      snapshotSchema: snapshot.schema ?? null,
      mode: "same-runtime",
    })
    return snapshot
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
      return this.spec.preview?.publicUrl ?? server.previewLease?.public_url ?? server.previewLease?.preview_public_url ?? this.spec.preview?.lease?.public_url ?? this.spec.preview?.lease?.preview_public_url ?? server.serverUrl
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
    const activeLease = server.previewLease ?? this.spec.preview?.lease
    const publicUrl = this.spec.preview?.publicUrl ?? activeLease?.public_url ?? activeLease?.preview_public_url
    const siteUrl = this.spec.preview?.siteUrl ?? activeLease?.site_url ?? publicUrl
    const lease = this.previewLease(server.serverUrl, publicUrl, siteUrl, createdAt, expiresAt, activeLease)

    const preview: ArtifactPreview = {
      url: publicUrl ?? server.serverUrl,
      localUrl: server.serverUrl,
      ...(publicUrl ? { publicUrl } : {}),
      ...(siteUrl ? { siteUrl } : {}),
      lease,
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

  private previewLease(localUrl: string, publicUrl: string | undefined, siteUrl: string | undefined, createdAt: string, expiresAt: string | undefined, supplied = this.spec.preview?.lease): PreviewLease {
    const previewPublicUrl = publicUrl ?? supplied?.public_url ?? supplied?.preview_public_url
    const leaseStatus = expiresAt ? "active" : "expired"

    return previewLease({
      schema: PREVIEW_LEASE_SCHEMA,
      ...supplied,
      public_url: previewPublicUrl,
      preview_public_url: previewPublicUrl,
      site_url: siteUrl ?? supplied?.site_url,
      local_url: localUrl,
      lease: {
        ...supplied?.lease,
        status: supplied?.lease?.status ?? leaseStatus,
        acquired_at: supplied?.lease?.acquired_at ?? createdAt,
        expires_at: supplied?.lease?.expires_at ?? expiresAt,
        provider: supplied?.lease?.provider ?? "wp-codebox-runtime-playground",
      },
      alignment: supplied?.alignment ?? previewAlignment(publicUrl, siteUrl, localUrl, createdAt),
      reachability: supplied?.reachability ?? {
        status: previewPublicUrl ? "unknown" : "reachable",
        checked_at: createdAt,
        metadata: { source: previewPublicUrl ? "external-preview-url-not-probed" : "local-preview-server" },
      },
      metadata: {
        ...supplied?.metadata,
        handoff: "metadata-only",
        reviewerAccessSafety: previewPublicUrl ? "public-url-declared" : "local-url-not-reviewer-safe",
      },
    })
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
      result = await runHtmlCaptureCommand({ abortSignal: this.activeExecutionSignal, artifactRoot: this.artifactRoot, runtimeSpec: this.spec, runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options), server, spec })
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

  async runEditorValidateBlocks(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    let result: Awaited<ReturnType<typeof runEditorValidateBlocksCommand>>
    try {
      result = await runEditorValidateBlocksCommand({
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

  async runInvokeWpCli(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const command = wpCliCommandFromArgs(spec.args ?? [])
    const argv = shellArgv(command)
    if (argv[0] === "wp") {
      argv.shift()
    }
    if (argv.length === 0) {
      throw new Error("wordpress.invoke-wp-cli requires a non-empty command")
    }
    const response = await this.runWpCliCommand(server, argv)
    const exitCode = response.exitCode ?? 0
    const mutates = stringArg(spec.args ?? [], "mutates") === "true"
    const capability = stringArg(spec.args ?? [], "capability")
    const destructiveBoundary = stringArg(spec.args ?? [], "destructive-boundary") ?? "disposable-runtime"
    const safety = {
      mutates,
      requiresMutationDeclaration: true,
      capabilityField: "capability",
      ...(capability ? { capability } : {}),
      destructiveBoundaryField: "destructive-boundary",
      destructiveBoundary,
      defaultDestructiveBoundary: "disposable-runtime",
      rollbackRequired: false,
    }
    return `${JSON.stringify({
      schema: "wp-codebox/wordpress-execution-action-result/v1",
      command: "wordpress.invoke-wp-cli",
      status: exitCode === 0 ? "ok" : "error",
      target: { argv, command: argv.join(" ") },
      safety,
      result: {
        exitCode,
        stdout: cleanWpCliOutput(response.text),
        stderr: response.errors ?? "",
      },
      diagnostics: exitCode === 0 ? [] : [{ surface: "execution", code: "wp-cli-failed", message: response.errors || response.text || "WP-CLI command failed." }],
    }, null, 2)}\n`
  }

  async runWordPressSession(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const resolution = resolveWordPressActionAuthUser(spec.args ?? [], this.spec)
    const browserUrls = stringListArg(spec.args ?? [], "browser-urls") ?? [this.spec.preview?.publicUrl ?? server.serverUrl]
    const outputDirectory = wordpressAuthOutputDirectory(this.artifactRoot, stringArg(spec.args ?? [], "output-dir"))
    const artifacts = await this.writeWordPressAuthStorageStateArtifacts("wordpress.session", server, outputDirectory, browserUrls, resolution)

    return `${JSON.stringify({
      schema: "wp-codebox/wordpress-session/v1",
      status: "resolved",
      command: "wordpress.session",
      session: resolution.metadata,
      redaction: { cookies: "artifact-ref-only" },
      artifacts: { ...artifacts.paths, redactionRequired: { storageState: true, summary: false } },
      artifactRefs: artifacts.refs,
    }, null, 2)}\n`
  }

  async runWordPressNonce(spec: ExecutionSpec): Promise<string> {
    return this.runWordPressActionAuthResult("wordpress.nonce", spec, false)
  }

  async runWordPressActionAuth(spec: ExecutionSpec): Promise<string> {
    return this.runWordPressActionAuthResult("wordpress.action-auth", spec, true)
  }

  private async runWordPressActionAuthResult(command: "wordpress.nonce" | "wordpress.action-auth", spec: ExecutionSpec, includeStorageState: boolean): Promise<string> {
    const server = await this.bootPlayground()
    const resolution = resolveWordPressActionAuthUser(spec.args ?? [], this.spec)
    const action = stringArg(spec.args ?? [], "action") ?? "wp_rest"
    const outputDirectory = wordpressAuthOutputDirectory(this.artifactRoot, stringArg(spec.args ?? [], "output-dir"))
    const noncePayload = await this.resolveWordPressNonceArtifact(command, server, outputDirectory, action, resolution)
    const storageArtifacts = includeStorageState
      ? await this.writeWordPressAuthStorageStateArtifacts(command, server, outputDirectory, stringListArg(spec.args ?? [], "browser-urls") ?? [this.spec.preview?.publicUrl ?? server.serverUrl], resolution)
      : undefined

    return `${JSON.stringify({
      schema: command === "wordpress.nonce" ? "wp-codebox/wordpress-nonce/v1" : "wp-codebox/wordpress-action-auth/v1",
      status: "resolved",
      command,
      session: resolution.metadata,
      nonces: {
        action,
        actionNonce: { present: true, redacted: true },
        restNonce: { action: "wp_rest", present: true, redacted: true },
      },
      redaction: { cookies: "artifact-ref-only", nonces: "redacted-in-summary" },
      artifacts: { auth: noncePayload.path, ...(storageArtifacts?.paths ?? {}), redactionRequired: { auth: true, storageState: Boolean(storageArtifacts), summary: false } },
      artifactRefs: [noncePayload.ref, ...(storageArtifacts?.refs ?? [])],
    }, null, 2)}\n`
  }

  private async resolveWordPressNonceArtifact(command: string, server: PlaygroundCliServer, outputDirectory: string, action: string, resolution: WordPressUserSessionResolution): Promise<{ path: string; ref: RuntimeEpisodeTraceRef }> {
    const code = wordpressActionAuthNoncePhpCode(command, action, resolution)
    const response = await this.runPlaygroundCommand(command, server, { code: bootstrapPhpCode(this.spec, code, []) })
    assertPlaygroundResponseOk(command, response)
    const secret = JSON.parse(response.text) as Record<string, unknown>
    const authPath = join(outputDirectory, "action-auth.json")
    const artifactPath = artifactRelativePath(this.artifactRoot, authPath)
    const contents = `${JSON.stringify(secret, null, 2)}\n`
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(authPath, contents)
    return {
      path: artifactPath,
      ref: { kind: command === "wordpress.nonce" ? "wordpress-nonce" : "wordpress-action-auth", id: `${command}:action-auth`, path: artifactPath, digest: { algorithm: "sha256", value: sha256(Buffer.from(contents, "utf8")) } },
    }
  }

  private async writeWordPressAuthStorageStateArtifacts(command: string, server: PlaygroundCliServer, outputDirectory: string, browserUrls: string[], resolution: WordPressUserSessionResolution): Promise<{ paths: { storageState: string; summary: string }; refs: RuntimeEpisodeTraceRef[] }> {
    const response = await this.runPlaygroundCommand(command, server, { code: bootstrapPhpCode(this.spec, wordpressFixtureUserStorageStatePhpCode({ browserUrls, user: wordpressFixtureUserWithoutPassword(resolution.user) }), []) })
    assertPlaygroundResponseOk(command, response)
    const payload = JSON.parse(response.text) as Record<string, unknown>
    const normalized = normalizeBrowserStorageStatePayload(payload, "inline")
    if (normalized.summary.status !== "ready") {
      throw new Error(`${command} could not resolve browser storage state: ${JSON.stringify(normalized.summary.diagnostics)}`)
    }

    const storageStatePath = join(outputDirectory, "storage-state.json")
    const summaryPath = join(outputDirectory, "summary.json")
    const storageStateArtifactPath = artifactRelativePath(this.artifactRoot, storageStatePath)
    const summaryArtifactPath = artifactRelativePath(this.artifactRoot, summaryPath)
    const exportedUser = payload.user && typeof payload.user === "object" && !Array.isArray(payload.user) ? payload.user as Record<string, unknown> : {}
    const summary = {
      schema: "wp-codebox/wordpress-auth-summary/v1",
      command,
      status: "resolved",
      session: resolution.metadata,
      user: storageStateUserSummary(exportedUser),
      storageState: normalized.summary,
      redaction: { cookies: "artifact-ref-only" },
      artifacts: { storageState: storageStateArtifactPath, summary: summaryArtifactPath },
    }
    const storageStateJson = `${JSON.stringify(normalized.storageState, null, 2)}\n`
    const summaryJson = `${JSON.stringify(summary, null, 2)}\n`
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(storageStatePath, storageStateJson)
    await writeFile(summaryPath, summaryJson)
    return {
      paths: { storageState: storageStateArtifactPath, summary: summaryArtifactPath },
      refs: [
        { kind: "browser-storage-state", id: `${command}:storage-state`, path: storageStateArtifactPath, digest: { algorithm: "sha256", value: sha256(Buffer.from(storageStateJson, "utf8")) } },
        { kind: "browser-storage-state-summary", id: `${command}:storage-state-summary`, path: summaryArtifactPath, digest: { algorithm: "sha256", value: sha256(Buffer.from(summaryJson, "utf8")) } },
      ],
    }
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

  async runPluginSetup(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runPluginSetupCommand({
      runWpCliArgv: (targetServer, argv) => this.runWpCliArgv(targetServer, argv),
      server,
      spec,
    })
  }

  async runCollectWorkloadResult(spec: ExecutionSpec): Promise<string> {
    const args = new Map((spec.args ?? []).map((arg) => {
      const index = arg.indexOf("=")
      return index === -1 ? [arg, ""] : [arg.slice(0, index), arg.slice(index + 1)]
    }))
    throw new Error(`wordpress.collect-workload-result requires a workload execution context with a typed payload for artifact=${args.get("artifact") ?? ""}`)
  }

  async runCrudOperation(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const operation = wordpressCrudOperationFromArgs(spec.args ?? [])
    const response = await this.runPlaygroundCommand("wordpress.crud-operation", server, { code: bootstrapPhpCode(this.spec, wordpressCrudOperationPhpCode(operation), spec.args ?? []) })
    assertPlaygroundResponseOk("wordpress.crud-operation", response)
    return response.text
  }

  async runBlockRender(spec: ExecutionSpec): Promise<string> {
    return this.runBlockExerciseCommand({ ...spec, command: "wordpress.block-render" })
  }

  async runBlockExercise(spec: ExecutionSpec): Promise<string> {
    return this.runBlockExerciseCommand({ ...spec, command: "wordpress.block-exercise" })
  }

  private async runBlockExerciseCommand(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const command = spec.command === "wordpress.block-render" ? "wordpress.block-render" : "wordpress.block-exercise"
    const input = wordpressBlockExerciseInputFromArgs(spec.args ?? [], command)
    const response = await this.runPlaygroundCommand(command, server, { code: bootstrapPhpCode(this.spec, wordpressBlockExercisePhpCode(input, command), spec.args ?? []) })
    assertPlaygroundResponseOk(command, response)
    return response.text
  }

  async runDbOperation(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const operation = wordpressDbOperationFromArgs(spec.args ?? [])
    const response = await this.runPlaygroundCommand("wordpress.db-operation", server, { code: bootstrapPhpCode(this.spec, wordpressDbOperationPhpCode(operation), spec.args ?? []) })
    assertPlaygroundResponseOk("wordpress.db-operation", response)
    return response.text
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

  async runThemeSetup(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runThemeSetupCommand({
      runWpCliArgv: (targetServer, argv) => this.runWpCliArgv(targetServer, argv),
      server,
      spec,
    })
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

  async runRestPerformanceObservation(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runRestPerformanceObservationCommand({
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runCacheChurnObservation(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runCacheChurnObservationCommand({
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runRuntimeDiscovery(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runRuntimeDiscoveryCommand({
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runRestRouteInventory(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runRuntimeInventoryCommand({
      command: spec.command,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      schema: "wp-codebox/wordpress-rest-route-inventory/v1",
      server,
      surface: "rest",
    })
  }

  async runExecutionSurfaces(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runRuntimeInventoryCommand({
      command: spec.command,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      schema: "wp-codebox/wordpress-execution-surfaces/v1",
      server,
      surface: "execution",
    })
  }

  async runInvokeHook(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runWordPressExecutionActionCommand({
      command: "wordpress.invoke-hook",
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runInvokeCronEvent(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runWordPressExecutionActionCommand({
      command: "wordpress.invoke-cron-event",
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runAdminPageInventory(): Promise<string> {
    const server = await this.bootPlayground()
    return runRuntimeInventoryCommand({
      command: "wordpress.admin-page-inventory",
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      schema: "wp-codebox/wordpress-admin-page-inventory/v1",
      server,
      surface: "admin",
    })
  }

  async runAdminActionInventory(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runAdminActionInventoryCommand({
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runFuzzAdminPages(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const input = adminFuzzInputFromArgs(spec.args ?? [], this.spec)
    const response = await this.runPlaygroundCommand("wordpress.fuzz-admin-pages", server, { code: bootstrapPhpCode(this.spec, adminFuzzPhpCode(input), spec.args ?? []) })
    assertPlaygroundResponseOk("wordpress.fuzz-admin-pages", response)
    return response.text
  }

  async runAdminAction(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const action = adminActionInputFromArgs(spec.args ?? [])
    const response = await this.runPlaygroundCommand("wordpress.admin-action", server, { code: bootstrapPhpCode(this.spec, adminActionPhpCode(action), spec.args ?? []) })
    assertPlaygroundResponseOk("wordpress.admin-action", response)
    return response.text
  }

  async runFuzzPluginModuleState(spec: ExecutionSpec): Promise<string> {
    const args = new Map((spec.args ?? []).map((arg) => {
      const index = arg.indexOf("=")
      return index === -1 ? [arg, ""] : [arg.slice(0, index), arg.slice(index + 1)]
    }))
    const executeMutations = args.get("execute_mutations") === "true" || args.get("execute-mutations") === "true"
    return `${JSON.stringify({
      schema: "wp-codebox/wordpress-plugin-module-state-plan/v1",
      command: spec.command,
      status: executeMutations ? "unsupported" : "ok",
      mutationMode: args.get("mutation_mode") ?? args.get("mutation-mode") ?? "declared_plan",
      executeMutations,
      externalDispatch: args.get("external_dispatch") === "true" || args.get("external-dispatch") === "true",
      safeguards: {
        connectedStateRequiredForMutation: args.get("connected_state_required_for_mutation") === "true" || args.get("connected-state-required-for-mutation") === "true",
        runtimeIsolationRequiredForMutation: args.get("runtime_isolation_required_for_mutation") === "true" || args.get("runtime-isolation-required-for-mutation") === "true",
        disposableSandboxRequired: args.get("disposable_sandbox_required") === "true" || args.get("disposable-sandbox-required") === "true",
      },
      plannedActions: [],
      skipReasons: executeMutations ? ["mutation_execution_unsupported"] : [],
      diagnostics: executeMutations ? [{ code: "mutation-execution-unsupported", message: "wordpress.fuzz-plugin-module-state only supports declared planning until explicit fixture or disposable sandbox boundaries are provided.", severity: "warning" }] : [],
      artifactRefs: [],
    }, null, 2)}\n`
  }

  async runInventoryPluginModuleOptionsTables(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const response = await this.runPlaygroundCommand("wordpress.inventory-plugin-module-options-tables", server, { code: bootstrapPhpCode(this.spec, pluginModuleOptionsTablesInventoryPhpCode(), spec.args ?? []) })
    assertPlaygroundResponseOk("wordpress.inventory-plugin-module-options-tables", response)
    return response.text
  }

  async runDatabaseInventory(): Promise<string> {
    const server = await this.bootPlayground()
    return runRuntimeInventoryCommand({
      command: "wordpress.inventory-database",
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      schema: "wp-codebox/wordpress-db-inventory/v1",
      server,
      surface: "database",
    })
  }

  async runFrontendUrlInventory(): Promise<string> {
    const server = await this.bootPlayground()
    return runRuntimeInventoryCommand({
      command: "wordpress.frontend-url-inventory",
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      schema: "wp-codebox/wordpress-frontend-url-inventory/v1",
      server,
      surface: "frontend",
    })
  }

  async runAdminPageLoad(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runPageLoadCommand({
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
      surface: "admin",
    })
  }

  async runFrontendPageLoad(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runPageLoadCommand({
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
      surface: "frontend",
    })
  }

  async runHttpRequest(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runHttpRequestCommand({
      baseUrl: this.spec.preview?.publicUrl ?? server.serverUrl,
      spec,
    })
  }

  async runServerPageLoad(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runServerPageLoadCommand({
      baseUrl: this.spec.preview?.publicUrl ?? server.serverUrl,
      spec,
    })
  }

  async runBrowserPageLoad(spec: ExecutionSpec): Promise<string> {
    const surface = spec.args?.find((arg) => arg.startsWith("surface="))?.slice("surface=".length) || "frontend"
    const url = spec.args?.find((arg) => arg.startsWith("url="))?.slice("url=".length)
    const path = spec.args?.find((arg) => arg.startsWith("path="))?.slice("path=".length) || (surface === "admin" ? "index.php" : "/")
    const resolved = url || (surface === "admin" ? `/wp-admin/${path.replace(/^\/+/, "")}` : `/${path.replace(/^\/+/, "")}`)
    const output = await this.runBrowserProbe({ ...spec, command: "wordpress.browser-page-load", args: [`url=${resolved}`, ...(spec.args ?? []).filter((arg) => !arg.startsWith("surface=") && !arg.startsWith("path=") && !arg.startsWith("url="))] })
    return normalizeBrowserPageLoadOutput(output, surface === "admin" ? "admin" : "frontend", path)
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
      runtimeSpec: this.spec,
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

function wordpressAuthOutputDirectory(artifactRoot: string, requested: string | undefined): string {
  const relativePath = requested?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "files/wordpress-auth"
  if (relativePath.length === 0 || relativePath.includes("..")) {
    throw new Error("wordpress auth output-dir must be a relative path inside the runtime artifact root")
  }

  return join(artifactRoot, relativePath)
}

function resolveWordPressActionAuthUser(args: string[], runtimeSpec: RuntimeCreateSpec): WordPressUserSessionResolution {
  const recipeResolution = wordpressUserSessionFromCommandArgs(args, runtimeSpec)
  if (recipeResolution) {
    return recipeResolution
  }

  const role = stringArg(args, "role") ?? "administrator"
  const normalizedRole = role.replace(/[^a-z0-9_-]/gi, "").toLowerCase()
  if (!normalizedRole) {
    throw new Error("wordpress auth role must be a non-empty WordPress role slug")
  }

  return {
    source: "user",
    name: `role:${normalizedRole}`,
    user: { name: `role:${normalizedRole}`, username: `wp-codebox-${normalizedRole}`, role: normalizedRole, email: `wp-codebox-${normalizedRole}@example.test` },
    metadata: {
      schema: "wp-codebox/wordpress-user-session/v1",
      source: "user",
      name: `role:${normalizedRole}`,
      user: { name: `role:${normalizedRole}`, username: `wp-codebox-${normalizedRole}`, email: `wp-codebox-${normalizedRole}@example.test`, role: normalizedRole },
      artifacts: [],
      redactionRequired: false,
    },
  }
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

function normalizeBrowserPageLoadOutput(output: string, surface: "admin" | "frontend", path: string): string {
  const parsed = JSON.parse(output) as Record<string, unknown>
  const normalize = (entry: Record<string, unknown>): Record<string, unknown> => ({
    ...entry,
    browserProbeSchema: entry.schema,
    schema: "wp-codebox/wordpress-page-load-result/v1",
    mode: "browser",
    source: "browser",
    command: "wordpress.browser-page-load",
    status: browserPageLoadStatus(entry),
    target: { kind: surface, path, method: "GET" },
    identity: { url: typeof entry.finalUrl === "string" ? entry.finalUrl : entry.requestedUrl },
    http: typeof entry.finalUrl === "string" ? { url: entry.finalUrl } : undefined,
  })

  if (Array.isArray(parsed.outputs)) {
    const outputs = parsed.outputs as unknown[]
    const normalizedOutputs = outputs.map((entry) => isRecord(entry) ? normalize(entry) : entry)
    parsed.outputs = normalizedOutputs
    parsed.schema = "wp-codebox/wordpress-page-load-result/v1"
    parsed.mode = "browser"
    parsed.source = "browser"
    parsed.command = "wordpress.browser-page-load"
    parsed.status = normalizedOutputs.some((entry) => isRecord(entry) && entry.status === "error") ? "error" : "ok"
    parsed.target = { kind: surface, path, method: "GET" }
    return `${JSON.stringify(parsed, null, 2)}\n`
  }

  return `${JSON.stringify(normalize(parsed), null, 2)}\n`
}

function browserPageLoadStatus(result: Record<string, unknown>): "ok" | "redirect" | "error" {
  const assertions = isRecord(result.assertions) ? result.assertions : undefined
  if (typeof assertions?.fatalFailed === "number" && assertions.fatalFailed > 0) {
    return "error"
  }
  return "ok"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
