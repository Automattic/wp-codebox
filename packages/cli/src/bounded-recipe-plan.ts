import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { commandArgValue, executeBoundedRuntimePlan, parseCommandJsonObject, type BoundedRuntimePlan, type BoundedRuntimePlanResult, type ExecutionResult, type Runtime } from "@automattic/wp-codebox-core"
import { recipeExecutionSpec } from "./agent-sandbox.js"

export interface BoundedRecipePlanExecutionOptions {
  artifactRoot: string
  recipeDirectory: string
}

export async function executeBoundedRecipePlan(runtime: Runtime, plan: BoundedRuntimePlan, options: BoundedRecipePlanExecutionOptions): Promise<BoundedRuntimePlanResult> {
  const aggregate = await executeBoundedRuntimePlan(plan, {
    async materialize() { return { workspace: options.recipeDirectory, runtime } },
    async startServices() { return undefined },
    async execute({ entry, signal }) {
      const command = entry.argv[0]?.trim()
      if (!command) throw new Error(`Bounded recipe plan entry requires argv[0] command: ${entry.id}`)
      const args = entry.argv.slice(1)
      const directory = join(options.artifactRoot, entry.artifactNamespace)
      const stdoutRef = `${entry.artifactNamespace}/stdout.txt`
      const stderrRef = `${entry.artifactNamespace}/stderr.txt`
      const resultRef = `${entry.artifactNamespace}/result.json`
      await mkdir(directory, { recursive: true })
      let execution: ExecutionResult | undefined
      let message = ""
      try {
        const spec = await recipeExecutionSpec({ command, args }, options.recipeDirectory)
        execution = await runtime.execute({ ...spec, environment: entry.environment, processIdentity: entry.processIdentity, artifactNamespace: entry.artifactNamespace, timeoutMs: entry.timeoutMs, signal })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      const stdout = redactOutput(execution?.stdout ?? "", entry.environment)
      const stderr = redactOutput(execution?.stderr || message, entry.environment)
      const exitCode = execution?.exitCode ?? 1
      const artifactRefs = runtimeArtifactRefs(execution)
      await writeFile(join(options.artifactRoot, stdoutRef), stdout, "utf8")
      await writeFile(join(options.artifactRoot, stderrRef), stderr, "utf8")
      await writeFile(join(options.artifactRoot, resultRef), `${JSON.stringify({
        schema: "wp-codebox/bounded-runtime-plan-entry-result/v1",
        id: entry.id,
        inputIndex: entry.inputIndex,
        processIdentity: entry.processIdentity,
        artifactNamespace: entry.artifactNamespace,
        command,
        exitCode,
        success: exitCode === 0,
        stdoutRef,
        stderrRef,
        artifactRefs,
      }, null, 2)}\n`, "utf8")
      return { success: exitCode === 0, exitCode, message: stderr, stdoutRef, stderrRef, resultRef, artifactRefs }
    },
    async stopServices() {},
    async dispose() {},
  })
  await mkdir(join(options.artifactRoot, "bounded-plan"), { recursive: true })
  await writeFile(join(options.artifactRoot, "bounded-plan/result.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8")
  return aggregate
}

export async function executeBoundedRecipePlanFromArgs(runtime: Runtime, args: string[], options: BoundedRecipePlanExecutionOptions): Promise<BoundedRuntimePlanResult> {
  const raw = commandArgValue(args, "plan-json") || commandArgValue(args, "request-json")
  const file = commandArgValue(args, "plan-file") || commandArgValue(args, "request-file")
  if (!raw && !file) throw new Error("wp-codebox.bounded-runtime-plan requires plan-json=<json> or plan-file=<recipe-relative-path>")
  const text = raw ?? await readFile(join(options.recipeDirectory, file!), "utf8")
  return executeBoundedRecipePlan(runtime, parseCommandJsonObject(text, "wp-codebox.bounded-runtime-plan plan") as unknown as BoundedRuntimePlan, options)
}

function redactOutput(output: string, environment: Record<string, string> | undefined): string {
  return Object.values(environment ?? {}).reduce((redacted, value) => value ? redacted.split(value).join("[redacted]") : redacted, output)
}

function runtimeArtifactRefs(execution: ExecutionResult | undefined): string[] {
  return (execution?.artifactRefs ?? []).flatMap((reference) => {
    const value = reference.path ?? reference.id
    return typeof value === "string" && value ? [value] : []
  })
}
