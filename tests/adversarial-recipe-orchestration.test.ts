import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertWorkspaceRecipeJsonSchema, type ArtifactBundle, type ExecutionSpec, type Runtime, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { recipeAdversarialCampaignFailure, resolveAdversarialReplayPath, runRecipeAdversarialCampaigns, writeRecipeAdversarialEvidence } from "../packages/cli/src/adversarial-recipe.js"
import { recipePolicy, validateWorkspaceRecipeSemantics, validateWorkspaceRecipeShape } from "../packages/cli/src/recipe-validation.js"
import type { RecipeExecutionResult } from "../packages/cli/src/commands/recipe-run-types.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: { services: [{ id: "mail", kind: "smtp", outputs: { host: "SMTP_HOST" } }] },
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  adversarialCampaigns: [{
    schema: "wp-codebox/adversarial-recipe-campaign/v1",
    id: "neutral-state",
    seed: "deterministic-seed",
    corpus: [{ id: "seed", actions: [
      { type: "option-roundtrip", input: { value: "before-expiry" }, clock: [{ surface: "scheduler", operation: "freeze", time: 1_900_000_000_000 }] },
      { type: "option-roundtrip", input: { value: "after-expiry" }, clock: [{ surface: "scheduler", operation: "advance", milliseconds: 1_000 }] },
    ], input: { state: 1 }, signals: ["seed"] }],
    caseTemplates: [{
      id: "option-roundtrip",
      phases: {
        setup: [{ command: "wordpress.run-php", args: ["code=echo 'setup';"] }],
        action: [{ command: "wordpress.run-php", args: ["code=echo '{{action.input}}';"] }],
        assert: [{ command: "wordpress.run-php", args: ["code=echo '{{case.id}}';"] }],
      },
    }],
    mutators: ["scalar"],
    oracles: [{ id: "runtime-status", severity: "high" }],
    matrix: [{ name: "runtime", values: ["neutral"] }],
    concurrency: 1,
    budgets: { maxCases: 2, maxCaseTimeMs: 5000, maxWallTimeMs: 10000, maxArtifactBytes: 100000 },
    resetPolicy: { mode: "checkpoint-per-case", checkpointName: "baseline" },
    requiredCapabilities: ["adversarial-campaign", "artifact-export", "command:wordpress.run-php"],
    optionalCapabilities: ["transport-faults"],
  }],
}

assertWorkspaceRecipeJsonSchema(recipe, { recipeCommandIds: ["inspect-mounted-inputs", "wordpress.run-php"] })
validateWorkspaceRecipeShape(recipe, "recipe.json")
assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, "recipe.json"), [])
assert(recipePolicy(recipe).commands.includes("wordpress.run-php"), "template commands must participate in policy derivation")

const executions: ExecutionSpec[] = []
const recipeExecutions: RecipeExecutionResult[] = []
const checkpointOperations: string[] = []
const smtpResets: string[] = []
const runtime = {
  info: async () => ({ id: "playground", backend: "wordpress-playground", environment: { kind: "wordpress", name: "Playground" }, createdAt: "2026-01-01T00:00:00.000Z", status: "created" }),
  execute: async (spec: ExecutionSpec) => {
    executions.push(spec)
    return { id: `execution-${executions.length}`, command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "ok\n", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z" }
  },
  createCheckpoint: async ({ name }: { name: string }) => {
    checkpointOperations.push(`create:${name}`)
    return { schema: "wp-codebox/runtime-checkpoint-result/v1", operation: "create", status: "created", name, supported: true }
  },
  restoreCheckpoint: async (name: string) => {
    checkpointOperations.push(`restore:${name}`)
    return { schema: "wp-codebox/runtime-checkpoint-result/v1", operation: "restore", status: "restored", name, supported: true }
  },
} as unknown as Runtime

const executeCampaign = async () => runRecipeAdversarialCampaigns({
  recipe,
  recipePath: "/portable/recipe.json",
  recipeDirectory: "/portable",
  runtime,
  executions: recipeExecutions,
  managedServices: { resetSmtpSink: async (serviceId) => { smtpResets.push(serviceId); return { schema: "wp-codebox/smtp-sink-reset/v1", serviceId: "service-1", reset: true } } },
  provenance: { runtime: "neutral" },
})

const first = await executeCampaign()
const second = await executeCampaign()
assert.equal(first[0]?.result.status, "passed")
assert.deepEqual(first[0]?.result.corpus, second[0]?.result.corpus)
assert.deepEqual(first[0]?.result.schedule, second[0]?.result.schedule)
assert.deepEqual(first[0]?.result.findings, second[0]?.result.findings)
assert.equal(first[0]?.capabilities.optional[0]?.available, false, "optional fidelity must be explicit")
assert(executions.length > 0, "generated cases must execute through runtime commands")
const clockedSuiteArg = recipeExecutions.flatMap((execution) => execution.args).find((arg) => arg.startsWith("input-json="))
const clockedPhase = JSON.parse((clockedSuiteArg ?? "input-json={}").slice("input-json=".length)).cases[0].phases.action as Array<{ metadata?: { clockSchedule?: Array<{ operation: string }> }; args?: string[] }>
assert.equal(clockedPhase[0]?.metadata?.clockSchedule?.[0]?.operation, "freeze", "freeze runs before the pre-expiry action")
assert.match(clockedPhase[1]?.args?.[0] ?? "", /before-expiry/)
assert.equal(clockedPhase[2]?.metadata?.clockSchedule?.[0]?.operation, "advance", "advance runs before the post-expiry action")
assert.match(clockedPhase[3]?.args?.[0] ?? "", /after-expiry/)
assert(executions.some((execution) => execution.command === "wordpress.run-php" && execution.args.some((arg) => arg.includes("server-clock-cleanup"))), "clock state is cleaned after every case")
assert(checkpointOperations.includes("create:baseline") && checkpointOperations.includes("restore:baseline"), "campaign cases must use the existing checkpoint reset path")
assert(checkpointOperations.filter((operation) => operation === "restore:baseline").length >= (first[0]?.result.summary.generated ?? 0) + (second[0]?.result.summary.generated ?? 0), "every campaign and minimization execution must restore the declared baseline before running")
assert.equal(smtpResets.length > 0, true, "checkpointed cases reset host-side SMTP sinks")
assert.equal(first[0]?.result.corpus.some((entry) => entry.signals.includes("smtp-sink-reset:1")), true, "replay corpus retains normalized SMTP reset evidence")

const unsupportedRecipe = structuredClone(recipe)
unsupportedRecipe.adversarialCampaigns![0]!.requiredCapabilities = ["missing-adapter"]
assert.throws(() => validateWorkspaceRecipeShape(unsupportedRecipe, "unsupported.json"), /requires unavailable capabilities: missing-adapter/)

const unsafeFaultRecipe = structuredClone(recipe)
unsafeFaultRecipe.adversarialCampaigns![0]!.faultSchedule = { schema: "wp-codebox/transport-fault-model/v1", seed: "faults", rules: [] }
assert.throws(() => validateWorkspaceRecipeShape(unsafeFaultRecipe, "faults.json"), /faultSchedule requires the transport-faults capability/)

const unsupportedClockRecipe = structuredClone(recipe)
unsupportedClockRecipe.adversarialCampaigns![0]!.corpus[0]!.actions[0]!.clock = [{ surface: "runtime", operation: "freeze", time: 1 }]
await assert.rejects(() => runRecipeAdversarialCampaigns({ recipe: unsupportedClockRecipe, recipePath: "/portable/unsupported-clock.json", recipeDirectory: "/portable", runtime, executions: [] }), /runtime\.freeze/)

const neutralClockRuntime = { ...runtime, info: async () => ({ id: "neutral", backend: "neutral", environment: { kind: "wordpress", name: "Neutral" }, createdAt: "2026-01-01T00:00:00.000Z", status: "created" }) } as unknown as Runtime
await assert.rejects(() => runRecipeAdversarialCampaigns({ recipe, recipePath: "/portable/neutral-clock.json", recipeDirectory: "/portable", runtime: neutralClockRuntime, executions: [] }), /runtime backend neutral/)

const noResetRecipe = structuredClone(recipe)
noResetRecipe.adversarialCampaigns![0]!.resetPolicy = { mode: "none" }
const noResetExecutions: ExecutionSpec[] = []
const failedClockRuntime = {
  ...runtime,
  execute: async (spec: ExecutionSpec) => {
    noResetExecutions.push(spec)
    return { id: `no-reset-${noResetExecutions.length}`, command: spec.command, args: spec.args ?? [], exitCode: 1, stdout: "", stderr: "failed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z" }
  },
} as unknown as Runtime
await runRecipeAdversarialCampaigns({ recipe: noResetRecipe, recipePath: "/portable/no-reset.json", recipeDirectory: "/portable", runtime: failedClockRuntime, executions: [] })
assert(noResetExecutions.some((execution) => execution.args.some((arg) => arg.includes("server-clock-cleanup"))), "failed no-reset cases clean injected clock state")

const cancellationRecipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  adversarialCampaigns: [{
    schema: "wp-codebox/adversarial-recipe-campaign/v1",
    id: "browser-cancellation",
    seed: "browser-cancellation-seed",
    corpus: [{ id: "adaptive-browser", actions: [{ type: "explore-browser" }] }],
    caseTemplates: [{ id: "explore-browser", phases: { action: [{ command: "wordpress.browser-actions", args: ["adaptive-exploration-json={\"startUrl\":\"/\"}"] }] } }],
    mutators: ["scalar"],
    oracles: [],
    budgets: { maxCases: 2, maxCaseTimeMs: 20, maxWallTimeMs: 2_000, maxArtifactBytes: 100_000 },
    resetPolicy: { mode: "checkpoint-per-case", checkpointName: "browser-baseline" },
    shrinking: { enabled: false },
  }],
}
let browserCommands = 0
let activeBrowserCommands = 0
let cancelledBrowserCommands = 0
let restoredWhileActive = false
const cancellationRuntime = {
  info: async () => ({ id: "playground", backend: "wordpress-playground", environment: { kind: "wordpress", name: "Playground" }, createdAt: "2026-01-01T00:00:00.000Z", status: "created" }),
  createCheckpoint: async ({ name }: { name: string }) => ({ schema: "wp-codebox/runtime-checkpoint-result/v1", operation: "create", status: "created", name, supported: true }),
  restoreCheckpoint: async (name: string) => {
    restoredWhileActive ||= activeBrowserCommands > 0
    return { schema: "wp-codebox/runtime-checkpoint-result/v1", operation: "restore", status: "restored", name, supported: true }
  },
  execute: async (spec: ExecutionSpec) => {
    browserCommands += 1
    if (browserCommands === 1) {
      assert(spec.signal, "the adversarial case signal reaches the runtime-backed browser command")
      activeBrowserCommands += 1
      await new Promise<void>((resolve) => spec.signal!.aborted ? resolve() : spec.signal!.addEventListener("abort", () => resolve(), { once: true }))
      activeBrowserCommands -= 1
      cancelledBrowserCommands += 1
      throw new Error("browser action cancelled")
    }
    assert.equal(activeBrowserCommands, 0, "the next case starts after the cancelled browser command settles")
    return { id: `browser-${browserCommands}`, command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "ok\n", stderr: "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z" }
  },
} as unknown as Runtime
const cancellationCampaigns = await runRecipeAdversarialCampaigns({ recipe: cancellationRecipe, recipePath: "/portable/browser-cancellation.json", recipeDirectory: "/portable", runtime: cancellationRuntime, executions: [] })
const cancellationResult = cancellationCampaigns[0]!.result
assert.equal(cancelledBrowserCommands, 1)
assert.equal(browserCommands, 2, "the campaign continues with a clean runtime after cancellation")
assert.equal(restoredWhileActive, false, "checkpoint restoration waits for browser cleanup")
assert.equal(cancellationResult.summary.timedOut, 1)
assert.equal(cancellationResult.status, "findings")
assert.equal(cancellationResult.findings[0]?.status, "timed-out")
assert(cancellationResult.findings[0]?.diagnostics.some(({ code }) => code === "case-time-budget-exhausted"))
assert(!cancellationResult.diagnostics.some(({ code }) => code === "campaign-timeout-unsettled"))

assert.equal(resolveAdversarialReplayPath("files/replay.json", "/workspace"), "/workspace/files/replay.json")
assert.throws(() => resolveAdversarialReplayPath("../replay.json", "/workspace"), /escapes the invocation workspace/)
assert.throws(() => resolveAdversarialReplayPath("/outside/replay.json", "/workspace"), /escapes the invocation workspace/)

const findingExecutions: RecipeExecutionResult[] = []
const findingRuntime = {
  ...runtime,
  execute: async (spec: ExecutionSpec) => {
    const failed = spec.args?.some((arg) => arg.includes("neutral-state-") && arg.startsWith("code=")) ?? false
    return { id: `finding-${findingExecutions.length}`, command: spec.command, args: spec.args ?? [], exitCode: failed ? 1 : 0, stdout: failed ? "" : "ok\n", stderr: failed ? "declared assertion" : "", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z" }
  },
} as unknown as Runtime
const findingCampaigns = await runRecipeAdversarialCampaigns({ recipe, recipePath: "/portable/recipe.json", recipeDirectory: "/portable", runtime: findingRuntime, executions: findingExecutions })
assert.equal(findingCampaigns[0]?.result.status, "findings")
assert.equal(findingExecutions.some((execution) => execution.exitCode !== 0 && execution.recipeAdvisory === true), true, "declared findings must remain nonzero evidence without becoming infrastructure failures")
assert.equal(recipeAdversarialCampaignFailure(findingCampaigns), undefined)
const incompleteCampaigns = structuredClone(findingCampaigns)
incompleteCampaigns[0]!.result.status = "incomplete"
assert.equal(recipeAdversarialCampaignFailure(incompleteCampaigns)?.code, "adversarial-campaign-incomplete")

const adaptiveRecipe = structuredClone(recipe)
adaptiveRecipe.adversarialCampaigns![0]!.budgets.maxCases = 1
adaptiveRecipe.adversarialCampaigns![0]!.corpus[0]!.actions = [{ type: "option-roundtrip" }]
adaptiveRecipe.adversarialCampaigns![0]!.caseTemplates[0]!.phases.action = [{ command: "wordpress.browser-actions", args: ["adaptive-exploration-json={}"] }]
const adaptiveRuntime = {
  ...runtime,
  execute: async (spec: ExecutionSpec) => ({
    id: "adaptive-incomplete",
    command: spec.command,
    args: spec.args ?? [],
    exitCode: 0,
    stdout: spec.command === "wordpress.browser-actions" ? JSON.stringify({ summary: { adaptiveExploration: { schema: "wp-codebox/browser-adaptive-exploration/v1", status: "incomplete", budgetExhausted: "maxDurationMs" } } }) : "ok\n",
    stderr: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.001Z",
  }),
} as unknown as Runtime
const adaptiveCampaigns = await runRecipeAdversarialCampaigns({ recipe: adaptiveRecipe, recipePath: "/portable/adaptive.json", recipeDirectory: "/portable", runtime: adaptiveRuntime, executions: [] })
assert.equal(adaptiveCampaigns[0]?.result.status, "incomplete")
assert.equal(adaptiveCampaigns[0]?.result.findings.length, 0, "incomplete adaptive coverage is not an actionable finding")
assert(adaptiveCampaigns[0]?.result.diagnostics.some((diagnostic) => diagnostic.code === "campaign-case-resource-exhausted" && diagnostic.message.includes("maxDurationMs")))

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-adversarial-recipe-"))
try {
  const manifestPath = join(artifactRoot, "manifest.json")
  await writeFile(manifestPath, `${JSON.stringify({ id: "parent", createdAt: "2026-01-01T00:00:00.000Z", runtime: await runtime.info(), files: [] }, null, 2)}\n`)
  const artifacts = { directory: artifactRoot, manifestPath, createdAt: "2026-01-01T00:00:00.000Z" } as unknown as ArtifactBundle
  await writeRecipeAdversarialEvidence(artifacts, first)
  const parentManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string }> }
  assert(parentManifest.files.some((file) => file.path === "files/adversarial/neutral-state/manifest.json"))
  assert(parentManifest.files.some((file) => file.path.endsWith("adversarial-campaign-result.json")))
  assert.equal(first[0]?.evidence?.path, "files/adversarial/neutral-state")
} finally {
  await rm(artifactRoot, { recursive: true, force: true })
}

const staticRecipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  fuzzRun: { schema: "wp-codebox/fuzz-run/v1", cases: [{ case_id: "static", phases: { action: [{ command: "wordpress.run-php" }] } }] },
}
assert.equal(staticRecipe.fuzzRun.cases.length, 1, "static fuzzRun declarations remain unchanged")

console.log("adversarial recipe orchestration ok")
