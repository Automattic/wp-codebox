import { routeCliCommand } from "./command-router.js"
import { runArtifactsBrowserMetricsCommand, runArtifactsVerifyCommand } from "./commands/artifacts.js"
import { runArtifactsBenchResultsCommand, runBenchSummarizeCommand } from "./commands/benchmark.js"
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
    recipeValidate: runRecipeValidateCommand,
    recipeBuild: runRecipeBuildCommand,
    workspacePolicyCheck: runWorkspacePolicyCheckCommand,
    artifactsVerify: runArtifactsVerifyCommand,
    artifactsBrowserMetrics: runArtifactsBrowserMetricsCommand,
    artifactsBenchResults: runArtifactsBenchResultsCommand,
    benchSummarize: runBenchSummarizeCommand,
    runsStatus: runRunsStatusCommand,
    runsArtifacts: runRunsArtifactsCommand,
    commands: runCommandsCommand,
    recipeSchema: runRecipeSchemaCommand,
    doctor: runDoctorCommand,
    cleanup: runCleanupCommand,
    run: runRunCommand,
  })
}
