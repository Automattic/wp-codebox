import assert from "node:assert/strict"
import { normalizeAgentTaskRunResult } from "../packages/runtime-core/src/index.js"
import { effectivePolicyCommands } from "../packages/runtime-core/src/contracts.js"
import { commandCatalogOutput } from "../packages/cli/src/commands/discovery.js"
import { agentTaskRunExitCode } from "../packages/cli/src/commands/agent-task-run.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"

const succeeded = normalizeAgentTaskRunResult({ success: true, status: "completed" }, { exitStatus: 0 })
assert.equal(succeeded.status, "succeeded")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: succeeded }), 0)

const noOp = normalizeAgentTaskRunResult({ success: true, no_op: true }, { exitStatus: 0 })
assert.equal(noOp.status, "no_op")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: noOp }), 0)

const timeout = normalizeAgentTaskRunResult({
  success: true,
  terminal_result: {
    schema: "wp-codebox/agent-terminal-result/v1",
    terminal: true,
    status: "max_turns",
    success: false,
  },
}, { exitStatus: 0 })
assert.equal(timeout.status, "timeout")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: timeout }), 1)

const failedExit = normalizeAgentTaskRunResult({ success: true, status: "completed" }, { exitStatus: 1 })
assert.equal(failedExit.status, "failed")
assert.equal(agentTaskRunExitCode({ success: true, agent_task_run_result: failedExit }), 1)

const catalog = commandCatalogOutput()
const agentSandboxRun = catalog.commands.find((command) => command.id === "wp-codebox.agent-sandbox-run")
assert.ok(agentSandboxRun, "catalog includes wp-codebox.agent-sandbox-run")
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code"), false)
assert.equal(agentSandboxRun.acceptedArgs.some((arg) => arg.name === "code-file"), false)
assert.deepEqual(agentSandboxRun.requiresPolicyCommands, ["wordpress.run-php", "wordpress.wp-cli"])

assert.deepEqual(effectivePolicyCommands("wp-codebox.agent-sandbox-run"), ["wordpress.run-php", "wordpress.wp-cli"])
assert.deepEqual(effectivePolicyCommands("custom.wrapper", [
  {
    id: "custom.wrapper",
    description: "test wrapper",
    acceptedArgs: [],
    outputShape: "test",
    policyRequirement: "test",
    requiresPolicyCommands: ["custom.inner"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "custom.inner" },
  },
  {
    id: "custom.inner",
    description: "test inner",
    acceptedArgs: [],
    outputShape: "test",
    policyRequirement: "test",
    requiresPolicyCommands: ["wordpress.run-php"],
    recipe: true,
    handler: { kind: "recipe-alias", command: "wordpress.run-php" },
  },
]), ["wordpress.run-php"])

const agentRecipePolicy = recipePolicy({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      { command: "wp-codebox.agent-sandbox-run", args: ["task=Verify policy dependencies"] },
    ],
  },
} as never)
assert.equal(agentRecipePolicy.commands.includes("wordpress.run-php"), true)
assert.equal(agentRecipePolicy.commands.includes("wordpress.wp-cli"), true)
assert.equal(agentRecipePolicy.commands.includes("wp-codebox.agent-sandbox-run"), false)

console.log("agent task contracts passed")
