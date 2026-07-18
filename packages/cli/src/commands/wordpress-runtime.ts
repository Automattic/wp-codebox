import { createHash } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fuzzRunnerReadinessContract, minimizeFuzzCase, parseCommandJson, parseCommandOptions, PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES, runFuzzSuite, RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES, wordpressFuzzRuntimeContract, wordpressWorkloadRunRecipe, type ExecutionResult, type ExecutionSpec, type FuzzSuiteContract, type FuzzSuiteRuntimeWorkloadExecutionInput, type RuntimePolicy, type WordPressWorkloadRunRecipeOptions, type WorkspaceRecipe, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeMount } from "@automattic/wp-codebox-core"
import { createWordPressEpisode, createWordPressFuzzSuiteRuntimeActionExecutor, executeWordPressFuzzSuite } from "@automattic/wp-codebox-playground/public"
import { captureStdout } from "../output.js"
import { runRecipeRunCommand } from "./recipe-run.js"

const FUZZ_SUITE_RESULT_SCHEMA = "wp-codebox/fuzz-suite-result/v1"
const WORDPRESS_WORKLOAD_RUN_RESULT_SCHEMA = "wp-codebox/wordpress-workload-run-result/v1"

interface PublicRuntimeCommandOptions {
  input: Record<string, unknown>
  json: boolean
  dryRun: boolean
  artifactsDirectory?: string
  runRegistryDirectory?: string
  timeout?: string
  runnerMode?: "simple" | "runtime-backed"
}

export async function runFuzzSuiteCommand(args: string[]): Promise<number> {
  if (isHelp(args)) {
    printFuzzSuiteHelp()
    return 0
  }

  const options = await parsePublicRuntimeCommandOptions(args)
  const suite = normalizePublicFuzzSuite(options.input)
  if (options.runnerMode === "runtime-backed" && !options.dryRun && !fuzzSuiteRequiresRecipeRuntime(options.input)) {
    await runRuntimeBackedFuzzSuiteCommand(options, suite)
    return 0
  }

  const result = await runFuzzSuite(suite, {
    executor: (spec) => runWordPressFuzzCommand(spec, options),
    runtimeWorkloadExecutor: (input) => runWordPressWorkloadFuzzCase(input, options),
    supportedTargetKinds: ["runtime"],
    metadata: {
      public_cli_command: "run-fuzz-suite",
      dry_run: options.dryRun || undefined,
    },
  })
  const { schema: _schema, ...resultFields } = result
  writeJson({ schema: FUZZ_SUITE_RESULT_SCHEMA, ...resultFields })
  return 0
}

export async function runFuzzMinimizeCaseCommand(args: string[]): Promise<number> {
  if (isHelp(args)) {
    printFuzzMinimizeCaseHelp()
    return 0
  }

  const options = await parsePublicRuntimeCommandOptions(args)
  if (options.dryRun) {
    writeJson({ schema: "wp-codebox/fuzz-minimize-case-result/v1", status: "blocked", caseId: stringValue(objectOption(options.input.case)?.id) ?? "replay-case", originalSteps: 0, minimizedSteps: 0, diagnostics: [{ severity: "error", code: "fuzz_minimize_case_dry_run_not_executable", message: "fuzz-minimize-case requires real replay execution; dry-run cannot prove that a case is reduced." }], attempts: [] })
    return 0
  }

  const requirements = fuzzSuiteRuntimeRequirements(options.input)
  const episode = await createWordPressEpisode({
    runtime: {
      environment: { kind: "wordpress", name: "WordPress", blueprint: objectOption(requirements?.blueprint) ?? { steps: [] } },
      policy: { network: "allow", filesystem: "sandbox", commands: RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.commands ?? [], secrets: "none", approvals: "never" },
      runtimeEnv: runtimeRequirementEnv(undefined, requirements?.runtime_env, requirements?.bench_env),
      artifactsDirectory: options.artifactsDirectory,
      metadata: { public_cli_command: "fuzz-minimize-case" },
    },
  })
  try {
    const runtimeActionExecutor = createWordPressFuzzSuiteRuntimeActionExecutor(episode)
    const result = await minimizeFuzzCase({ replayCase: options.input }, {
      runtimeActionExecutor,
      metadata: { public_cli_command: "fuzz-minimize-case" },
    })
    writeJson(result)
  } finally {
    await episode.close()
  }
  return 0
}

export async function runFuzzDescriptorCommand(args: string[]): Promise<number> {
  if (isHelp(args)) {
    printFuzzDescriptorHelp()
    return 0
  }

  const { options, positionals } = parseCommandOptions(args, new Set(["--json"]))
  if (positionals.length > 0) {
    throw new Error(`Invalid argument: ${positionals[0]}`)
  }
  for (const name of options.keys()) {
    if (!["--format", "--json"].includes(name)) {
      throw new Error(`Unknown option: ${name}`)
    }
  }
  writeJson(wordpressFuzzRuntimeContract())
  return 0
}

export async function runFuzzReadinessCommand(args: string[]): Promise<number> {
  if (isHelp(args)) {
    printFuzzReadinessHelp()
    return 0
  }

  const { options, positionals } = parseCommandOptions(args, new Set(["--json"]))
  if (positionals.length > 0) {
    throw new Error(`Invalid argument: ${positionals[0]}`)
  }
  for (const name of options.keys()) {
    if (!["--mode", "--runner-mode", "--format", "--json"].includes(name)) {
      throw new Error(`Unknown option: ${name}`)
    }
  }
  const mode = stringOption(options, "--mode") ?? stringOption(options, "--runner-mode") ?? "runtime-backed"
  const capabilities = mode === "simple" || mode === "php-in-process"
    ? PHP_IN_PROCESS_FUZZ_SUITE_RUNNER_CAPABILITIES
    : mode === "runtime-backed"
      ? RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES
      : undefined
  if (!capabilities) {
    throw new Error(`Invalid fuzz runner mode: ${mode}`)
  }
  writeJson(fuzzRunnerReadinessContract({ ...capabilities, metadata: { public_cli_command: "fuzz readiness" } }))
  return 0
}

async function runRuntimeBackedFuzzSuiteCommand(options: PublicRuntimeCommandOptions, suite = normalizePublicFuzzSuite(options.input)): Promise<void> {
  const requirements = fuzzSuiteRuntimeRequirements(options.input)
  const episode = await createWordPressEpisode({
    runtime: {
      environment: {
        kind: "wordpress",
        name: "WordPress",
        version: stringValue(options.input.wordpressVersion ?? options.input.wordpress_version ?? options.input.wp),
        blueprint: objectOption(requirements?.blueprint) ?? { steps: [] },
      },
      policy: runtimeBackedFuzzSuitePolicy(suite),
      runtimeEnv: runtimeRequirementEnv(undefined, requirements?.runtime_env, requirements?.bench_env),
      artifactsDirectory: options.artifactsDirectory,
      metadata: {
        public_cli_command: "run-fuzz-suite",
        runner_mode: "runtime-backed",
      },
    },
  })
  try {
    const result = await executeWordPressFuzzSuite(episode, suite, {
      metadata: {
        public_cli_command: "run-fuzz-suite",
      },
    })
    const { schema: _schema, ...resultFields } = result
    writeJson({ schema: FUZZ_SUITE_RESULT_SCHEMA, ...resultFields })
  } finally {
    await episode.close()
  }
}

function normalizePublicFuzzSuite(input: Record<string, unknown>): FuzzSuiteContract {
  return {
    ...input,
    schema: "wp-codebox/fuzz-suite/v1",
    id: stringValue(input.id) ?? "wordpress-fuzz-suite",
    cases: arrayOption(input.cases) as FuzzSuiteContract["cases"],
  } as FuzzSuiteContract
}

function runtimeBackedFuzzSuitePolicy(suite: FuzzSuiteContract): RuntimePolicy {
  return {
    network: "allow",
    filesystem: "sandbox",
    commands: runtimeBackedFuzzSuiteCommands(suite),
    secrets: "none",
    approvals: "never",
  }
}

function fuzzSuiteRequiresRecipeRuntime(input: Record<string, unknown>): boolean {
  const requirements = fuzzSuiteRuntimeRequirements(input)
  return arrayOption(requirements?.extra_plugins).length > 0 || arrayOption(requirements?.component_contracts).length > 0 || Boolean(runtimeRequirementWordPressDirectory(requirements))
}

function runtimeBackedFuzzSuiteCommands(suite: FuzzSuiteContract): string[] {
  const commands = new Set(RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES.commands ?? [])
  const addTargetCommand = (target: unknown): void => {
    const record = objectOption(target)
    const command = stringValue(record?.entrypoint) ?? stringValue(record?.id)
    if (command) commands.add(command)
  }
  addTargetCommand(suite.target)
  for (const fuzzCase of arrayOption(suite.cases)) {
    const record = objectOption(fuzzCase)
    addTargetCommand(record?.target)
  }
  return [...commands].sort()
}

async function runWordPressFuzzCommand(spec: ExecutionSpec, options: PublicRuntimeCommandOptions): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString()
  const requirements = fuzzSuiteRuntimeRequirements(options.input)
  const step = { command: spec.command, args: spec.args ?? [], ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}) }
  const recipe = wordpressWorkloadRunRecipe(workloadRecipeOptions({ steps: [step] }, requirements)) as WorkspaceRecipe
  applyFuzzSuiteRuntimeRequirements(recipe, requirements)
  const tempDir = await mkdtemp(join(tmpdir(), "wp-codebox-fuzz-command-"))
  try {
    const recipePath = join(tempDir, "recipe.json")
    await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8")
    const recipeArgs = ["--recipe", recipePath, "--json"]
    if (options.dryRun) recipeArgs.push("--dry-run")
    if (options.artifactsDirectory) recipeArgs.push("--artifacts", options.artifactsDirectory)
    if (options.runRegistryDirectory) recipeArgs.push("--run-registry", options.runRegistryDirectory)
    if (options.timeout) recipeArgs.push("--timeout", options.timeout)
    const { result: exitCode, logs } = await captureStdout(() => runRecipeRunCommand(recipeArgs))
    const stdout = logs.join("")
    const recipeResult = parseRecipeRunOutput(stdout)
    const stderr = recipeResult?.error && typeof recipeResult.error === "object" && "message" in recipeResult.error ? String(recipeResult.error.message) : ""
    return {
      id: `wordpress-fuzz-command-${createHash("sha256").update(`${spec.command}\0${JSON.stringify(spec.args ?? [])}`).digest("hex").slice(0, 12)}`,
      command: spec.command,
      args: spec.args ?? [],
      exitCode,
      stdout,
      stderr,
      result: { schema: "wp-codebox/runtime-command-result/v1", status: exitCode === 0 ? "ok" : "error", stdout, stderr, json: recipeResult },
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactRefs: recipeArtifactRefs(recipeResult),
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function runWordPressWorkloadCommand(args: string[]): Promise<number> {
  if (isHelp(args)) {
    printWordPressWorkloadHelp()
    return 0
  }

  const options = await parsePublicRuntimeCommandOptions(args)
  const recipe = wordpressWorkloadRunRecipe(workloadRecipeOptions(options.input)) as unknown as Record<string, unknown>
  const tempDir = await mkdtemp(join(tmpdir(), "wp-codebox-workload-cli-"))
  try {
    const recipePath = join(tempDir, "recipe.json")
    await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8")
    const recipeArgs = ["--recipe", recipePath, "--json"]
    if (options.dryRun) recipeArgs.push("--dry-run")
    if (options.artifactsDirectory) recipeArgs.push("--artifacts", options.artifactsDirectory)
    if (options.runRegistryDirectory) recipeArgs.push("--run-registry", options.runRegistryDirectory)
    if (options.timeout) recipeArgs.push("--timeout", options.timeout)
    const { result: exitCode, logs } = await captureStdout(() => runRecipeRunCommand(recipeArgs))
    for (const log of logs) {
      process.stdout.write(`${log}\n`)
    }
    return logs.length > 0 ? 0 : exitCode
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function runWordPressWorkloadFuzzCase(input: FuzzSuiteRuntimeWorkloadExecutionInput, options: PublicRuntimeCommandOptions): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString()
  const requirements = fuzzSuiteRuntimeRequirements(options.input)
  const workload = normalizeWordPressWorkloadRequest(input.workload, options.input, requirements)
  const recipe = wordpressWorkloadRunRecipe(workloadRecipeOptions(workload, requirements)) as WorkspaceRecipe
  applyFuzzSuiteRuntimeRequirements(recipe, requirements)
  const tempDir = await mkdtemp(join(tmpdir(), "wp-codebox-fuzz-workload-"))
  try {
    const recipePath = join(tempDir, "recipe.json")
    await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8")
    const recipeArgs = ["--recipe", recipePath, "--json"]
    if (options.dryRun) recipeArgs.push("--dry-run")
    if (options.artifactsDirectory) recipeArgs.push("--artifacts", options.artifactsDirectory)
    if (options.runRegistryDirectory) recipeArgs.push("--run-registry", options.runRegistryDirectory)
    if (options.timeout) recipeArgs.push("--timeout", options.timeout)
    const { result: exitCode, logs } = await captureStdout(() => runRecipeRunCommand(recipeArgs))
    const stdout = logs.join("")
    const recipeResult = parseRecipeRunOutput(stdout)
    return {
      id: `wordpress-run-workload-${input.case.id}`,
      command: "wordpress.run-workload",
      args: [`steps=${Array.isArray(input.workload.steps) ? input.workload.steps.length : 0}`],
      exitCode,
      stdout,
      stderr: recipeResult?.error && typeof recipeResult.error === "object" && "message" in recipeResult.error ? String(recipeResult.error.message) : "",
      result: { schema: "wp-codebox/runtime-command-result/v1", status: exitCode === 0 ? "ok" : "error", stdout, stderr: recipeResult?.error && typeof recipeResult.error === "object" && "message" in recipeResult.error ? String(recipeResult.error.message) : "", json: recipeResult },
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactRefs: recipeArtifactRefs(recipeResult),
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function applyFuzzSuiteRuntimeRequirements(recipe: WorkspaceRecipe, requirements: Record<string, unknown> | undefined): void {
  if (!requirements) return
  const inputs = recipe.inputs ?? {}
  const runtime = recipe.runtime ?? {}
  recipe.inputs = {
    ...inputs,
    extra_plugins: runtimeRequirementExtraPlugins(requirements, inputs.extra_plugins),
    runtimeEnv: runtimeRequirementEnv(inputs.runtimeEnv, requirements.runtime_env, requirements.bench_env),
  }
  recipe.runtime = {
    ...runtime,
    assets: runtimeRequirementWordPressDirectory(requirements)
      ? { ...(runtime.assets ?? {}), wordpressDirectory: runtimeRequirementWordPressDirectory(requirements) }
      : runtime.assets,
    stack: arrayOption(requirements.runtime_mounts).length > 0 ? { ...(runtime.stack ?? {}), mounts: arrayOption(requirements.runtime_mounts) as WorkspaceRecipeMount[] } : runtime.stack,
  }
  recipe.metadata = {
    ...(recipe.metadata ?? {}),
    runtime_requirements: requirements,
  }
}

function runtimeRequirementWordPressDirectory(requirements: Record<string, unknown> | undefined): string | undefined {
  return requirements ? stringValue(requirements.wordpress_directory) : undefined
}

function fuzzSuiteRuntimeRequirements(suiteInput: Record<string, unknown>): Record<string, unknown> | undefined {
  return objectOption(objectOption(suiteInput.metadata)?.runtime_requirements)
}

function runtimeRequirementExtraPlugins(requirements: Record<string, unknown>, fallback: WorkspaceRecipeExtraPlugin[] | undefined): WorkspaceRecipeExtraPlugin[] | undefined {
  const extraPlugins = arrayOption(requirements.extra_plugins)
  if (extraPlugins.length > 0) {
    return normalizeRuntimeRequirementExtraPlugins(extraPlugins, fallback)
  }
  const componentContracts = arrayOption(requirements.component_contracts)
  return componentContracts.length > 0 ? normalizeRuntimeRequirementExtraPlugins(componentContracts, fallback) : fallback
}

function normalizeRuntimeRequirementExtraPlugins(value: unknown[], fallback: WorkspaceRecipeExtraPlugin[] | undefined): WorkspaceRecipeExtraPlugin[] | undefined {
  const plugins = value.flatMap((entry) => {
    const plugin = objectOption(entry)
    const source = stringValue(plugin?.source) ?? stringValue(plugin?.path)
    if (!plugin || !source) return []
    return [{
      source,
      sourceRoot: stringValue(plugin.sourceRoot ?? plugin.source_root),
      sourceSubpath: stringValue(plugin.sourceSubpath ?? plugin.source_subpath),
      originalSource: stringValue(plugin.originalSource ?? plugin.original_source),
      slug: stringValue(plugin.slug),
      pluginFile: stringValue(plugin.pluginFile ?? plugin.plugin_file),
      activate: typeof plugin.activate === "boolean" ? plugin.activate : undefined,
      loadAs: plugin.loadAs === "plugin" || plugin.loadAs === "mu-plugin" ? plugin.loadAs : plugin.load_as === "plugin" || plugin.load_as === "mu-plugin" ? plugin.load_as : undefined,
      sha256: stringValue(plugin.sha256),
      metadata: objectOption(plugin.metadata),
    } satisfies WorkspaceRecipeExtraPlugin]
  })
  return plugins.length > 0 ? plugins : fallback
}

function runtimeRequirementEnv(base: Record<string, string> | undefined, ...extras: unknown[]): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...(base ?? {}) }
  for (const extra of extras) {
    for (const [key, value] of Object.entries(objectOption(extra) ?? {})) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        merged[key] = String(value)
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function parseRecipeRunOutput(stdout: string): Record<string, unknown> | undefined {
  try {
    return objectOption(JSON.parse(stdout.trim() || "{}"))
  } catch (_error) {
    return undefined
  }
}

function recipeArtifactRefs(output: Record<string, unknown> | undefined): ExecutionResult["artifactRefs"] {
  const artifacts = objectOption(output?.artifacts)
  const refs = arrayOption(artifacts?.refs ?? artifacts?.files ?? output?.artifactRefs ?? output?.artifact_refs)
  return refs.flatMap((ref) => objectOption(ref) ? [ref as NonNullable<ExecutionResult["artifactRefs"]>[number]] : [])
}

async function parsePublicRuntimeCommandOptions(args: string[]): Promise<PublicRuntimeCommandOptions> {
  const { options, positionals } = parseCommandOptions(args, new Set(["--json", "--dry-run"]))
  if (positionals.length > 0) {
    throw new Error(`Invalid argument: ${positionals[0]}`)
  }

  for (const name of options.keys()) {
    if (!["--input-file", "--input-json", "--format", "--json", "--dry-run", "--artifacts", "--run-registry", "--timeout", "--runner-mode"].includes(name)) {
      throw new Error(`Unknown option: ${name}`)
    }
  }

  const rawRunnerMode = stringOption(options, "--runner-mode")
  if (rawRunnerMode && rawRunnerMode !== "simple" && rawRunnerMode !== "runtime-backed") {
    throw new Error(`Invalid --runner-mode: ${rawRunnerMode}`)
  }
  const runnerMode = rawRunnerMode as PublicRuntimeCommandOptions["runnerMode"]

  const input = await readInput(options)
  return {
    input,
    json: options.get("--json") === true || options.get("--format") === "json",
    dryRun: options.get("--dry-run") === true,
    artifactsDirectory: stringOption(options, "--artifacts"),
    runRegistryDirectory: stringOption(options, "--run-registry"),
    timeout: stringOption(options, "--timeout"),
    runnerMode,
  }
}

async function readInput(options: Map<string, string | true>): Promise<Record<string, unknown>> {
  const inputFile = stringOption(options, "--input-file")
  const inputJson = stringOption(options, "--input-json")
  if (inputFile && inputJson) {
    throw new Error("Use either --input-file or --input-json, not both")
  }
  if (inputFile) {
    const parsed = parseCommandJson(await readFile(resolve(inputFile), "utf8"), "--input-file")
    return objectInput(parsed, "--input-file")
  }
  if (inputJson) {
    return objectInput(parseCommandJson(inputJson, "--input-json"), "--input-json")
  }
  throw new Error("Missing required option: --input-file")
}

function workloadRecipeOptions(input: Record<string, unknown>, runtimeRequirements?: Record<string, unknown>): WordPressWorkloadRunRecipeOptions {
  const steps = workloadRecipeSteps(input, runtimeRequirements)
  return {
    wordpressVersion: stringValue(input.wordpressVersion ?? input.wordpress_version ?? input.wp),
    wordpressDirectory: stringValue(input.wordpress_directory),
    blueprint: input.blueprint,
    preview: objectOption(input.preview) as WordPressWorkloadRunRecipeOptions["preview"],
    mounts: arrayOption(input.mounts) as WordPressWorkloadRunRecipeOptions["mounts"],
    runtimeStackMounts: arrayOption(input.runtimeStackMounts ?? input.runtime_stack_mounts) as WordPressWorkloadRunRecipeOptions["runtimeStackMounts"],
    runtimeOverlays: arrayOption(input.runtimeOverlays ?? input.runtime_overlays) as WordPressWorkloadRunRecipeOptions["runtimeOverlays"],
    runtimeEnv: objectOption(input.runtimeEnv ?? input.runtime_env) as WordPressWorkloadRunRecipeOptions["runtimeEnv"],
    secretEnv: arrayOption(input.secretEnv ?? input.secret_env).map(String),
    stagedFiles: arrayOption(input.stagedFiles ?? input.staged_files) as WordPressWorkloadRunRecipeOptions["stagedFiles"],
    before: arrayOption(input.before) as WordPressWorkloadRunRecipeOptions["before"],
    steps: steps as WordPressWorkloadRunRecipeOptions["steps"],
    after: arrayOption(input.after) as WordPressWorkloadRunRecipeOptions["after"],
    capture: objectOption(input.capture) as WordPressWorkloadRunRecipeOptions["capture"],
    enableQueryCapture: typeof input.enableQueryCapture === "boolean" ? input.enableQueryCapture : typeof input.enable_query_capture === "boolean" ? input.enable_query_capture : undefined,
  }
}

function normalizeWordPressWorkloadRequest(input: Record<string, unknown>, suiteInput?: Record<string, unknown>, runtimeRequirements?: Record<string, unknown>): Record<string, unknown> {
  const stagedFiles = arrayOption(input.stagedFiles ?? input.staged_files)
  let changed = false
  const normalized: Record<string, unknown> = workloadWithRuntimeRequirementSettings(input, runtimeRequirements)
  changed = normalized !== input
  const packageRoot = workloadPackageRoot(input, suiteInput)

  for (const phase of ["before", "steps", "after"] as const) {
    const steps = arrayOption(input[phase])
    const nextSteps = steps.map((step) => {
      const normalizedStep = normalizeWordPressWorkloadStep(step, normalized, packageRoot, stagedFiles)
      if (normalizedStep !== step) changed = true
      return normalizedStep
    })
    if (steps.length > 0) normalized[phase] = nextSteps
  }

  if (stagedFiles.length > 0) {
    normalized.stagedFiles = stagedFiles
    delete normalized.staged_files
    changed = true
  }

  return changed ? normalized : input
}

function normalizeWordPressWorkloadStep(step: unknown, workload: Record<string, unknown>, packageRoot: string | undefined, stagedFiles: unknown[]): unknown {
  const record = objectOption(step)
  if (!record || record.command !== "wordpress.run-workload") return step
  const args = parseStepArgs(arrayOption(record.args))
  if ((args.type ?? "").toLowerCase() !== "php") return step

  const resolved = resolveWorkloadPhpPath(args.path ?? args.file ?? "", packageRoot)
  const runtimePath = resolved ? stageWordPressWorkloadFile(resolved, stagedFiles) : args.path ?? args.file ?? ""
  const wrapperArgs: Record<string, string> = { ...args, path: runtimePath }
  delete wrapperArgs.file

  return {
    ...record,
    command: "wordpress.run-php",
    args: [`code=${wordpressWorkloadPhpWrapper(runtimePath, workload, wrapperArgs)}`],
  }
}

function stageWordPressWorkloadFile(source: string, stagedFiles: unknown[]): string {
  const target = `/tmp/wp-codebox-workloads/${createHash("sha256").update(source).digest("hex").slice(0, 16)}-${basename(source)}`
  const exists = stagedFiles.some((entry) => objectOption(entry)?.source === source && objectOption(entry)?.target === target)
  if (!exists) {
    stagedFiles.push({ source, target })
  }
  return target
}

function resolveWorkloadPhpPath(path: string, packageRoot: string | undefined): string | undefined {
  const raw = path.trim()
  if (!raw) return undefined
  const expanded = packageRoot ? raw.replaceAll("${package.root}", packageRoot).replaceAll("{{package.root}}", packageRoot) : raw
  const candidates = [expanded]
  if (packageRoot && !isAbsolute(expanded)) candidates.push(join(packageRoot, expanded))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate)
    } catch (_error) {
      continue
    }
  }
  return undefined
}

function workloadPackageRoot(input: Record<string, unknown>, suiteInput?: Record<string, unknown>): string | undefined {
  for (const value of [
    objectOption(input.package),
    objectOption(input.runtime_package),
    objectOption(objectOption(input.metadata)?.runtime_package_descriptor),
    objectOption(objectOption(suiteInput?.metadata)?.runtime_package_descriptor),
    objectOption(objectOption(suiteInput?.metadata)?.runtimePackageDescriptor),
  ]) {
    const source = stringValue(value?.source)
    if (!source) continue
    const resolved = resolve(source)
    if (!existsSync(resolved)) continue
    return statSync(resolved).isFile() ? dirname(realpathSync(resolved)) : realpathSync(resolved)
  }
  return undefined
}

function wordpressWorkloadPhpWrapper(path: string, workload: Record<string, unknown>, args: Record<string, string>): string {
  const encodedInput = Buffer.from(JSON.stringify(wordpressWorkloadPhpWrapperInput(workload)), "utf8").toString("base64")
  const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64")
  return `${wordpressWorkloadExternalHttpGuardrailHelpers()}\n$__wp_codebox_workload_input = json_decode(base64_decode('${encodedInput}'), true);\n$__wp_codebox_workload_args = json_decode(base64_decode('${encodedArgs}'), true);\n$__wp_codebox_workload_callable = require ${JSON.stringify(path)};\nif (!is_callable($__wp_codebox_workload_callable)) { throw new RuntimeException('PHP workload file must return a callable.'); }\n$__wp_codebox_workload_result = $__wp_codebox_workload_callable(is_array($__wp_codebox_workload_input) ? $__wp_codebox_workload_input : array(), is_array($__wp_codebox_workload_args) ? $__wp_codebox_workload_args : array());\nif (is_array($__wp_codebox_workload_result) || is_object($__wp_codebox_workload_result)) { echo json_encode($__wp_codebox_workload_result, JSON_UNESCAPED_SLASHES) . "\\n"; } elseif (false === $__wp_codebox_workload_result) { exit(1); }`
}

function wordpressWorkloadExternalHttpGuardrailHelpers(): string {
  return `if (!function_exists('wp_codebox_bench_run_external_http_guardrail_step')) {
    function wp_codebox_bench_run_external_http_guardrail_step(array $args): array {
        $state = is_array($GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : array('allowlist' => array(), 'block' => true, 'requests' => array());
        $action = (string) ($args['action'] ?? 'collect');
        if ($action === 'install') {
            $allowlist = $args['allowlistDomains'] ?? $args['allowlist'] ?? array();
            $state = array('allowlist' => array_values(array_filter(array_map('strval', is_array($allowlist) ? $allowlist : explode(',', (string) $allowlist)))), 'block' => (bool) ($args['blockNetwork'] ?? $args['block_network'] ?? true), 'requests' => array());
            $GLOBALS['wp_codebox_external_http_guardrail_state'] = $state;
            if (empty($GLOBALS['wp_codebox_external_http_guardrail_filter_installed'])) {
                add_filter('pre_http_request', 'wp_codebox_external_http_guardrail_pre_http_request', 10, 3);
                $GLOBALS['wp_codebox_external_http_guardrail_filter_installed'] = true;
            }
        }
        $state = is_array($GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : $state;
        $requests = is_array($state['requests'] ?? null) ? $state['requests'] : array();
        $blocked = count(array_filter($requests, static fn(array $request): bool => ($request['classification'] ?? '') === 'blocked'));
        $allowlisted = count(array_filter($requests, static fn(array $request): bool => ($request['classification'] ?? '') === 'allowlisted_boundary_blocked'));
        return array('schema' => 'wp-codebox/external-http-guardrail/v1', 'status' => 'passed', 'summary' => array('total' => count($requests), 'blocked' => $blocked, 'allowlisted' => $allowlisted), 'requests' => $requests, 'metadata' => array('runner' => 'wp-codebox/wordpress-workload-run/v1', 'allowlist' => array_values(array_map('strval', $state['allowlist'] ?? array()))));
    }
}
if (!function_exists('wp_codebox_external_http_guardrail_pre_http_request')) {
    function wp_codebox_external_http_guardrail_pre_http_request($preempt, array $parsed_args, string $url) {
        $state = is_array($GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : array();
        $host = strtolower((string) wp_parse_url($url, PHP_URL_HOST));
        $allowlist = array_map('strtolower', array_map('strval', is_array($state['allowlist'] ?? null) ? $state['allowlist'] : array()));
        $classification = in_array($host, $allowlist, true) ? 'allowlisted_boundary_blocked' : 'blocked';
        $state['requests'][] = array('url' => preg_replace('/([?&](?:token|secret|nonce|_wpnonce|authorization)=)[^&]+/i', '$1[redacted]', $url), 'host' => $host, 'method' => (string) ($parsed_args['method'] ?? 'GET'), 'classification' => $classification);
        $GLOBALS['wp_codebox_external_http_guardrail_state'] = $state;
        if (!empty($state['block'])) {
            return new WP_Error('wp_codebox_external_http_guardrail_blocked', 'External HTTP request blocked by WP Codebox fuzz guardrail.', array('host' => $host, 'classification' => $classification));
        }
        return $preempt;
    }
}`
}

function workloadWithRuntimeRequirementSettings(workload: Record<string, unknown>, runtimeRequirements: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!runtimeRequirements) return workload
  const next: Record<string, unknown> = { ...workload }
  let changed = false
  for (const [sourceKey, targetKey] of [["runtime_env", "runtime_env"], ["bench_env", "bench_env"], ["settings", "settings"]] as const) {
    const value = runtimeRequirements[sourceKey]
    if (objectOption(value) && next[targetKey] === undefined) {
      next[targetKey] = value
      changed = true
    }
  }
  return changed ? next : workload
}

function wordpressWorkloadPhpWrapperInput(workload: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...workload }
  if (input.runtimeEnv === undefined && objectOption(input.runtime_env)) {
    input.runtimeEnv = input.runtime_env
  }
  if (input.runtime_env === undefined && objectOption(input.runtimeEnv)) {
    input.runtime_env = input.runtimeEnv
  }
  return input
}

function parseStepArgs(args: unknown[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const arg of args) {
    const [key, value = ""] = String(arg).split(/=(.*)/s, 2)
    if (key) parsed[key] = value
  }
  return parsed
}

function workloadRecipeSteps(input: Record<string, unknown>, runtimeRequirements?: Record<string, unknown>): unknown[] {
  const steps = arrayOption(input.steps)
  if (!steps.some((step) => objectOption(step)?.command === undefined && typeof objectOption(step)?.type === "string")) {
    return steps
  }
  const workload = {
    id: stringValue(input.id) ?? "wordpress-workload",
    run: steps,
    metadata: objectOption(input.metadata),
  }
  return [{
    command: "wordpress.bench",
    args: [
      `plugin-slug=${runtimeRequirementPluginSlug(runtimeRequirements) ?? "wordpress"}`,
      `workloads-json=${JSON.stringify([workload])}`,
    ],
  }]
}

function runtimeRequirementPluginSlug(requirements: Record<string, unknown> | undefined): string | undefined {
  for (const plugin of arrayOption(requirements?.extra_plugins)) {
    const slug = objectOption(plugin)?.slug
    if (typeof slug === "string" && slug.trim()) return slug
  }
  for (const plugin of arrayOption(requirements?.component_contracts)) {
    const slug = objectOption(plugin)?.slug
    if (typeof slug === "string" && slug.trim()) return slug
  }
  return undefined
}

function objectInput(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

function objectOption(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayOption(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringOption(options: Map<string, string | true>, name: string): string | undefined {
  const value = options.get(name)
  return typeof value === "string" && value.trim() ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function isHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h")
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printFuzzSuiteHelp(): void {
  process.stdout.write(`Usage: wp-codebox run-fuzz-suite --input-file <path> [--format=json] [--dry-run] [--runner-mode=simple|runtime-backed]\n\nRuns a wp-codebox/fuzz-suite/v1 JSON payload through the public fuzz-suite runner.\n`)
}

function printFuzzDescriptorHelp(): void {
  process.stdout.write("Usage: wp-codebox fuzz descriptor [--format=json]\n\nPrints the public wp-codebox/wordpress-fuzz-runtime-contract/v1 descriptor for orchestrator consumers.\n")
}

function printFuzzMinimizeCaseHelp(): void {
  process.stdout.write(`Usage: wp-codebox fuzz-minimize-case --input-file <path> [--format=json] [--dry-run]\n\nMinimizes a wp-codebox/fuzz-replay-case-input/v1 runtime-action sequence by replaying candidate subsequences through the public fuzz-suite runner.\n`)
}

function printFuzzReadinessHelp(): void {
  process.stdout.write("Usage: wp-codebox fuzz readiness [--mode=runtime-backed|simple] [--format=json]\n\nPrints the public fuzz runner readiness and capabilities contract.\n")
}

function printWordPressWorkloadHelp(): void {
  process.stdout.write(`Usage: wp-codebox run-wordpress-workload --input-file <path> [--format=json] [--dry-run]\n\nRuns a wp-codebox/wordpress-workload-run/v1 JSON payload through the public WordPress workload recipe boundary.\nResult schema: ${WORDPRESS_WORKLOAD_RUN_RESULT_SCHEMA}\n`)
}
