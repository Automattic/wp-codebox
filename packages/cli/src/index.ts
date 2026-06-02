#!/usr/bin/env node
import { routeCliCommand } from "./command-router.js"
import { runArtifactsBrowserMetricsCommand, runArtifactsVerifyCommand } from "./commands/artifacts.js"
import { runCommandsCommand, runRecipeSchemaCommand } from "./commands/discovery.js"
import { runCleanupCommand, runDoctorCommand } from "./commands/doctor.js"
import { runRecipeRunCommand, runRecipeValidateCommand } from "./commands/recipe-run.js"
import { runBootCommand, runRunCommand, runValidateBlueprintCommand } from "./commands/runtime.js"
import { runRunsArtifactsCommand, runRunsStatusCommand } from "./commands/runs.js"
import { runWorkspacePolicyCheckCommand } from "./commands/workspace-policy.js"
import { printHelp, serializeError } from "./output.js"

async function runCli(args: string[]): Promise<number> {
  return routeCliCommand(args, {
    printHelp,
    boot: runBootCommand,
    validateBlueprint: runValidateBlueprintCommand,
    recipeRun: runRecipeRunCommand,
    recipeValidate: runRecipeValidateCommand,
    workspacePolicyCheck: runWorkspacePolicyCheckCommand,
    artifactsVerify: runArtifactsVerifyCommand,
    artifactsBrowserMetrics: runArtifactsBrowserMetricsCommand,
    runsStatus: runRunsStatusCommand,
    runsArtifacts: runRunsArtifactsCommand,
    commands: runCommandsCommand,
    recipeSchema: runRecipeSchemaCommand,
    doctor: runDoctorCommand,
    cleanup: runCleanupCommand,
    run: runRunCommand,
  })
}

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(serializeError(error)?.message ?? String(error))
    process.exitCode = 1
  },
)
