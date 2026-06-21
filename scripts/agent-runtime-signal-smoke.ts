import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-agent-runtime-signal-smoke-"))

try {
  const agentRecipe = buildAgentTaskRecipe({
    goal: "report agent runtime signal",
    runtime_env: { EXISTING_RUNTIME_ENV: "preserved", WP_AGENT_RUNTIME: "caller-value" },
  }, normalizeTaskInput({ goal: "report agent runtime signal" }), "latest")
  assert.equal(agentRecipe.inputs?.runtimeEnv?.WP_AGENT_RUNTIME, "1")
  assert.equal(agentRecipe.inputs?.runtimeEnv?.EXISTING_RUNTIME_ENV, "preserved")
  assert.ok(!agentRecipe.inputs?.secretEnv?.includes("WP_AGENT_RUNTIME"))

  agentRecipe.workflow.steps = [{
    command: "wp-codebox.agent-sandbox-run",
    args: [
      "task=report agent runtime signal",
      "code=echo getenv('WP_AGENT_RUNTIME') ?: 'unset';",
    ],
  }]
  const agentRecipePath = join(root, "agent-runtime-recipe.json")
  writeFileSync(agentRecipePath, JSON.stringify(agentRecipe, null, 2))

  const agentOutput = await runRecipe(agentRecipePath)
  assert.equal(agentOutput.success, true)
  const agentPayload = sandboxPayload(agentOutput, "wp-codebox.agent-sandbox-run")
  assert.equal(agentPayload.output, "1")

  const frontendRecipePath = join(root, "frontend-run-php-recipe.json")
  writeFileSync(frontendRecipePath, JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "latest", blueprint: { steps: [] } },
    inputs: {},
    workflow: {
      steps: [{
        command: "wordpress.run-php",
        args: ["code=echo getenv('WP_AGENT_RUNTIME') ?: 'unset';"],
      }],
    },
  }, null, 2))

  const frontendOutput = await runRecipe(frontendRecipePath)
  assert.equal(frontendOutput.success, true)
  assert.equal(sandboxOutput(frontendOutput, "wordpress.run-php"), "unset")

  console.log("agent-runtime-signal-smoke: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

async function runRecipe(recipePath: string): Promise<RecipeRunDebugOutput> {
  const output = await captureStdout(async () => await runRecipeRunCommand(["--recipe", recipePath, "--json"]))
  return JSON.parse(output) as RecipeRunDebugOutput
}

type RecipeRunDebugOutput = {
  success?: boolean
  executions?: Array<{ stdout?: string; recipeCommand?: string; command?: string; recipe_phase?: string }>
  result?: { commands?: Array<{ command?: string; recipe_phase?: string; stdout_tail?: string }>; summary?: { commands?: Array<{ command?: string; recipe_phase?: string; stdout_tail?: string }> } }
}

function sandboxPayload(output: RecipeRunDebugOutput, command: string): { output?: string } {
  const raw = sandboxOutput(output, command)
  assert.ok(raw, `Expected ${command} output in recipe-run executions or summary commands`)
  return JSON.parse(raw) as { output?: string }
}

function sandboxOutput(output: RecipeRunDebugOutput, command: string): string {
  const execution = output.executions?.find((entry) => entry.recipeCommand === command || entry.command === command || entry.recipe_phase === "steps")
  if (execution?.stdout) {
    return execution.stdout
  }

  const summaryCommand = output.result?.commands?.find((entry) => entry.command === command || entry.recipe_phase === "steps")
  return summaryCommand?.stdout_tail ?? output.result?.summary?.commands?.find((entry) => entry.command === command || entry.recipe_phase === "steps")?.stdout_tail ?? ""
}

async function captureStdout(callback: () => Promise<unknown>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  ;(process.stdout.write as typeof process.stdout.write) = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString()
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }
    return true
  }) as typeof process.stdout.write
  try {
    await callback()
    return stdout
  } finally {
    process.stdout.write = originalWrite
  }
}
