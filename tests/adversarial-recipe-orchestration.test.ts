import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertWorkspaceRecipeJsonSchema, type ArtifactBundle, type ExecutionSpec, type Runtime, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { runRecipeAdversarialCampaigns, writeRecipeAdversarialEvidence } from "../packages/cli/src/adversarial-recipe.js"
import { recipePolicy, validateWorkspaceRecipeSemantics, validateWorkspaceRecipeShape } from "../packages/cli/src/recipe-validation.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  adversarialCampaigns: [{
    schema: "wp-codebox/adversarial-recipe-campaign/v1",
    id: "neutral-state",
    seed: "deterministic-seed",
    corpus: [{ id: "seed", actions: [{ type: "option-roundtrip", input: { value: "alpha" } }], input: { state: 1 }, signals: ["seed"] }],
    caseTemplates: [{
      id: "option-roundtrip",
      phases: {
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
const checkpointOperations: string[] = []
const runtime = {
  info: async () => ({ id: "neutral", backend: "neutral", environment: { kind: "wordpress", name: "Neutral" }, createdAt: "2026-01-01T00:00:00.000Z", status: "created" }),
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
  executions: [],
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
assert(checkpointOperations.includes("create:baseline") && checkpointOperations.includes("restore:baseline"), "campaign cases must use the existing checkpoint reset path")

const unsupportedRecipe = structuredClone(recipe)
unsupportedRecipe.adversarialCampaigns![0]!.requiredCapabilities = ["missing-adapter"]
assert.throws(() => validateWorkspaceRecipeShape(unsupportedRecipe, "unsupported.json"), /requires unavailable capabilities: missing-adapter/)

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
