import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"
import { runRecipeRunCommand } from "../packages/cli/src/commands/recipe-run.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-agent-runtime-ability-lifecycle-smoke-"))

try {
  const componentPath = writeAbilityLifecycleComponent(root)
  const recipe = buildAgentTaskRecipe({
    goal: "verify ability-backed tool lifecycle",
    component_contracts: [
      { slug: "ability-lifecycle-component", path: componentPath, loadAs: "mu-plugin", activate: false },
    ],
  }, normalizeTaskInput({ goal: "verify ability-backed tool lifecycle" }), "latest")

  recipe.workflow.steps = [{
    command: "wp-codebox.agent-sandbox-run",
    args: [
      "task=verify ability-backed tool lifecycle",
      `code=${agentSandboxProbeCode()}`,
    ],
  }]

  const recipePath = join(root, "agent-runtime-ability-lifecycle-recipe.json")
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2))

  const runOutput = await runRecipe(recipePath)
  assert.equal(runOutput.success, true)

  const sandboxExecution = runOutput.executions?.find((execution) => execution.recipeCommand === "wp-codebox.agent-sandbox-run")
  assert.ok(sandboxExecution, "agent sandbox execution should be present")
  const sandboxPayload = JSON.parse(String(sandboxExecution.stdout ?? "{}")) as { output?: string; stack?: { signals?: { runtime_lifecycle?: Record<string, number> } } }
  const lifecycle = sandboxPayload.stack?.signals?.runtime_lifecycle ?? {}
  assert.equal(lifecycle.contained_runtime_abilities_ready, 1, JSON.stringify(sandboxPayload).slice(0, 1000))

  const probe = JSON.parse(String(sandboxPayload.output ?? "{}")) as {
    hasProbeTool?: boolean
    abilityInitCount?: number
    readyCount?: number
    readySawAbilityInit?: number
  }
  assert.equal(probe.hasProbeTool, true, "tool projection registered on contained_runtime_abilities_ready should be visible")
  assert.ok((probe.abilityInitCount ?? 0) >= 1)
  assert.equal(probe.readyCount, 1)
  assert.equal(probe.readySawAbilityInit, probe.abilityInitCount)

  console.log("agent-runtime-ability-lifecycle-smoke: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

function writeAbilityLifecycleComponent(rootPath: string): string {
  const pluginPath = join(rootPath, "ability-lifecycle-component")
  mkdirSync(pluginPath, { recursive: true })
  writeFileSync(join(pluginPath, "ability-lifecycle-component.php"), `<?php
/**
 * Plugin Name: Ability Lifecycle Component
 */
defined( 'ABSPATH' ) || exit;

$GLOBALS['wp_codebox_ability_lifecycle_probe'] = array(
    'ability_init_count' => 0,
    'ready_count' => 0,
    'ready_saw_ability_init' => 0,
);

add_action( 'wp_abilities_api_init', static function (): void {
    $GLOBALS['wp_codebox_ability_lifecycle_probe']['ability_init_count'] = did_action( 'wp_abilities_api_init' );
} );

add_action( 'contained_runtime_abilities_ready', static function (): void {
    $GLOBALS['wp_codebox_ability_lifecycle_probe']['ready_count'] = did_action( 'contained_runtime_abilities_ready' );
    $GLOBALS['wp_codebox_ability_lifecycle_probe']['ready_saw_ability_init'] = did_action( 'wp_abilities_api_init' );
    add_filter( 'wp_agent_runtime_resolved_tools', static function ( array $tools ): array {
        $tools['probe-tool'] = array(
            'name' => 'probe-tool',
            'description' => 'Synthetic lifecycle probe tool.',
        );
        return $tools;
    }, 10, 3 );
} );
`)
  return pluginPath
}

function agentSandboxProbeCode(): string {
  return `
$tools = apply_filters( 'wp_agent_runtime_resolved_tools', array(), 'agent', array() );
$probe = is_array( $GLOBALS['wp_codebox_ability_lifecycle_probe'] ?? null ) ? $GLOBALS['wp_codebox_ability_lifecycle_probe'] : array();
echo wp_json_encode( array(
    'hasProbeTool' => isset( $tools['probe-tool'] ),
    'abilityInitCount' => (int) ( $probe['ability_init_count'] ?? 0 ),
    'readyCount' => (int) ( $probe['ready_count'] ?? 0 ),
    'readySawAbilityInit' => (int) ( $probe['ready_saw_ability_init'] ?? 0 ),
) );
`
}

async function runRecipe(recipePath: string): Promise<{ success?: boolean; executions?: Array<{ stdout?: string; recipeCommand?: string }> }> {
  const output = await captureStdout(async () => await runRecipeRunCommand(["--recipe", recipePath, "--json"]))
  return JSON.parse(output) as { success?: boolean; executions?: Array<{ stdout?: string; recipeCommand?: string }> }
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
