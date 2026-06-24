import assert from "node:assert/strict"
import { routeCliCommand } from "../packages/cli/src/command-router.js"

process.env.WP_CODEBOX_NO_JSPI_RESPAWN = "1"

const calls: string[] = []
const router = {
  printHelp: () => calls.push("printHelp"),
  boot: async () => 0,
  validateBlueprint: async () => 0,
  materializeReplayPackage: async () => 0,
  recipeRun: async () => 0,
  agentTaskRun: async (args: string[]) => {
    calls.push(`agentTaskRun:${args.join(" ")}`)
    return 7
  },
  runFuzzSuite: async () => 0,
  runWordPressWorkload: async () => 0,
  recipeValidate: async () => 0,
  recipeBuild: async () => 0,
  workspacePolicyCheck: async () => 0,
  artifactsVerify: async () => 0,
  artifactsApplyPreflight: async () => 0,
  artifactsBrowserMetrics: async () => 0,
  artifactsDiagnostics: async () => 0,
  artifactsTransferVerify: async () => 0,
  artifactsTransferProbes: async () => 0,
  artifactsExportLinks: async () => 0,
  artifactsBenchmark: async () => 0,
  artifactsDiscoverPartial: async () => 0,
  artifactsBenchResults: async () => 0,
  artifactsBenchCompare: async () => 0,
  benchMatrix: async () => 0,
  benchSummarize: async () => 0,
  benchCompare: async () => 0,
  runsStatus: async () => 0,
  runsArtifacts: async () => 0,
  runsCancel: async () => 0,
  targetProvision: async () => 0,
  mcpRenderClientConfigs: async () => 0,
  commands: async () => 0,
  recipeSchema: async () => 0,
  doctor: async () => 0,
  cleanup: async () => 0,
  run: async () => 0,
}

const exitCode = await routeCliCommand(["run-agent-task", "--input-file", "task.json", "--json"], router)

assert.equal(exitCode, 7)
assert.deepEqual(calls, ["agentTaskRun:--input-file task.json --json"])

console.log("command-router contract passed")
