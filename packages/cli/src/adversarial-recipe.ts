import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  ADVERSARIAL_ORACLE_SCHEMA,
  adversarialCampaign,
  adversarialFindingFingerprint,
  artifactManifestFile,
  refreshArtifactManifestFileSha256s,
  runAdversarialCampaign,
  upsertArtifactManifestFiles,
  writeAdversarialEvidenceBundle,
  type AdversarialCampaignResult,
  type AdversarialCasePlan,
  type AdversarialExecutionObservation,
  type AdversarialReplay,
  type ArtifactBundle,
  type ArtifactManifest,
  type Runtime,
  type WorkspaceRecipe,
  type WorkspaceRecipeAdversarialCampaign,
  type WorkspaceRecipeFuzzCasePhase,
  type WorkspaceRecipeStep,
} from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { negotiateWordPressServerClock, wordpressServerClockCleanupAction, wordpressServerClockScheduleAction, type WordPressServerClockNegotiation } from "@automattic/wp-codebox-playground"

import type { InputMountPathMapping } from "./input-mount-paths.js"
import { recipeAdversarialCapabilities } from "./recipe-validation.js"
import { executeRecipeWorkflowStep } from "./commands/recipe-run-workflow-evidence.js"
import type { RecipeExecutionResult, RecipeRunOptions } from "./commands/recipe-run-types.js"

export interface RecipeAdversarialCampaignOutput {
  declaration: WorkspaceRecipeAdversarialCampaign
  result: AdversarialCampaignResult
  capabilities: {
    available: string[]
    required: string[]
    optional: Array<{ id: string; available: boolean }>
    clock?: WordPressServerClockNegotiation
  }
  evidence?: Awaited<ReturnType<typeof writeAdversarialEvidenceBundle>>
}

export function recipeAdversarialCampaignFailure(campaigns: RecipeAdversarialCampaignOutput[]): { name: string; code: string; message: string } | undefined {
  const incomplete = campaigns.find((campaign) => campaign.result.status === "incomplete")
  if (!incomplete) return undefined
  return {
    name: "RecipeAdversarialCampaignError",
    code: "adversarial-campaign-incomplete",
    message: `Adversarial campaign ${incomplete.declaration.id} did not complete: ${incomplete.result.diagnostics.map(({ message }) => message).join(" ") || "resource or orchestration failure"}`,
  }
}

interface RunRecipeAdversarialCampaignsOptions {
  recipe: WorkspaceRecipe
  recipePath: string
  recipeDirectory: string
  runtime: Runtime
  sandboxWorkspace?: Parameters<typeof executeRecipeWorkflowStep>[3]
  artifactRoot?: string
  runOptions?: RecipeRunOptions
  inputMountPathMap?: readonly InputMountPathMapping[]
  signal?: AbortSignal
  executions: RecipeExecutionResult[]
  provenance?: Record<string, unknown>
  managedServices?: { resetSmtpSink(serviceId: string): Promise<unknown> }
}

export async function runRecipeAdversarialCampaigns(options: RunRecipeAdversarialCampaignsOptions): Promise<RecipeAdversarialCampaignOutput[]> {
  const outputs: RecipeAdversarialCampaignOutput[] = []
  const capabilities = recipeAdversarialCapabilities(options.recipe)
  const replay = options.runOptions?.adversarialReplayPath ? await readAdversarialReplay(options.runOptions.adversarialReplayPath, process.cwd()) : undefined
  for (const declaration of options.recipe.adversarialCampaigns ?? []) {
    if (replay && replay.campaignId !== declaration.id) continue
    const checkpointName = declaration.resetPolicy?.mode === "checkpoint-per-case"
      ? declaration.resetPolicy.checkpointName ?? declaration.resetPolicy.checkpoint_name ?? `${declaration.id}-baseline`
      : undefined
    if (checkpointName) {
      if (!options.runtime.createCheckpoint || !options.runtime.restoreCheckpoint) throw new Error(`Adversarial campaign ${declaration.id} requires runtime checkpoint create and restore support.`)
      await options.runtime.createCheckpoint({ name: checkpointName, metadata: { campaignId: declaration.id, immutableBaseline: true } })
    }
    const templates = new Map(declaration.caseTemplates.map((template) => [template.id, template]))
    const clockTransitions = declaration.corpus.flatMap(({ actions }) => actions.flatMap((action) => action.clock ?? []))
    const runtimeInfo = clockTransitions.length > 0 ? await options.runtime.info() : undefined
    if (clockTransitions.length > 0 && runtimeInfo?.backend !== "wordpress-playground") {
      throw new Error(`Recipe adversarial campaign ${declaration.id} requires server clock transitions, but runtime backend ${runtimeInfo?.backend ?? "unknown"} does not provide the WordPress Playground clock adapter.`)
    }
    const clockNegotiation = clockTransitions.length > 0 ? negotiateWordPressServerClock(clockTransitions) : undefined
    if (clockNegotiation && !clockNegotiation.supported) {
      throw new Error(`Recipe adversarial campaign ${declaration.id} has unsupported clock transitions: ${clockNegotiation.unsupported.map(({ surface, operation, reason }) => `${surface}.${operation} (${reason})`).join(", ")}`)
    }
    const campaign = adversarialCampaign({
      id: declaration.id,
      seed: declaration.seed,
      corpus: declaration.corpus,
      mutationKinds: declaration.mutators,
      budgets: { ...declaration.budgets, workers: declaration.concurrency ?? 1 },
      oracles: declaration.oracles.map((oracle) => ({ ...oracle, schema: ADVERSARIAL_ORACLE_SCHEMA })),
      matrix: declaration.matrix,
      faults: declaration.faultSchedule,
      provenance: stripUndefined({
        ...options.provenance,
        recipe: recipePortableIdentity(options.recipe, options.recipePath),
        components: options.recipe.inputs?.component_manifest,
        mounts: recipeMountIdentities(options.recipe),
        capabilities: { available: capabilities, required: declaration.requiredCapabilities ?? [], optional: declaration.optionalCapabilities ?? [] },
        resetPolicy: declaration.resetPolicy,
      }),
    })
    const campaignExecutions: RecipeExecutionResult[] = []
    const campaignOptions = { ...options, executions: campaignExecutions }
    const execute = async (plan: AdversarialCasePlan, signal: AbortSignal) => {
      const smtpSinkResets: unknown[] = []
      if (checkpointName) {
        await options.runtime.restoreCheckpoint!(checkpointName)
        // Runtime checkpoints do not include host-side sinks. Resetting declared
        // SMTP sinks keeps every checkpointed case independently replayable.
        for (const service of options.recipe.inputs?.services?.filter((candidate) => candidate.kind === "smtp") ?? []) {
          const reset = await options.managedServices?.resetSmtpSink(service.id)
          if (reset) smtpSinkResets.push(reset)
        }
      }
      try {
        return await executeRecipeAdversarialCase(declaration, templates, plan, signal, campaignOptions, smtpSinkResets)
      } finally {
        if (plan.actions.some((action) => action.clock?.length)) {
          const cleanup = wordpressServerClockCleanupAction()
          const execution = await options.runtime.execute(cleanup)
          campaignExecutions.push(execution)
        }
        // Checkpoints isolate all runtime state when they are available.
        if (checkpointName) await options.runtime.restoreCheckpoint!(checkpointName)
      }
    }
    const result = replay
      ? await runRecipeAdversarialReplay(campaign, declaration, templates, replay, execute, options.signal)
      : await runAdversarialCampaign(campaign, {
      signal: options.signal,
      retainNovelty: declaration.novelty?.retainSignals !== false,
      minimize: declaration.shrinking?.enabled !== false,
      replayCommand: (_campaign, _plan, fingerprint) => `wp-codebox adversarial replay --recipe ${portableRecipeRef(options.recipePath)} --replay files/adversarial/${declaration.id}/replay/${fingerprint}.json`,
      execute,
    })
    options.executions.push(...campaignExecutions.map((execution) => result.status === "findings" ? { ...execution, recipeAdvisory: true } : execution))
    outputs.push({
      declaration,
      result,
      capabilities: {
        available: capabilities,
        required: declaration.requiredCapabilities ?? [],
        optional: (declaration.optionalCapabilities ?? []).map((id) => ({ id, available: capabilities.includes(id) })),
        ...(clockNegotiation ? { clock: clockNegotiation } : {}),
      },
    })
  }
  return outputs
}

async function runRecipeAdversarialReplay(
  campaign: Parameters<typeof runAdversarialCampaign>[0],
  declaration: WorkspaceRecipeAdversarialCampaign,
  templates: Map<string, WorkspaceRecipeAdversarialCampaign["caseTemplates"][number]>,
  replay: AdversarialReplay,
  execute: (plan: AdversarialCasePlan, signal: AbortSignal) => Promise<AdversarialExecutionObservation>,
  signal?: AbortSignal,
): Promise<AdversarialCampaignResult> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const plan: AdversarialCasePlan = {
      id: replay.caseId,
      caseId: replay.caseId,
      corpusId: replay.corpusId,
      iteration: replay.iteration,
      workerId: replay.workerId,
      matrix: replay.matrix,
      actions: replay.actions,
      input: replay.input,
      mutation: { kind: declaration.mutators[0] ?? "sequence", path: "$", description: "recorded minimized replay" },
    }
    for (const action of plan.actions) if (!templates.has(action.type)) throw new Error(`Replay references unknown case template ${action.type}.`)
    const started = Date.now()
    const observation = await execute(plan, controller.signal)
    const signals = [...new Set(observation.signals ?? [])].sort()
    const replayMismatch = Boolean(replay.expectedStateDigest && observation.stateDigest !== replay.expectedStateDigest)
    const replayFingerprint = adversarialFindingFingerprint({
      oracleIds: observation.status === "passed" ? [] : ["runtime-status"],
      status: observation.status,
      diagnosticCodes: (observation.diagnostics ?? []).map((diagnostic) => diagnostic.code).sort(),
      stateDigest: observation.stateDigest,
      matrix: plan.matrix,
    })
    const fingerprintMismatch = Boolean(replay.expectedFingerprint && replayFingerprint !== replay.expectedFingerprint)
    const reproduced = observation.status === "passed" && !replayMismatch && !fingerprintMismatch
    return {
      schema: "wp-codebox/adversarial-campaign-result/v1",
      campaignId: campaign.id,
      seed: replay.seed,
      status: reproduced ? "passed" : "findings",
      summary: { generated: 1, executed: 1, retained: 1, findings: reproduced ? 0 : 1, duplicates: 0, timedOut: observation.status === "timed-out" ? 1 : 0 },
      corpus: [{ id: replay.caseId, actions: replay.actions, input: replay.input, signals }],
      findings: [],
      schedule: replay.schedule,
      noveltySignals: signals,
      diagnostics: replayMismatch
        ? [{ code: "adversarial-replay-state-mismatch", message: `Replay ${replay.caseId} did not reproduce the recorded state digest.` }]
        : fingerprintMismatch
          ? [{ code: "adversarial-replay-fingerprint-mismatch", message: `Replay ${replay.caseId} did not reproduce the recorded finding fingerprint.` }]
          : [{ code: "adversarial-replay-completed", message: `Replayed ${replay.caseId} through the recipe fuzz lifecycle.` }],
      resourceUsage: { wallTimeMs: Date.now() - started, artifactBytes: (observation.artifacts ?? []).reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0) },
    }
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}

async function readAdversarialReplay(path: string, invocationDirectory: string): Promise<AdversarialReplay> {
  const resolvedPath = resolveAdversarialReplayPath(path, invocationDirectory)
  const replay = JSON.parse(await readFile(resolvedPath, "utf8")) as AdversarialReplay
  if (replay.schema !== "wp-codebox/adversarial-replay/v1" || !replay.campaignId || !replay.caseId || !Array.isArray(replay.actions)) throw new Error(`Invalid adversarial replay envelope: ${path}`)
  return replay
}

export function resolveAdversarialReplayPath(path: string, invocationDirectory = process.cwd()): string {
  const workspace = resolve(invocationDirectory)
  const resolvedPath = resolve(workspace, path)
  const workspaceRelativePath = relative(workspace, resolvedPath)
  if (workspaceRelativePath === ".." || workspaceRelativePath.startsWith(`..${sep}`) || isAbsolute(workspaceRelativePath)) {
    throw new Error(`Adversarial replay path escapes the invocation workspace: ${path}`)
  }
  return resolvedPath
}

async function executeRecipeAdversarialCase(
  declaration: WorkspaceRecipeAdversarialCampaign,
  templates: Map<string, WorkspaceRecipeAdversarialCampaign["caseTemplates"][number]>,
  plan: AdversarialCasePlan,
  signal: AbortSignal,
  options: RunRecipeAdversarialCampaignsOptions,
  smtpSinkResets: unknown[] = [],
): Promise<AdversarialExecutionObservation> {
  if (signal.aborted) return { status: "error", diagnostics: [{ code: "campaign-case-interrupted", message: "Case was interrupted before execution." }] }
  const phases = materializeCasePhases(plan, templates)
  const suite = {
    schema: "wp-codebox/fuzz-suite/v1",
    id: `${declaration.id}-${plan.caseId}`,
    target: { kind: "runtime", id: "wordpress.run-workload" },
    resetPolicy: declaration.resetPolicy?.mode === "checkpoint-per-case" ? { mode: "none" as const } : declaration.resetPolicy ?? { mode: "none" as const },
    cases: [{
      id: plan.caseId,
      input: { schema: "wp-codebox/wordpress-workload-run/v1", id: plan.caseId, steps: [], metadata: { adversarial: { campaignId: declaration.id, corpusId: plan.corpusId, iteration: plan.iteration, workerId: plan.workerId, matrix: plan.matrix, mutation: plan.mutation } } },
      phases,
      metadata: { adversarialCase: true },
    }],
    metadata: { adversarialCampaignId: declaration.id, faultSchedule: declaration.faultSchedule, ...(smtpSinkResets.length > 0 ? { smtpSinkResets } : {}) },
  }
  const execution = await executeRecipeWorkflowStep(options.runtime, {
    phase: "adversarial:action",
    index: plan.iteration,
    step: { command: "wp-codebox/run-fuzz-suite", args: [`input-json=${JSON.stringify(suite)}`], metadata: { campaignId: declaration.id, caseId: plan.caseId } },
  }, options.recipeDirectory, options.sandboxWorkspace, options.artifactRoot, options.runOptions, options.inputMountPathMap)
  const parsed = parseObject(execution.stdout)
  const fuzzCase = Array.isArray(parsed?.cases) ? parseObjectValue(parsed.cases[0]) : undefined
  const diagnostics = Array.isArray(fuzzCase?.diagnostics) ? fuzzCase.diagnostics.flatMap((item) => {
    const diagnostic = parseObjectValue(item)
    return diagnostic ? [{ code: String(diagnostic.code ?? "fuzz-suite-diagnostic"), message: String(diagnostic.message ?? "Fuzz suite diagnostic"), severity: typeof diagnostic.severity === "string" ? diagnostic.severity : undefined }] : []
  }) : []
  const artifactRefs = Array.isArray(fuzzCase?.artifactRefs) ? fuzzCase.artifactRefs.flatMap((item) => {
    const ref = parseObjectValue(item)
    return ref && typeof ref.path === "string" ? [{ path: ref.path, kind: String(ref.kind ?? "fuzz-artifact"), bytes: typeof ref.bytes === "number" ? ref.bytes : undefined, sha256: typeof ref.sha256 === "string" ? ref.sha256 : undefined }] : []
  }) : []
  const status = fuzzCase?.status === "passed" && execution.exitCode === 0 ? "passed" : fuzzCase?.status === "failed" ? "failed" : "error"
  options.executions.push(execution)
  const signals = [
    `status:${status}`,
    ...(smtpSinkResets.length > 0 ? [`smtp-sink-reset:${smtpSinkResets.length}`] : []),
    ...diagnostics.map((diagnostic) => `diagnostic:${diagnostic.code}`),
    ...diagnostics.map((diagnostic) => `diagnostic-message:${createHash("sha256").update(stableAdversarialDiagnosticMessage(diagnostic.message, plan.caseId)).digest("hex").slice(0, 16)}`),
    ...(typeof fuzzCase?.skipReason === "string" ? [`skip:${fuzzCase.skipReason}`] : []),
  ]
  return stripUndefined({
    status,
    signals,
    diagnostics,
    artifacts: artifactRefs,
    stateDigest: createHash("sha256").update(JSON.stringify({ campaignId: declaration.id, status, signals, matrix: plan.matrix })).digest("hex"),
    metadata: { fuzzSuite: parsed, resetPolicy: declaration.resetPolicy ?? { mode: "none" }, faultSchedule: declaration.faultSchedule, ...(smtpSinkResets.length > 0 ? { smtpSinkResets } : {}) },
  }) as AdversarialExecutionObservation
}

function stableAdversarialDiagnosticMessage(message: string, caseId: string): string {
  const browserAssertion = message.match(/wordpress\.browser-actions [^\n]*? assertion failed at step \d+/i)?.[0]
  if (browserAssertion) return browserAssertion
  const runtimeException = message.match(/Uncaught RuntimeException:\s*([^\n<]+)/i)?.[1]?.split(" [redacted]")[0]?.trim()
  if (runtimeException) return `RuntimeException:${runtimeException}`
  return (message.split("\n", 1)[0] ?? message)
    .split(caseId).join("[case]")
    .replace(/runtime-[a-z0-9-]+/gi, "runtime-[id]")
    .replace(/command-[a-z0-9-]+/gi, "command-[id]")
    .replace(/https?:\/\/[^\s/]+/gi, "http://runtime-[origin]")
    .replace(/\b\d{4,5}\b/g, "[number]")
}

function materializeCasePhases(plan: AdversarialCasePlan, templates: Map<string, WorkspaceRecipeAdversarialCampaign["caseTemplates"][number]>): Partial<Record<WorkspaceRecipeFuzzCasePhase, WorkspaceRecipeStep[]>> {
  const phases: Partial<Record<WorkspaceRecipeFuzzCasePhase, WorkspaceRecipeStep[]>> = {}
  for (const action of plan.actions) {
    const template = templates.get(action.type)
    if (action.clock?.length && (template?.phases.action?.length ?? 0) === 0) {
      throw new Error(`Clock transition for adversarial action ${action.type} requires at least one action-phase step.`)
    }
    for (const phase of ["setup", "action", "assert", "teardown"] as const) {
      const steps = (template?.phases[phase] ?? []).map((step) => materializeStep(step, plan, action.input))
      if (phase === "action" && action.clock?.length) {
        const transition = wordpressServerClockScheduleAction(action.clock)
        phases[phase] = [...(phases[phase] ?? []), { command: transition.command, args: transition.args, metadata: transition.metadata }, ...steps]
      } else {
        phases[phase] = [...(phases[phase] ?? []), ...steps]
      }
    }
  }
  return phases
}

function materializeStep(step: WorkspaceRecipeStep, plan: AdversarialCasePlan, actionInput: unknown): WorkspaceRecipeStep {
  const replacements: Record<string, string> = {
    "{{case.id}}": plan.caseId,
    "{{case.input}}": JSON.stringify(plan.input ?? null),
    "{{action.input}}": JSON.stringify(actionInput ?? null),
    "{{action.inputBase64}}": Buffer.from(JSON.stringify(actionInput ?? null)).toString("base64"),
    "{{matrix}}": JSON.stringify(plan.matrix),
  }
  for (const [name, value] of Object.entries(plan.matrix)) replacements[`{{matrix.${name}}}`] = value
  const replace = (value: string): string => Object.entries(replacements).reduce((result, [token, replacement]) => result.split(token).join(replacement), value)
  return { ...step, args: step.args?.map(replace), metadata: { ...step.metadata, adversarialCaseId: plan.caseId, adversarialMutation: plan.mutation } }
}

export async function writeRecipeAdversarialEvidence(artifacts: ArtifactBundle, campaigns: RecipeAdversarialCampaignOutput[], sensitiveValues: string[] = []): Promise<void> {
  if (campaigns.length === 0) return
  const parentManifestPath = isAbsolute(artifacts.manifestPath) ? artifacts.manifestPath : join(artifacts.directory, artifacts.manifestPath)
  const manifest = JSON.parse(await readFile(parentManifestPath, "utf8")) as ArtifactManifest
  for (const campaign of campaigns) {
    const directory = join(artifacts.directory, "files", "adversarial", campaign.declaration.id)
    const evidence = await writeAdversarialEvidenceBundle(directory, campaign.result, { maxBytes: campaign.declaration.budgets?.maxArtifactBytes, sensitiveValues, createdAt: artifacts.createdAt })
    campaign.evidence = { ...evidence, path: relative(artifacts.directory, evidence.path) }
    const paths = [evidence.manifestPath, evidence.resultPath, ...evidence.findingPaths, ...evidence.replayPaths, evidence.secretScanPath]
    upsertArtifactManifestFiles(manifest, paths.map((path) => artifactManifestFile(relative(artifacts.directory, join(directory, path)), path === evidence.manifestPath ? "adversarial-evidence-manifest" : path === evidence.resultPath ? "adversarial-campaign-result" : path.startsWith("findings/") ? "adversarial-finding" : path.startsWith("replay/") ? "adversarial-replay" : "adversarial-secret-scan", "application/json")))
  }
  await refreshArtifactManifestFileSha256s(artifacts.directory, manifest)
  await writeFile(parentManifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function recipePortableIdentity(recipe: WorkspaceRecipe, recipePath: string): Record<string, unknown> {
  return { schema: recipe.schema, ref: portableRecipeRef(recipePath), sha256: createHash("sha256").update(JSON.stringify(recipe)).digest("hex") }
}

function recipeMountIdentities(recipe: WorkspaceRecipe): Array<Record<string, unknown>> {
  return [...(recipe.runtime?.stack?.mounts ?? []), ...(recipe.inputs?.mounts ?? [])].map((mount) => ({ target: mount.target, mode: mount.mode ?? "readonly", type: mount.type ?? "directory", captureArtifacts: mount.captureArtifacts ?? true }))
}

function portableRecipeRef(path: string): string {
  return path.split(/[\\/]/).pop() || "recipe.json"
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try { return parseObjectValue(JSON.parse(value)) } catch { return undefined }
}

function parseObjectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
