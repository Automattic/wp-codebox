import { cp, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { phpRuntimeRecipePluginPreloadFunction, type ExecutionResult, type Runtime, type WorkspaceRecipe, type WorkspaceRecipeMount, type WorkspaceRecipePluginRuntimeHealthProbe } from "@automattic/wp-codebox-core"
import { installMuPluginsCode, installPluginComposerAutoloadersCode, prepareRecipeDependencyOverlays, prepareRecipeExtraPlugins, prepareRecipeRuntimeOverlays, prepareRecipeStagedFiles, prepareRecipeWorkspacePreloads, prepareRecipeWorkspaces, recipeMountType, type PreparedDependencyOverlay, type PreparedExtraPlugin, type PreparedRuntimeOverlay, type PreparedStagedFile, type PreparedWorkspaceMount } from "../recipe-sources.js"
import { pluginRuntimeHealthProbeStep, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { pluginRuntimeHealthProbeStepIndex, pluginRuntimeSetupStepIndex } from "../recipe-dry-run.js"
import { prepareRecipeRuntimeBackendPackage, type PreparedRuntimeBackendPackage } from "../recipe-backend-package.js"
import { recipeExecutionSpec } from "../agent-sandbox.js"
import type { RecipeRunPhaseExecutor } from "./recipe-run-phase-executor.js"
import type { RecipeExecutionResult, RecipeInterruptionController, RecipePhaseEvidence } from "./recipe-run-types.js"

export interface PreparedRecipeRuntimeSetup {
  workspaceMounts: PreparedWorkspaceMount[]
  extraPlugins: PreparedExtraPlugin[]
  dependencyOverlays: PreparedDependencyOverlay[]
  stagedFiles: PreparedStagedFile[]
  overlays: PreparedRuntimeOverlay[]
  inputMountBaselinePaths: string[]
  backendPackage?: PreparedRuntimeBackendPackage
}

export interface RecipeRuntimeSetupResult {
  executions: RecipeExecutionResult[]
}

export async function prepareRecipeRuntimeSetup(recipe: WorkspaceRecipe, recipeDirectory: string, runtimeBackend: string): Promise<PreparedRecipeRuntimeSetup> {
  const extraPlugins = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
  const workspaceMounts = [
    ...await prepareRecipeWorkspaces(recipe, recipeDirectory),
    ...await prepareRecipeWorkspacePreloads(recipe),
  ]
  return {
    workspaceMounts,
    extraPlugins,
    dependencyOverlays: await prepareRecipeDependencyOverlays(recipe, recipeDirectory, extraPlugins),
    stagedFiles: await prepareRecipeStagedFiles(recipe, recipeDirectory),
    overlays: await prepareRecipeRuntimeOverlaysForRun(recipe, recipeDirectory),
    inputMountBaselinePaths: [],
    backendPackage: await prepareRecipeRuntimeBackendPackage(recipe, recipeDirectory, runtimeBackend),
  }
}

export async function applyRecipeRuntimeSetup(args: {
  recipe: WorkspaceRecipe
  recipeDirectory: string
  runtime: Runtime
  prepared: PreparedRecipeRuntimeSetup
  phaseExecutor: RecipeRunPhaseExecutor
  interruption?: RecipeInterruptionController
}): Promise<RecipeRuntimeSetupResult> {
  const { recipe, recipeDirectory, runtime, prepared, phaseExecutor, interruption } = args
  const { workspaceMounts, extraPlugins, dependencyOverlays, stagedFiles, overlays, inputMountBaselinePaths } = prepared
  const executions: RecipeExecutionResult[] = []
  const phaseTracker = phaseExecutor.tracker
  const awaitRecipe = <T>(operation: string, promiseOrFactory: Promise<T> | (() => Promise<T>), timeoutMs?: number): Promise<T> => phaseExecutor.operation(operation, promiseOrFactory, timeoutMs)
  const overlayCopies: Array<{ source: string; target: string }> = []

  for (const [index, mount] of (recipe.runtime?.stack?.mounts ?? []).entries()) {
    const source = resolve(recipeDirectory, mount.source)
    await awaitRecipe(`runtime.stack.mount[${index}]`, runtime.mount({
      type: await recipeMountType(source, mount.type),
      source,
      target: mount.target,
      mode: mount.mode ?? "readonly",
      metadata: {
        kind: "runtime-stack-mount",
        index,
        ...(mount.metadata ?? {}),
      },
    }))
    interruption?.throwIfInterrupted()
  }

  for (const [index, mount] of (recipe.distribution?.sourceMounts ?? []).entries()) {
    const source = resolve(recipeDirectory, mount.source)
    await awaitRecipe(`distribution.source-mount[${index}]:${mount.target}`, runtime.mount({
      type: await recipeMountType(source, mount.type),
      source,
      target: mount.target,
      mode: mount.mode ?? "readonly",
      metadata: {
        kind: "distribution-source-mount",
        index,
        ...(mount.role ? { role: mount.role } : {}),
        ...(mount.ref ? { ref: mount.ref } : {}),
        ...(mount.metadata ?? {}),
      },
    }))
    interruption?.throwIfInterrupted()
  }

  if (recipe.distribution) {
    phaseTracker.complete("apply_distribution", distributionRuntimeData(recipe))
  }

  for (const [index, overlay] of overlays.entries()) {
    const mountedTarget = runtimeOverlayMountTarget(overlay, index)
    await awaitRecipe(`runtime.overlay.mount:${overlay.target}`, runtime.mount({
      type: overlay.type,
      source: overlay.source,
      target: mountedTarget,
      mode: overlay.mode,
      metadata: overlay.metadata,
    }))
    if (mountedTarget !== overlay.target) {
      overlayCopies.push({ source: mountedTarget, target: overlay.target })
    }
    interruption?.throwIfInterrupted()
  }

  for (const workspace of workspaceMounts) {
    await awaitRecipe(`workspace.mount:${workspace.target}`, runtime.mount({
      type: "directory",
      source: workspace.source,
      target: workspace.target,
      mode: workspace.mode,
      metadata: workspace.metadata,
    }))
    interruption?.throwIfInterrupted()
  }

  await phaseTracker.run("mount_plugins", phasePluginMountData(extraPlugins), async () => {
    for (const plugin of extraPlugins) {
      await awaitRecipe(`extra-plugin.mount:${plugin.slug}`, runtime.mount({
        type: "directory",
        source: plugin.source,
        target: plugin.target,
        mode: "readonly",
        metadata: {
          kind: "extra-plugin",
          slug: plugin.slug,
          source: plugin.provenance,
        },
      }))
      interruption?.throwIfInterrupted()
    }
  })

  for (const overlay of overlayCopies) {
    executions.push(withRecipeExecutionPhase(await runtime.execute({ command: "wordpress.run-php", args: setupPhpArgs(copyRuntimeOverlayCode(overlay.source, overlay.target)) }), "setup", -3, `runtime.overlay.copy:${overlay.target}`))
    interruption?.throwIfInterrupted()
  }

  for (const overlay of dependencyOverlays) {
    await awaitRecipe(`dependency-overlay.mount:${overlay.package}`, runtime.mount({
      type: overlay.type,
      source: overlay.source,
      target: overlay.target,
      mode: overlay.mode,
      metadata: overlay.metadata,
    }))
    interruption?.throwIfInterrupted()
  }

  for (const mount of recipe.inputs?.mounts ?? []) {
    const source = resolve(recipeDirectory, mount.source)
    const metadata = await inputMountMetadataWithBaseline(source, mount, inputMountBaselinePaths)
    await awaitRecipe(`input.mount:${mount.target}`, runtime.mount({
      type: await recipeMountType(source, mount.type),
      source,
      target: mount.target,
      mode: mount.mode ?? "readwrite",
      metadata,
    }))
    interruption?.throwIfInterrupted()
  }

  for (const stagedFile of stagedFiles) {
    await awaitRecipe(`staged-file.mount:${stagedFile.target}`, runtime.mount({
      type: stagedFile.type,
      source: stagedFile.source,
      target: stagedFile.target,
      mode: "readwrite",
      metadata: stagedFile.metadata,
    }))
    interruption?.throwIfInterrupted()
  }

  const canMaterializeStagedInputs = typeof runtime.materializeStagedInputs === "function" || typeof runtime.materializeMounts === "function"
  if (stagedFiles.length > 0 && canMaterializeStagedInputs) {
    const stagedMounts = stagedFiles.map((stagedFile) => ({
      type: stagedFile.type,
      source: stagedFile.source,
      target: stagedFile.target,
      mode: "readwrite" as const,
      metadata: stagedFile.metadata,
    }))
    await awaitRecipe("staged-file.materialize", () => runtime.materializeStagedInputs ? runtime.materializeStagedInputs(stagedMounts) : runtime.materializeMounts!(stagedMounts))
    interruption?.throwIfInterrupted()
  }

  const muPluginInstallCode = installMuPluginsCode(extraPlugins)
  if (muPluginInstallCode) {
    executions.push(withRecipeExecutionPhase(await runtime.execute({ command: "wordpress.run-php", args: setupPhpArgs(muPluginInstallCode) }), "setup", -2, "extra-plugin.install-mu-loader"))
  }

  const composerAutoloaderInstallCode = installPluginComposerAutoloadersCode(extraPlugins)
  if (composerAutoloaderInstallCode) {
    executions.push(withRecipeExecutionPhase(await runtime.execute({ command: "wordpress.run-php", args: setupPhpArgs(composerAutoloaderInstallCode) }), "setup", -2, "extra-plugin.install-composer-autoloaders"))
  }

  const activatedPlugins = extraPlugins.filter((plugin) => plugin.loadAs === "plugin" && plugin.activate !== false)
  if (activatedPlugins.length > 0) {
    const activePluginsAfterActivation = await phaseTracker.run("activate_plugins", phasePluginActivationData(activatedPlugins), async () => {
      for (const plugin of activatedPlugins) {
        executions.push(withRecipeExecutionPhase(await runtime.execute({ command: "wordpress.run-php", args: setupPhpArgs(activateExtraPluginCode(plugin)) }), "setup", -1, `extra-plugin.activate:${plugin.pluginFile}`))
        interruption?.throwIfInterrupted()
      }
      return await activePlugins(runtime)
    })
    const activationPhase = [...phaseTracker.list()].reverse().find((phase: RecipePhaseEvidence) => phase.name === "activate_plugins")
    if (activationPhase?.data) {
      activationPhase.data.activePlugins = activePluginsAfterActivation
    }
  }

  for (const [index, setupStep] of (recipe.inputs?.pluginRuntime?.setup ?? []).entries()) {
    executions.push(await awaitRecipe(`plugin-runtime.setup[${index}]`, executeRecipePluginRuntimeStep(runtime, setupStep, recipeDirectory, "setup", index)))
    interruption?.throwIfInterrupted()
  }

  for (const [index, probe] of (recipe.inputs?.pluginRuntime?.healthProbes ?? []).entries()) {
    executions.push(await awaitRecipe(`plugin-runtime.health:${probe.name}`, executeRecipePluginRuntimeHealthProbe(runtime, probe, recipeDirectory, index)))
    interruption?.throwIfInterrupted()
  }

  return { executions }
}

export async function cleanupInputMountBaselines(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
  paths.length = 0
}

export function recipeRunDependencyOverlay(overlay: PreparedDependencyOverlay): Record<string, unknown> {
  return {
    source: overlay.source,
    sourceRef: overlay.sourceRef,
    target: overlay.target,
    package: overlay.package,
    consumer: overlay.consumer,
    type: overlay.type,
    mode: overlay.mode,
    metadata: overlay.metadata,
  }
}

export function recipeRunStagedFile(stagedFile: PreparedStagedFile) {
  const index = typeof stagedFile.metadata.index === "number" ? stagedFile.metadata.index : 0
  return {
    index,
    source: stagedFile.originalSource,
    sourceRef: stagedFile.sourceRef,
    target: stagedFile.target,
    type: stagedFile.type,
    provenance: stagedFile.provenance,
    action: "staged" as const,
  }
}

export function recipeRunExtraPlugin(plugin: PreparedExtraPlugin): Record<string, unknown> {
  return {
    source: plugin.source,
    slug: plugin.slug,
    target: plugin.target,
    pluginFile: plugin.pluginFile,
    activate: plugin.activate,
    loadAs: plugin.loadAs,
    provenance: plugin.provenance,
    metadata: plugin.metadata,
  }
}

async function prepareRecipeRuntimeOverlaysForRun(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedRuntimeOverlay[]> {
  try {
    return await prepareRecipeRuntimeOverlays(recipe, recipeDirectory)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe runtime overlay preparation failed: ${message}`, { cause: error })
  }
}

function withRecipeExecutionPhase(execution: ExecutionResult, recipePhase: RecipeWorkflowPhase, recipeStepIndex: number, recipeCommand?: string): RecipeExecutionResult {
  return {
    ...execution,
    recipePhase,
    recipeStepIndex,
    recipeCommand,
  }
}

async function executeRecipePluginRuntimeStep(runtime: Runtime, step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, phase: "setup", index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(step, recipeDirectory))
    return withRecipeExecutionPhase(execution, phase, pluginRuntimeSetupStepIndex(index), `plugin-runtime.setup:${index}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe plugin runtime setup[${index}] failed: ${message}`, { cause: error })
  }
}

async function executeRecipePluginRuntimeHealthProbe(runtime: Runtime, probe: WorkspaceRecipePluginRuntimeHealthProbe, recipeDirectory: string, index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(pluginRuntimeHealthProbeStep(probe), recipeDirectory))
    return withRecipeExecutionPhase(execution, "setup", pluginRuntimeHealthProbeStepIndex(index), `plugin-runtime.health:${probe.name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe plugin runtime health probe "${probe.name}" failed: ${message}`, { cause: error })
  }
}

async function activePlugins(runtime: Runtime): Promise<string[]> {
  const execution = await runtime.execute({
    command: "wordpress.run-php",
    args: setupPhpArgs("echo wp_json_encode(array_values((array) get_option('active_plugins', array())));"),
  })
  const parsed = JSON.parse(execution.stdout.trim() || "[]") as unknown
  return Array.isArray(parsed) ? parsed.filter((plugin): plugin is string => typeof plugin === "string") : []
}

function setupPhpArgs(code: string): string[] {
  return ["recipe-active-plugins=none", `code=${code}`]
}

function runtimeOverlayMountTarget(overlay: PreparedRuntimeOverlay, index: number): string {
  const metadata = overlay.metadata ?? {}
  if (metadata.library === "php-ai-client" && overlay.target === "/wordpress/wp-includes/php-ai-client") {
    return `/tmp/wp-codebox-runtime-overlays/${index}/php-ai-client`
  }
  return overlay.target
}

function copyRuntimeOverlayCode(source: string, target: string): string {
  return `$source = ${JSON.stringify(source)};
$target = ${JSON.stringify(target)};
if (!is_dir($source)) {
    throw new RuntimeException('Runtime overlay source is not mounted: ' . $source);
}
if (!is_dir($target) && !wp_mkdir_p($target)) {
    throw new RuntimeException('Runtime overlay target could not be created: ' . $target);
}
$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS),
    RecursiveIteratorIterator::SELF_FIRST
);
foreach ($iterator as $item) {
    $relative = substr($item->getPathname(), strlen($source) + 1);
    $destination = $target . '/' . $relative;
    if ($item->isDir()) {
        if (!is_dir($destination) && !wp_mkdir_p($destination)) {
            throw new RuntimeException('Runtime overlay directory could not be created: ' . $destination);
        }
        continue;
    }
    $parent = dirname($destination);
    if (!is_dir($parent) && !wp_mkdir_p($parent)) {
        throw new RuntimeException('Runtime overlay parent directory could not be created: ' . $parent);
    }
    if (!copy($item->getPathname(), $destination)) {
        throw new RuntimeException('Runtime overlay file could not be copied: ' . $destination);
    }
}
echo wp_json_encode(array('source' => $source, 'target' => $target, 'copied' => true));`;
}

function phasePluginMountData(extraPlugins: PreparedExtraPlugin[]): Record<string, unknown> {
  return {
    count: extraPlugins.length,
    plugins: extraPlugins.map((plugin) => ({ slug: plugin.slug, pluginFile: plugin.pluginFile, target: plugin.target, loadAs: plugin.loadAs })),
  }
}

function phasePluginActivationData(activatedPlugins: PreparedExtraPlugin[]): Record<string, unknown> {
  return {
    count: activatedPlugins.length,
    plugins: activatedPlugins.map((plugin) => ({ slug: plugin.slug, pluginFile: plugin.pluginFile })),
  }
}

function distributionRuntimeData(recipe: WorkspaceRecipe): Record<string, unknown> {
  const distribution = recipe.distribution
  if (!distribution) {
    return { applied: [], unsupported: [] }
  }

  const applied = [
    ...(Object.keys(distribution.env ?? {}).length > 0 ? [{ field: "env", action: "runtimeEnv+bootstrap", count: Object.keys(distribution.env ?? {}).length }] : []),
    ...(Object.keys(distribution.constants ?? {}).length > 0 ? [{ field: "constants", action: "bootstrap", count: Object.keys(distribution.constants ?? {}).length }] : []),
    ...((distribution.sourceMounts ?? []).map((mount, index) => ({ field: `sourceMounts[${index}]`, action: "mounted", target: mount.target, mode: mount.mode ?? "readonly" }))),
    ...((distribution.setupArtifacts ?? []).map((artifact, index) => ({ field: `setupArtifacts[${index}]`, action: "applied-by-run_distribution_setup_artifacts", name: artifact.name, type: artifact.type }))),
    ...((distribution.startupProbes ?? []).map((probe, index) => ({ field: `startupProbes[${index}]`, action: "applied-by-run_distribution_startup_probes", name: probe.name, type: probe.type }))),
  ]
  const unsupported = [
    ...(distribution.wordpress.root ? [{ field: "wordpress.root", reason: "runtime WordPress root selection is still controlled by runtime.assets.wordpressDirectory" }] : []),
    ...(distribution.wordpress.config ? [{ field: "wordpress.config", reason: "custom wp-config file declarations are not applied by this runtime subset" }] : []),
    ...(distribution.wordpress.bootstrap && distribution.wordpress.bootstrap !== "standard" ? [{ field: "wordpress.bootstrap", reason: "custom/external bootstrap modes are not applied by this runtime subset" }] : []),
    ...(distribution.wordpress.bootstrapFile ? [{ field: "wordpress.bootstrapFile", reason: "custom bootstrap files are not applied by this runtime subset" }] : []),
    ...((distribution.serviceFakes ?? []).map((fake, index) => ({ field: `serviceFakes[${index}]`, reason: `service fake '${fake.name}' is declaration-only` }))),
    ...((distribution.routeAliases ?? []).map((alias, index) => ({ field: `routeAliases[${index}]`, reason: `route alias '${alias.name ?? alias.path ?? alias.host ?? index}' is declaration-only` }))),
    ...((distribution.artifacts ?? []).map((artifact, index) => ({ field: `artifacts[${index}]`, reason: `distribution artifact '${artifact.path}' is not collected by this runtime subset` }))),
    ...((distribution.safety?.allowedHosts ?? []).map((host, index) => ({ field: `safety.allowedHosts[${index}]`, reason: `network host '${host}' is not enforced by this runtime subset` }))),
    ...((distribution.safety?.secretEnv ?? []).map((name, index) => ({ field: `safety.secretEnv[${index}]`, reason: `distribution secret env '${name}' is not resolved by this runtime subset` }))),
  ]

  return {
    name: distribution.name,
    applied,
    unsupported,
  }
}

async function inputMountMetadataWithBaseline(source: string, mount: WorkspaceRecipeMount, cleanupPaths: string[]): Promise<Record<string, unknown> | undefined> {
  const metadata = mount.metadata ? { ...mount.metadata } : {}
  if ((mount.mode ?? "readwrite") !== "readwrite") {
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }
  if (typeof metadata.baselineSource === "string" && metadata.baselineSource.length > 0) {
    return metadata
  }

  let sourceStats
  try {
    sourceStats = await stat(source)
  } catch {
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }
  if (!sourceStats.isDirectory() || await hasGitMetadata(source)) {
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }

  const baselineSource = await mkdtemp(join(tmpdir(), "wp-codebox-input-mount-baseline-"))
  cleanupPaths.push(baselineSource)
  await cp(source, baselineSource, {
    recursive: true,
    filter: (entry) => shouldCopyInputMountBaselineEntry(source, entry),
  })
  metadata.baselineSource = baselineSource
  metadata.baselineStrategy = "input-mount-snapshot"
  return metadata
}

async function hasGitMetadata(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"))
    return true
  } catch {
    return false
  }
}

function shouldCopyInputMountBaselineEntry(sourceRoot: string, entry: string): boolean {
  const relativePath = entry.slice(sourceRoot.length).replace(/^\/+/, "")
  if (!relativePath) {
    return true
  }
  const firstSegment = relativePath.split("/")[0]
  return firstSegment !== ".git" && firstSegment !== "node_modules"
}

function activateExtraPluginCode(plugin: PreparedExtraPlugin): string {
  const pluginMetadata = {
    slug: plugin.slug,
    pluginFile: plugin.pluginFile,
    target: plugin.target,
  }
  const encodedPluginMetadata = Buffer.from(JSON.stringify(pluginMetadata), "utf8").toString("base64")
  return `${phpRuntimeRecipePluginPreloadFunction("wp_codebox_activate_plugin")}
$plugin = json_decode(base64_decode('${encodedPluginMetadata}'), true);
if (!is_array($plugin)) {
    throw new RuntimeException('Could not decode recipe plugin activation metadata.');
}
$plugin_file = ${JSON.stringify(plugin.pluginFile)};
require_once ABSPATH . 'wp-admin/includes/plugin.php';
register_shutdown_function(static function () use ($plugin, $plugin_file): void {
    $fatal = error_get_last();
    if (!is_array($fatal) || !in_array($fatal['type'] ?? 0, array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR), true)) {
        return;
    }
    $diagnostic = wp_codebox_activate_plugin_recipe_plugin_preload_diagnostic($plugin, 'activation-recipe-plugin', isset($fatal['message']) ? (string) $fatal['message'] : '');
    $message = $diagnostic['error'];
    if (preg_match('/Class "([^"]+)" not found/', $message, $matches)) {
        $diagnostic['missing_class'] = $matches[1];
        $classmap = $diagnostic['classmap']['path'];
        if (is_string($classmap) && is_file($classmap)) {
            $classmap_data = include $classmap;
            if (is_array($classmap_data) && isset($classmap_data[$diagnostic['missing_class']])) {
                $diagnostic['classmap']['entry'] = (string) $classmap_data[$diagnostic['missing_class']];
                $diagnostic['classmap']['entry_exists'] = is_file($diagnostic['classmap']['entry']);
            }
        }
        $diagnostic['class_exists'] = array(
            'without_autoload' => class_exists($diagnostic['missing_class'], false),
            'with_autoload' => class_exists($diagnostic['missing_class'], true),
        );
    }
    echo "\nWP_CODEBOX_PLUGIN_PRELOAD_DIAGNOSTIC:" . wp_json_encode(array(
        ...$diagnostic,
        'fatal_message' => $message,
    ), JSON_UNESCAPED_SLASHES) . "\n";
});
wp_codebox_activate_plugin_preload_recipe_plugin($plugin, false, 'activation-recipe-plugin', 'recipe-runtime-setup activate_plugin');
if (is_plugin_active($plugin_file)) {
    deactivate_plugins($plugin_file, true, false);
}
$lifecycle = wp_codebox_activate_plugin_component_lifecycle_replay_prepare();
$result = activate_plugin($plugin_file, '', false, false);
wp_codebox_activate_plugin_component_lifecycle_replay_complete($lifecycle);
if (is_wp_error($result)) {
    throw new RuntimeException('Failed to activate extra plugin ' . $plugin_file . ': ' . $result->get_error_message());
}
do_action('wp_codebox_runtime_plugin_activated', $plugin_file);
echo wp_json_encode(array('activated' => $plugin_file));`
}
