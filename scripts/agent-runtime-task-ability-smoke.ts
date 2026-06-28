import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chdir, cwd } from "node:process"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-runtime-task-ability-smoke-"))
const originalCwd = cwd()

try {
  chdir(root)
  const componentPath = writeRuntimeTaskComponent(root)
  const available = await runRuntimeTaskRecipe(root, componentPath, "example/runtime-task")
  const availableRuntime = sandboxAgentRuntime(available)
  assert.equal(available.success, true, JSON.stringify(availableRuntime, null, 2))
  assert.equal(availableRuntime.success, true, JSON.stringify(availableRuntime, null, 2))
  assert.deepEqual(availableRuntime.result, {
    schema: "example/runtime-task-result/v1",
    success: true,
    concept_packet: { title: "Runtime task ability available" },
  })

  const alias = await runRuntimeTaskRecipe(root, componentPath, "runtime-package/run")
  const aliasRuntime = sandboxAgentRuntime(alias)
  assert.equal(alias.success, true, JSON.stringify(aliasRuntime, null, 2))
  assert.equal(aliasRuntime.success, true, JSON.stringify(aliasRuntime, null, 2))
  assert.equal(aliasRuntime.result?.schema, "example/runtime-package-result/v1")
  assert.equal(aliasRuntime.result?.success, true)
  assert.equal(aliasRuntime.result?.concept_packet?.title, "Runtime task ability available")

  const missing = await runRuntimeTaskRecipe(root, componentPath, "example/missing-runtime-task")
  const missingRuntime = sandboxAgentRuntime(missing)
  assert.equal(missingRuntime.success, false)
  assert.equal(missingRuntime.error?.code, "runtime_task_ability_missing_preflight")
  assert.equal(missingRuntime.error?.data?.preflight?.schema, "wp-codebox/runtime-task-ability-preflight/v1")
  assert.equal(missingRuntime.error?.data?.preflight?.ability, "example/missing-runtime-task")
  assert.equal(missingRuntime.error?.data?.preflight?.available, false)
  assert.ok(missingRuntime.error?.data?.preflight?.registered_ability_ids.includes("example/runtime-task"))

  console.log("agent-runtime-task-ability-smoke: ok")
} finally {
  chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
}

function writeRuntimeTaskComponent(rootPath: string): string {
  const pluginPath = join(rootPath, "runtime-task-component")
  mkdirSync(pluginPath, { recursive: true })
  writeFileSync(join(pluginPath, "runtime-task-component.php"), `<?php
/**
 * Plugin Name: Runtime Task Component
 */
defined( 'ABSPATH' ) || exit;

add_action( 'wp_abilities_api_init', static function (): void {
    wp_register_ability(
        'example/runtime-task',
        array(
            'label' => 'Example Runtime Task',
            'description' => 'Synthetic runtime task ability for sandbox materialization tests.',
            'category' => 'wp-codebox',
            'execute_callback' => static function ( array $input ): array {
                return array(
                    'schema' => 'example/runtime-task-result/v1',
                    'success' => true,
                    'concept_packet' => array( 'title' => (string) ( $input['title'] ?? '' ) ),
                );
            },
            'permission_callback' => '__return_true',
            'input_schema' => array( 'type' => 'object' ),
            'output_schema' => array( 'type' => 'object' ),
        )
    );

    wp_register_ability(
        'agents/run-runtime-package',
        array(
            'label' => 'Example Runtime Package Adapter',
            'description' => 'Synthetic runtime package adapter for sandbox ability alias tests.',
            'category' => 'wp-codebox',
            'execute_callback' => static function ( array $input ): array {
                return array(
                    'schema' => 'example/runtime-package-result/v1',
                    'success' => true,
                    'concept_packet' => array( 'title' => (string) ( $input['title'] ?? '' ) ),
                );
            },
            'permission_callback' => '__return_true',
            'input_schema' => array( 'type' => 'object' ),
            'output_schema' => array( 'type' => 'object' ),
        )
    );
} );
`)
  return pluginPath
}

async function runRuntimeTaskRecipe(rootPath: string, componentPath: string, ability: string): Promise<{ success?: boolean; executions?: Array<{ recipeCommand?: string; stdout?: string; parsed?: unknown }> }> {
  const recipe = buildAgentTaskRecipe({
    goal: `verify runtime task ability ${ability}`,
    component_contracts: [
      { slug: "runtime-task-component", path: componentPath, loadAs: "mu-plugin", activate: false },
    ],
    runtime_task: {
      ability,
      input: { title: "Runtime task ability available" },
    },
  }, normalizeTaskInput({ goal: `verify runtime task ability ${ability}` }), "latest")
  const recipePath = join(rootPath, `${ability.replace(/[^a-z0-9_-]+/gi, "-")}.json`)
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2))

  const output = await captureStdout(async () => await runRecipeRunCommand(["--recipe", recipePath, "--json"]))
  return JSON.parse(output) as { success?: boolean; executions?: Array<{ recipeCommand?: string; stdout?: string; parsed?: unknown }> }
}

function sandboxAgentRuntime(runOutput: { executions?: Array<{ recipeCommand?: string; stdout?: string; parsed?: unknown }> }): { success?: boolean; result?: any; error?: { code?: string; data?: { preflight?: { schema?: string; ability?: string; resolved_ability?: string; available?: boolean; registered_ability_ids?: string[] } } } } {
  const execution = runOutput.executions?.find((item) => item.recipeCommand === "wp-codebox.agent-sandbox-run")
  assert.ok(execution, "agent sandbox execution should be present")
  const parsed = typeof execution.parsed === "object" && execution.parsed !== null
    ? execution.parsed as Record<string, unknown>
    : JSON.parse(String(execution.stdout ?? "{}")) as Record<string, unknown>
  const output = typeof parsed.output === "string" ? JSON.parse(parsed.output) as Record<string, unknown> : parsed
  return output.agent_runtime as { success?: boolean; result?: any; error?: { code?: string; data?: { preflight?: { schema?: string; ability?: string; resolved_ability?: string; available?: boolean; registered_ability_ids?: string[] } } } }
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
