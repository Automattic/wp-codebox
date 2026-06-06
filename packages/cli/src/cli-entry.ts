import { routeCliCommand } from "./command-router.js"
import { runArtifactsApplyPreflightCommand, runArtifactsBenchmarkCommand, runArtifactsBrowserMetricsCommand, runArtifactsDiscoverPartialCommand, runArtifactsTransferProbesCommand, runArtifactsTransferVerifyCommand, runArtifactsVerifyCommand } from "./commands/artifacts.js"
import { runAgentTaskRunCommand } from "./commands/agent-task-run.js"
import { runArtifactsBenchCompareCommand, runArtifactsBenchResultsCommand, runBenchCompareCommand, runBenchMatrixCommand, runBenchSummarizeCommand } from "./commands/benchmark.js"
import { runCommandsCommand, runRecipeSchemaCommand } from "./commands/discovery.js"
import { runCleanupCommand, runDoctorCommand } from "./commands/doctor.js"
import { runRecipeBuildCommand } from "./commands/recipe-build.js"
import { runRecipeRunCommand, runRecipeValidateCommand } from "./commands/recipe-run.js"
import { runBootCommand, runRunCommand, runValidateBlueprintCommand } from "./commands/runtime.js"
import { runRunsArtifactsCommand, runRunsStatusCommand } from "./commands/runs.js"
import { runWorkspacePolicyCheckCommand } from "./commands/workspace-policy.js"
import { printHelp } from "./output.js"

export async function runCli(args: string[]): Promise<number> {
  return routeCliCommand(args, {
    printHelp,
    boot: runBootCommand,
    validateBlueprint: runValidateBlueprintCommand,
    recipeRun: runRecipeRunCommand,
    agentTaskRun: runAgentTaskRunCommand,
    recipeValidate: runRecipeValidateCommand,
    recipeBuild: runRecipeBuildCommand,
    workspacePolicyCheck: runWorkspacePolicyCheckCommand,
    artifactsVerify: runArtifactsVerifyCommand,
    artifactsApplyPreflight: runArtifactsApplyPreflightCommand,
    artifactsBrowserMetrics: runArtifactsBrowserMetricsCommand,
    artifactsTransferVerify: runArtifactsTransferVerifyCommand,
    artifactsTransferProbes: runArtifactsTransferProbesCommand,
    artifactsBenchmark: runArtifactsBenchmarkCommand,
    artifactsDiscoverPartial: runArtifactsDiscoverPartialCommand,
    artifactsBenchResults: runArtifactsBenchResultsCommand,
    benchMatrix: runBenchMatrixCommand,
    artifactsBenchCompare: runArtifactsBenchCompareCommand,
    benchSummarize: runBenchSummarizeCommand,
    benchCompare: runBenchCompareCommand,
    runsStatus: runRunsStatusCommand,
    runsArtifacts: runRunsArtifactsCommand,
    commands: runCommandsCommand,
    recipeSchema: runRecipeSchemaCommand,
    doctor: runDoctorCommand,
    cleanup: runCleanupCommand,
    run: runRunCommand,
  })
}
