import { routeCliCommand } from "./command-router.js"
import { runArtifactsApplyPreflightCommand, runArtifactsBenchmarkCommand, runArtifactsBrowserMetricsCommand, runArtifactsDiagnosticsCommand, runArtifactsDiscoverPartialCommand, runArtifactsExportLinksCommand, runArtifactsTransferProbesCommand, runArtifactsTransferVerifyCommand, runArtifactsVerifyCommand } from "./commands/artifacts.js"
import { runAgentTaskRunCommand } from "./commands/agent-task-run.js"
import { runArtifactsBenchCompareCommand, runArtifactsBenchResultsCommand, runBenchCompareCommand, runBenchMatrixCommand, runBenchSummarizeCommand } from "./commands/benchmark.js"
import { runCommandsCommand, runRecipeSchemaCommand } from "./commands/discovery.js"
import { runCleanupCommand, runDoctorCommand } from "./commands/doctor.js"
import { runRecipeBuildCommand } from "./commands/recipe-build.js"
import { runRecipeRunCommand, runRecipeValidateCommand } from "./commands/recipe-run.js"
import { runMaterializeReplayPackageCommand } from "./commands/replay-package.js"
import { runBootCommand, runRunCommand, runValidateBlueprintCommand } from "./commands/runtime.js"
import { runRunsArtifactsCommand, runRunsStatusCommand } from "./commands/runs.js"
import { runTargetProvisionCommand } from "./commands/target.js"
import { runWorkspacePolicyCheckCommand } from "./commands/workspace-policy.js"
import { printHelp } from "./output.js"

export async function runCli(args: string[]): Promise<number> {
  return routeCliCommand(args, {
    printHelp,
    boot: runBootCommand,
    validateBlueprint: runValidateBlueprintCommand,
    materializeReplayPackage: runMaterializeReplayPackageCommand,
    recipeRun: runRecipeRunCommand,
    agentTaskRun: runAgentTaskRunCommand,
    recipeValidate: runRecipeValidateCommand,
    recipeBuild: runRecipeBuildCommand,
    workspacePolicyCheck: runWorkspacePolicyCheckCommand,
    artifactsVerify: runArtifactsVerifyCommand,
    artifactsApplyPreflight: runArtifactsApplyPreflightCommand,
    artifactsBrowserMetrics: runArtifactsBrowserMetricsCommand,
    artifactsDiagnostics: runArtifactsDiagnosticsCommand,
    artifactsTransferVerify: runArtifactsTransferVerifyCommand,
    artifactsTransferProbes: runArtifactsTransferProbesCommand,
    artifactsExportLinks: runArtifactsExportLinksCommand,
    artifactsBenchmark: runArtifactsBenchmarkCommand,
    artifactsDiscoverPartial: runArtifactsDiscoverPartialCommand,
    artifactsBenchResults: runArtifactsBenchResultsCommand,
    benchMatrix: runBenchMatrixCommand,
    artifactsBenchCompare: runArtifactsBenchCompareCommand,
    benchSummarize: runBenchSummarizeCommand,
    benchCompare: runBenchCompareCommand,
    runsStatus: runRunsStatusCommand,
    runsArtifacts: runRunsArtifactsCommand,
    targetProvision: runTargetProvisionCommand,
    commands: runCommandsCommand,
    recipeSchema: runRecipeSchemaCommand,
    doctor: runDoctorCommand,
    cleanup: runCleanupCommand,
    run: runRunCommand,
  })
}
