import { readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import type { ArtifactBundle, RuntimeRunRecord, RuntimeRunRegistry } from "@automattic/wp-codebox-core"
import { serializeError } from "../output.js"
import { serializeRecipeRunError } from "./recipe-run-output.js"
import type { RecipePhaseEvidence } from "./recipe-run-types.js"
import type { RunOutput } from "../runtime-command-wrappers.js"

export interface RunResourceCleanupEvidence {
  durationMs: number
  state: "completed" | "failed"
  status: RuntimeRunRecord["lifecycle"]["cleanup"]["status"]
  attempts: number
  error?: RunOutput["error"]
}

interface RunResourceEvidenceOptions {
  startedAtMs: number
  status: RuntimeRunRecord["status"]
  startupDurationMs?: number
  cleanup?: RunResourceCleanupEvidence
  artifacts?: ArtifactBundle
  failure?: RunOutput["error"]
  phaseEvidence?: RecipePhaseEvidence[]
}

export async function runRecipeCleanup(runRegistry: RuntimeRunRegistry, runRecord: RuntimeRunRecord, cleanup: () => Promise<void>): Promise<RunResourceCleanupEvidence> {
  const startedAtMs = Date.now()
  await runRegistry.update(runRecord.runId, { cleanup: { status: "running" } })
  try {
    await cleanup()
    const updatedRunRecord = await runRegistry.update(runRecord.runId, { cleanup: { status: "succeeded" } })
    return cleanupEvidenceFromRunRecord(updatedRunRecord, Date.now() - startedAtMs)
  } catch (error) {
    const updatedRunRecord = await runRegistry.update(runRecord.runId, { cleanup: { status: "failed", error: serializeError(error) } })
    const cleanupError = serializeRecipeRunError(error)
    cleanupEvidenceFromRunRecord(updatedRunRecord, Date.now() - startedAtMs, cleanupError)
    throw error
  }
}

function cleanupEvidenceFromRunRecord(runRecord: RuntimeRunRecord, durationMs: number, error?: RunOutput["error"]): RunResourceCleanupEvidence {
  const cleanup = runRecord.lifecycle.cleanup
  return stripUndefined({
    durationMs,
    state: cleanup.status === "failed" ? "failed" as const : "completed" as const,
    status: cleanup.status,
    attempts: cleanup.attempts,
    error: error ?? cleanup.error,
  }) as RunResourceCleanupEvidence
}

export async function runResourceEvidence(options: RunResourceEvidenceOptions): Promise<Record<string, unknown>> {
  return stripUndefined({
    schema: "wp-codebox/run-resource-evidence/v1",
    status: options.status,
    timing: {
      startup: metricOrUnavailable(options.startupDurationMs, "runtime creation was not reached"),
      duration: { available: true, unit: "ms", value: Date.now() - options.startedAtMs },
      cleanup: options.cleanup ?? unavailableMetric("runtime cleanup was not reached"),
    },
    resources: {
      hostProcess: hostProcessResourceEvidence(),
      runtimeMemory: unavailableMetric("WordPress Playground runtime memory is not exposed by the runtime backend"),
      runtimeProcessCount: unavailableMetric("WordPress Playground runtime process count is not exposed by the runtime backend"),
    },
    artifacts: await artifactSizeEvidence(options.artifacts),
    phases: options.phaseEvidence ?? [],
    reliability: {
      failureClassification: classifyRunResourceFailure(options.status, options.failure),
      retryCount: unavailableMetric("recipe-run does not retry worker executions"),
    },
  })
}

function metricOrUnavailable(value: number | undefined, reason: string): Record<string, unknown> {
  return typeof value === "number" ? { available: true, unit: "ms", value } : unavailableMetric(reason)
}

function unavailableMetric(reason: string): Record<string, unknown> {
  return { available: false, reason }
}

function hostProcessResourceEvidence(): Record<string, unknown> {
  const memory = process.memoryUsage()
  const usage = process.resourceUsage()
  return {
    available: true,
    pid: process.pid,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    maxRssBytes: usage.maxRSS > 0 ? usage.maxRSS * 1024 : undefined,
    source: "node-process",
  }
}

async function artifactSizeEvidence(artifacts: ArtifactBundle | undefined): Promise<Record<string, unknown>> {
  if (!artifacts) {
    return unavailableMetric("artifact bundle was not created")
  }

  try {
    return {
      available: true,
      directory: artifacts.directory,
      bytes: await directorySizeBytes(artifacts.directory),
      bundleId: artifacts.id,
    }
  } catch (error) {
    return unavailableMetric(`artifact size could not be measured: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function directorySizeBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      total += await directorySizeBytes(path)
    } else if (entry.isFile()) {
      total += (await stat(path)).size
    }
  }
  return total
}

function classifyRunResourceFailure(status: RuntimeRunRecord["status"], failure: RunOutput["error"] | undefined): Record<string, unknown> {
  if (!failure) {
    return { available: true, value: status === "succeeded" ? "none" : "unknown" }
  }

  const code = failure.code ?? failure.name
  const phase = typeof failure.phase === "string" ? failure.phase : undefined
  const value = code === "recipe-phase-failed" && phase
    ? classifyRecipePhaseFailure(phase)
    : code === "recipe-run-timeout"
    ? "timeout"
    : code === "recipe-interrupted"
      ? "cancelled"
      : code === "recipe-cleanup-failed"
        ? "cleanup"
      : code === "recipe-runtime-create-failed" || code === "wp-codebox-playground-cli-exited"
        ? "startup"
        : status === "cancelled"
          ? "cancelled"
          : "execution"

  return { available: true, value, code, ...(phase ? { phase } : {}), message: failure.message }
}

function classifyRecipePhaseFailure(phase: string): string {
  switch (phase) {
    case "runtime_startup":
    case "run_blueprint_steps":
      return "startup"
    case "mount_plugins":
      return "plugin_mount"
    case "activate_plugins":
      return "plugin_activation"
    case "import_fixture_databases":
      return "fixture_database"
    case "run_workloads":
      return "workload"
    case "run_probes":
      return "probe"
    case "collect_artifacts":
      return "artifact_collection"
    default:
      return "execution"
  }
}
