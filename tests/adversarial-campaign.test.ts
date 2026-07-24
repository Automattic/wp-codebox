import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { adversarialCampaign, adversarialFindingFingerprint, classifyDifferentialResult, runAdversarialCampaign, type AdversarialCasePlan, type AdversarialExecutionObservation } from "../packages/runtime-core/src/adversarial-campaign.js"
import { writeAdversarialEvidenceBundle } from "../packages/runtime-core/src/adversarial-artifacts.js"

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
    corpus: [{ id: "seed", actions: [{ type: "observe" }] }],
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
