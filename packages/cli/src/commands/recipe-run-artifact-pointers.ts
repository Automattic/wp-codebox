import { mkdir, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { ArtifactBundle, RuntimeInfo } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import type { RunOutput } from "../runtime-command-wrappers.js"
import type { RecipeArtifactPointerCommandStatus, RecipeArtifactPointerState, RecipeBrowserEvidence, RecipePhaseEvidence } from "./recipe-run-types.js"

export class RecipeArtifactPointerTracker {
  private command: string | undefined
  private commandStatus: RecipeArtifactPointerCommandStatus = "queued"
  private runtime: RuntimeInfo | undefined
  private artifacts: ArtifactBundle | undefined
  private failure: RunOutput["error"] | undefined
  private phases: RecipePhaseEvidence[] = []
  private browserEvidence: RecipeBrowserEvidence[] = []

  constructor(private readonly directory: string | undefined, private readonly runId: string, private readonly recipePath: string, private readonly startedAt: string) {}

  async update(state: RecipeArtifactPointerState = {}): Promise<void> {
    if (!this.directory) {
      return
    }

    this.command = state.command ?? this.command
    this.commandStatus = state.commandStatus ?? this.commandStatus
    this.runtime = state.runtime ?? this.runtime
    this.artifacts = state.artifacts ?? this.artifacts
    this.failure = state.failure ?? (state.commandStatus === "completed" || state.commandStatus === "running" ? undefined : this.failure)
    this.phases = state.phases ?? this.phases
    this.browserEvidence = state.browserEvidence ?? this.browserEvidence

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
      browserEvidence: this.browserEvidence.length > 0 ? this.browserEvidence : undefined,
      ...await recipeArtifactPointerArtifactState(this.directory, this.runtime, this.artifacts),
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

async function recipeArtifactPointerArtifactState(directory: string, runtime: RuntimeInfo | undefined, artifacts: ArtifactBundle | undefined): Promise<Record<string, unknown>> {
  const paths: Record<string, string | undefined> = {}
  const artifactMissing: Record<string, { path: string; reason: "runtime-artifact-not-created" }> = {}
  if (runtime) {
    const runtimeDirectory = join(directory, runtime.id)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeDirectory", runtimeDirectory)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "eventLog", join(runtimeDirectory, "events.jsonl"))
    await appendExistingArtifactPath(directory, paths, artifactMissing, "commandLog", join(runtimeDirectory, "logs", "commands.log"))
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeLog", join(runtimeDirectory, "logs", "runtime.log"))
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeMetadata", join(runtimeDirectory, "metadata.json"))
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeManifest", join(runtimeDirectory, "manifest.json"))
    await appendExistingArtifactPath(directory, paths, artifactMissing, "browserArtifacts", join(runtimeDirectory, "files", "browser"))
  }

  if (artifacts) {
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeDirectory", artifacts.directory)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "eventLog", artifacts.eventsPath)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "commandLog", artifacts.commandsLogPath)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeLog", artifacts.runtimeLogPath)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeMetadata", artifacts.metadataPath)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "runtimeManifest", artifacts.manifestPath)
    await appendExistingArtifactPath(directory, paths, artifactMissing, "browserArtifacts", join(artifacts.directory, "files", "browser"))
  }

  return stripUndefined({
    paths: stripUndefined(paths),
    artifactMissing: Object.keys(artifactMissing).length > 0 ? artifactMissing : undefined,
  })
}

async function appendExistingArtifactPath(directory: string, paths: Record<string, string | undefined>, artifactMissing: Record<string, { path: string; reason: "runtime-artifact-not-created" }>, key: string, absolutePath: string): Promise<void> {
  const path = relative(directory, absolutePath) || "."
  try {
    await stat(absolutePath)
    paths[key] = path
    delete artifactMissing[key]
  } catch {
    delete paths[key]
    artifactMissing[key] = { path, reason: "runtime-artifact-not-created" }
  }
}
