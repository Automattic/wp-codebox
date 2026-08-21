import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { adversarialCampaign, adversarialFindingFingerprint, classifyDifferentialResult, normalizeAdversarialClockSchedule, runAdversarialCampaign, type AdversarialCasePlan, type AdversarialExecutionObservation } from "../packages/runtime-core/src/adversarial-campaign.js"
import { writeAdversarialEvidenceBundle } from "../packages/runtime-core/src/adversarial-artifacts.js"
import { verifyArtifactBundle } from "../packages/runtime-core/src/artifact-bundle-verifier.js"

const campaign = adversarialCampaign({
  id: "neutral-component",
  seed: "repeatable-seed",
  corpus: [{
    id: "stateful-seed",
    input: { title: "safe", count: 1 },
    actions: [
      { type: "authenticate", input: { role: "reader" } },
      { type: "create", input: { value: "safe" } },
      { type: "commit" },
      { type: "observe" },
    ],
  }],
  mutationKinds: ["sequence"],
  budgets: { maxCases: 6, workers: 3, maxCaseTimeMs: 1_000, maxWallTimeMs: 10_000 },
  oracles: [{ schema: "wp-codebox/adversarial-oracle/v1", id: "neutral-integrity", severity: "high" }],
  provenance: { component: "neutral-intentionally-vulnerable-fixture", version: "1" },
})

function vulnerableExecutor(active: { count: number; maximum: number; starts: string[] }) {
  return async (plan: AdversarialCasePlan): Promise<AdversarialExecutionObservation> => {
    active.count += 1
    active.maximum = Math.max(active.maximum, active.count)
    active.starts.push(plan.caseId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active.count -= 1
    const actionTypes = plan.actions.map((action) => action.type)
    const duplicateCommit = actionTypes.filter((type) => type === "commit").length > 1
    const stateCorruption = actionTypes.indexOf("observe") < actionTypes.indexOf("commit")
    const authorization = !actionTypes.includes("authenticate")
    const diagnostics = [
      ...(duplicateCommit ? [{ code: "duplicate-effect", message: "commit executed twice" }] : []),
      ...(stateCorruption ? [{ code: "state-corruption", message: "state observed before commit" }] : []),
      ...(authorization ? [{ code: "authorization-bypass", message: "mutation executed without an actor" }] : []),
    ]
    return { status: diagnostics.length > 0 ? "failed" : "passed", diagnostics, signals: actionTypes.map((type) => `route:${type}`), artifacts: [{ path: `cases/${plan.caseId}.json`, kind: "case", bytes: 32 }] }
  }
}

test("stateful campaigns use true workers and retain deterministic replay schedules", async () => {
  const firstActive = { count: 0, maximum: 0, starts: [] as string[] }
  const secondActive = { count: 0, maximum: 0, starts: [] as string[] }
  const first = await runAdversarialCampaign(campaign, { execute: vulnerableExecutor(firstActive) })
  const second = await runAdversarialCampaign(campaign, { execute: vulnerableExecutor(secondActive) })

  assert.equal(firstActive.maximum, 3, "three cases execute concurrently in each deterministic round")
  assert.deepEqual(first.schedule, second.schedule)
  assert.deepEqual(first.corpus, second.corpus)
  assert.deepEqual(first.findings.map((finding) => finding.fingerprint), second.findings.map((finding) => finding.fingerprint))
  assert.ok(first.findings.length > 0)
  assert.ok(first.findings.every((finding) => finding.replay.command.includes("adversarial replay")))
  assert.ok(first.findings.every((finding) => finding.minimized.actions.length <= finding.original.actions.length))
  assert.ok(first.findings.every((finding) => finding.replay.schedule.length > 0))
  assert.equal(first.resourceUsage.artifactBytes <= campaign.budgets.maxArtifactBytes, true)
})

test("finding fingerprints deduplicate equivalent failures independently of payload", () => {
  const left = adversarialFindingFingerprint({ oracleIds: ["authorization"], status: "failed", diagnosticCodes: ["denied"] })
  const right = adversarialFindingFingerprint({ status: "failed", diagnosticCodes: ["denied"], oracleIds: ["authorization"] })
  assert.equal(left, right)
})

test("action-bound clock transitions preserve expiry boundaries in replay evidence", async () => {
  const clockSchedule = normalizeAdversarialClockSchedule([
    { surface: "scheduler", operation: "freeze", time: 1_900_000_000_000 },
    { surface: "scheduler", operation: "advance", milliseconds: 1_000 },
  ])
  const result = await runAdversarialCampaign(adversarialCampaign({
    id: "expiry-boundary",
    seed: "expiry-boundary-seed",
    corpus: [{ id: "expiry", actions: [
      { type: "assert-before-expiry", clock: [clockSchedule[0]!] },
      { type: "assert-after-expiry", clock: [clockSchedule[1]!] },
    ] }],
    mutationKinds: ["scalar"],
    budgets: { maxCases: 1, maxCaseTimeMs: 1_000, maxWallTimeMs: 5_000 },
  }), {
    minimize: false,
    execute: async () => ({ status: "failed", diagnostics: [{ code: "expired-at-boundary", message: "The supported scheduler seam observed expiry after 1000ms." }] }),
  })
  assert.deepEqual(result.findings[0]?.replay.actions.map((action) => action.clock), clockSchedule.map((entry) => [entry]))
  assert.throws(() => normalizeAdversarialClockSchedule([{ surface: "scheduler", operation: "advance", milliseconds: -1 }]), /non-negative/)
})

test("differential matrices classify regressions and platform differences", () => {
  assert.equal(classifyDifferentialResult([
    { id: "php-83-base", role: "base", status: "passed" },
    { id: "php-83-candidate", role: "candidate", status: "failed", fingerprint: "new" },
  ]).classification, "candidate-regression")
  assert.equal(classifyDifferentialResult([
    { id: "sqlite", status: "passed", fingerprint: "a" },
    { id: "mysql", status: "passed", fingerprint: "b" },
  ]).classification, "platform-difference")
})

test("sealed finding bundles redact secrets and machine-specific paths", async () => {
  const active = { count: 0, maximum: 0, starts: [] as string[] }
  const result = await runAdversarialCampaign(campaign, { execute: vulnerableExecutor(active) })
  result.findings[0]!.replay.provenance = { password: "fixture-secret", cwd: "/var/lib/private/worktree" }
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-adversarial-evidence-"))
  try {
    const bundle = await writeAdversarialEvidenceBundle(directory, result, { sensitiveValues: ["fixture-secret"], createdAt: "2026-07-24T00:00:00.000Z" })
    const manifest = JSON.parse(await readFile(join(directory, bundle.manifestPath), "utf8"))
    const replay = await readFile(join(directory, bundle.replayPaths[0] as string), "utf8")
    assert.equal(manifest.contentDigest.value, bundle.contentDigest)
    assert.ok(manifest.files.some((file: { path: string }) => file.path === bundle.secretScanPath))
    assert.doesNotMatch(replay, /fixture-secret|\/var\/lib\/private/)
    assert.match(replay, /\[redacted\]/)
    assert.equal((await verifyArtifactBundle(directory)).valid, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("campaign interruption stops scheduling and returns bounded partial evidence", async () => {
  const controller = new AbortController()
  let active = 0
  const result = await runAdversarialCampaign(adversarialCampaign({
    id: "interrupted",
    seed: "interrupted-seed",
    corpus: [{ id: "seed", actions: [{ type: "observe", input: {} }] }],
    mutationKinds: ["scalar"],
    budgets: { maxCases: 100, workers: 2, maxCaseTimeMs: 1000, maxWallTimeMs: 10000, maxArtifactBytes: 1024 },
  }), {
    signal: controller.signal,
    execute: async (_plan, signal) => {
      active += 1
      controller.abort("test interruption")
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { status: signal.aborted ? "error" : "passed", artifacts: [{ path: "partial.json", kind: "partial", bytes: 16 }] }
    },
  })
  assert.equal(result.status, "incomplete")
  assert.equal(active, 0, "all active workers settle before interruption returns")
  assert(result.summary.generated <= 2, "no later round is scheduled after interruption")
  assert(result.resourceUsage.artifactBytes <= 1024)
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "campaign-interrupted"))
})

test("a timed-out case settles before the next case starts", async () => {
  const starts: string[] = []
  const settled: string[] = []
  const result = await runAdversarialCampaign(adversarialCampaign({
    id: "timeout-isolation",
    seed: "timeout-isolation-seed",
    corpus: [{ id: "seed", actions: [{ type: "observe", input: {} }] }],
    mutationKinds: ["scalar"],
    budgets: { maxCases: 2, workers: 1, maxCaseTimeMs: 5, maxWallTimeMs: 1_000 },
  }), {
    execute: async (plan, signal) => {
      starts.push(plan.caseId)
      await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      settled.push(plan.caseId)
      return { status: "passed" }
    },
  })
  assert.equal(result.summary.timedOut, 2)
  assert.deepEqual(starts, settled, "the next case cannot begin while the timed-out case remains active")
})

test("an uncooperative timed-out case terminalizes the campaign without starting another case", async () => {
  let started = 0
  const result = await runAdversarialCampaign(adversarialCampaign({
    id: "timeout-unsettled",
    seed: "timeout-unsettled-seed",
    corpus: [{ id: "seed", actions: [{ type: "observe", input: {} }] }],
    mutationKinds: ["scalar"],
    budgets: { maxCases: 2, workers: 1, maxCaseTimeMs: 5, maxWallTimeMs: 1_000 },
  }), {
    abortSettleGraceMs: 10,
    execute: async () => {
      started += 1
      await new Promise(() => {})
      return { status: "passed" }
    },
  })
  assert.equal(started, 1)
  assert.equal(result.status, "incomplete")
  assert(result.diagnostics.some(({ code }) => code === "campaign-timeout-unsettled"))
})

test("resource-exhausted cases make coverage incomplete without creating findings", async () => {
  const result = await runAdversarialCampaign(adversarialCampaign({
    id: "partial-coverage",
    seed: "partial-coverage-seed",
    corpus: [{ id: "seed", actions: [{ type: "explore" }] }],
    mutationKinds: ["sequence"],
    budgets: { maxCases: 2, workers: 1, maxCaseTimeMs: 1_000, maxWallTimeMs: 5_000 },
    oracles: [{ schema: "wp-codebox/adversarial-oracle/v1", id: "runtime-status", severity: "high" }],
  }), {
    execute: async () => ({ status: "resource-exhausted", diagnostics: [{ code: "adaptive-exploration-incomplete", message: "Adaptive browser exploration stopped at the maxDurationMs bound and retained partial evidence." }], artifacts: [{ path: "adaptive-exploration.json", kind: "browser-adaptive-exploration" }] }),
  })
  assert.equal(result.status, "incomplete")
  assert.equal(result.summary.executed, 1)
  assert.equal(result.findings.length, 0)
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "campaign-case-resource-exhausted" && diagnostic.message.includes("maxDurationMs")))
})

test("minimization preserves the exact oracle and state fingerprint", async () => {
  const exactState = adversarialCampaign({
    id: "exact-state",
    seed: "exact-state-seed",
    corpus: [{ id: "journey", actions: [{ type: "open" }, { type: "trigger" }], input: { value: "fixture" } }],
    mutationKinds: ["scalar"],
    budgets: { maxCases: 1, maxActionsPerCase: 4, maxCaseTimeMs: 1_000, maxWallTimeMs: 5_000 },
    oracles: [{ schema: "wp-codebox/adversarial-oracle/v1", id: "fixture-defect", severity: "high" }],
  })
  const result = await runAdversarialCampaign(exactState, {
    execute: async (plan) => ({
      status: "failed",
      stateDigest: plan.actions.some((action) => action.type === "open") ? "modal-open" : "modal-closed",
      diagnostics: [{ code: "fixture-defect", message: "same visible error in a different state" }],
    }),
    evaluate: async () => [{ oracleId: "fixture-defect", failed: true }],
  })
  const finding = result.findings[0]!
  assert.equal(finding.replay.expectedStateDigest, "modal-open")
  assert.equal(finding.replay.expectedFingerprint, finding.fingerprint)
  assert(finding.minimized.actions.some((action) => action.type === "open"), "a candidate in the wrong state must not be accepted")
})

test("minimization shrinks structured action inputs such as browser journeys", async () => {
  const result = await runAdversarialCampaign(adversarialCampaign({
    id: "structured-action-input",
    seed: "structured-action-input-seed",
    corpus: [{ id: "browser", actions: [{ type: "browser", input: ["navigate", "click", "trigger", "capture", "capture", "capture"] }] }],
    mutationKinds: ["sequence"],
    budgets: { maxCases: 1, maxActionsPerCase: 2, maxCaseTimeMs: 1_000, maxWallTimeMs: 5_000 },
    oracles: [{ schema: "wp-codebox/adversarial-oracle/v1", id: "browser-defect", severity: "high" }],
  }), {
    execute: async (plan) => {
      const journey = plan.actions[0]?.input
      const failed = Array.isArray(journey) && journey.includes("trigger")
      return { status: failed ? "failed" : "passed", stateDigest: failed ? "browser-defect" : "clean", diagnostics: failed ? [{ code: "browser-defect", message: "trigger reproduced" }] : [] }
    },
    evaluate: async (_plan, observation) => [{ oracleId: "browser-defect", failed: observation.status === "failed" }],
  })
  const minimizedJourney = result.findings[0]?.minimized.actions[0]?.input
  assert.deepEqual(minimizedJourney, ["navigate", "click", "trigger"])
})
