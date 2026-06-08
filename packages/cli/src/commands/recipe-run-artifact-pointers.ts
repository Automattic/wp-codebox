import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { stripUndefined, type ArtifactBundle, type RuntimeInfo } from "@automattic/wp-codebox-core"
import type { RunOutput } from "../runtime-command-wrappers.js"
import type { RecipeArtifactPointerCommandStatus, RecipeArtifactPointerState, RecipePhaseEvidence } from "./recipe-run-types.js"

export class RecipeArtifactPointerTracker {
  private command: string | undefined
  private commandStatus: RecipeArtifactPointerCommandStatus = "queued"
  private runtime: RuntimeInfo | undefined
  private artifacts: ArtifactBundle | undefined
  private failure: RunOutput["error"] | undefined
  private phases: RecipePhaseEvidence[] = []

  constructor(private readonly directory: string | undefined, private readonly runId: string, private readonly recipePath: string, private readonly startedAt: string) {}

  async update(state: RecipeArtifactPointerState = {}): Promise<void> {
    if (!this.directory) {
      return
    }

    this.command = state.command ?? this.command
    this.commandStatus = state.commandStatus ?? this.commandStatus
    this.runtime = state.runtime ?? this.runtime
    this.artifacts = state.artifacts ?? this.artifacts
    this.failure = state.failure ?? this.failure
    this.phases = state.phases ?? this.phases

    const pointer = stripUndefined({
      schema: "wp-codebox/recipe-run-artifact-pointer/v1",
      runId: this.runId,
      recipePath: this.recipePath,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      runtimeId: this.runtime?.id,
      runtime: this.runtime,
      currentCommand: this.commandStatus === "running" ? this.command : undefined,
      lastCommand: this.command,
      commandStatus: this.commandStatus,
      failure: this.failure,
      failurePhase: recipeArtifactPointerFailurePhase(this.failure, this.phases),
      paths: recipeArtifactPointerPaths(this.directory, this.runtime, this.artifacts),
    })

    await mkdir(this.directory, { recursive: true })
    const contents = `${JSON.stringify(pointer, null, 2)}\n`
    await writeFile(join(this.directory, "latest-runtime.json"), contents)
    await writeFile(join(this.directory, "manifest.json"), contents)
  }
}

function recipeArtifactPointerFailurePhase(error: RunOutput["error"] | undefined, phases: RecipePhaseEvidence[]): string | undefined {
  const failedPhase = [...phases].reverse().find((phase) => phase.status === "failed")
  if (failedPhase) {
    return failedPhase.name
  }

  if (typeof error?.activeOperation === "string") {
    return error.activeOperation
  }

  return undefined
}

function recipeArtifactPointerPaths(directory: string, runtime: RuntimeInfo | undefined, artifacts: ArtifactBundle | undefined): Record<string, string> {
  const paths: Record<string, string | undefined> = {}
  if (runtime) {
    const runtimeDirectory = join(directory, runtime.id)
    paths.runtimeDirectory = relative(directory, runtimeDirectory) || "."
    paths.eventLog = relative(directory, join(runtimeDirectory, "events.jsonl"))
    paths.commandLog = relative(directory, join(runtimeDirectory, "logs", "commands.log"))
    paths.runtimeLog = relative(directory, join(runtimeDirectory, "logs", "runtime.log"))
    paths.runtimeMetadata = relative(directory, join(runtimeDirectory, "metadata.json"))
    paths.runtimeManifest = relative(directory, join(runtimeDirectory, "manifest.json"))
    paths.browserArtifacts = relative(directory, join(runtimeDirectory, "files", "browser"))
  }

  if (artifacts) {
    paths.runtimeDirectory = relative(directory, artifacts.directory) || "."
    paths.eventLog = relative(directory, artifacts.eventsPath)
    paths.commandLog = relative(directory, artifacts.commandsLogPath)
    paths.runtimeLog = relative(directory, artifacts.runtimeLogPath)
    paths.runtimeMetadata = relative(directory, artifacts.metadataPath)
    paths.runtimeManifest = relative(directory, artifacts.manifestPath)
    paths.browserArtifacts = relative(directory, join(artifacts.directory, "files", "browser"))
  }

  return stripUndefined(paths) as Record<string, string>
}
