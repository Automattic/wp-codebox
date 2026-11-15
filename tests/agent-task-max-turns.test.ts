import assert from "node:assert/strict"

import { agentTurnLimitFailure, agentTurnLimitOutcome, agentTurnLimitRecord } from "../.github/scripts/run-agent-task/agent-turn-limit-outcome.mjs"
import { resolveSandboxTaskCode } from "../packages/cli/src/agent-code.js"

const policy = { schema: "wp-codebox/sandbox-tool-policy/v1", version: 1, tools: [] } as const

function runtimeTaskFromCode(code: string): Record<string, any> {
  const match = code.match(/\$sandbox_runtime_task = json_decode\(<<<'(WP_CODEBOX_LITERAL_[A-Z0-9]+)'\n([\s\S]*?)\n\1, true\);/)
  assert.ok(match, "generated code declares the runtime task as a nowdoc literal")
  return JSON.parse(match[2])
}

// The caller's --max-turns reaches the runtime package agents/chat input, which
// otherwise falls back to the package/handler default (12).
{
  const code = await resolveSandboxTaskCode({
    task: "Maintain docs",
    agent: "wp-codebox-sandbox",
    maxTurns: "40",
    sandboxToolPolicy: policy,
    runtimeTask: { ability: "wp-codebox/run-runtime-package", input: { workflow: { id: "agents/chat" }, input: { prompt: "Maintain docs" } } },
  })
  const runtimeTask = runtimeTaskFromCode(code)
  assert.equal(runtimeTask.input.input.max_turns, 40, "caller max_turns reaches the runtime package chat input")
  assert.equal(runtimeTask.input.task_input.max_turns, 40)
}

// An explicit max_turns already inside the runtime package input is preserved.
{
  const code = await resolveSandboxTaskCode({
    task: "Maintain docs",
    agent: "wp-codebox-sandbox",
    maxTurns: "40",
    sandboxToolPolicy: policy,
    runtimeTask: { ability: "wp-codebox/run-runtime-package", input: { input: { prompt: "Maintain docs", max_turns: 25 } } },
  })
  assert.equal(runtimeTaskFromCode(code).input.input.max_turns, 25)
}

// Other runtime task abilities are left untouched.
{
  const code = await resolveSandboxTaskCode({
    task: "Run",
    agent: "wp-codebox-sandbox",
    maxTurns: "40",
    sandboxToolPolicy: policy,
    runtimeTask: { ability: "example/other", input: { input: { prompt: "Run" } } },
  })
  assert.equal(runtimeTaskFromCode(code).input.input.max_turns, undefined)
}

const call = (turn: number) => ({ sequence: turn, turn, tool_call_id: `call-${turn}`, tool_name: "workspace_read", status: "succeeded", arguments: { keys: [], count: 0, redacted: true } })

// 1. A canonical max_turns terminal result is the strongest signal.
{
  const outcome = agentTurnLimitOutcome({
    runtimeResult: { success: false, agent_task_run_result: { status: "timeout", terminal_result: { schema: "wp-codebox/agent-terminal-result/v1", terminal: true, status: "max_turns", success: false, max_turns: { reached: true, current: 40, max: 40 } } } },
    maxTurns: 40,
  })
  assert.deepEqual(outcome, {
    schema: "wp-codebox/agent-turn-limit-outcome/v1",
    status: "max_turns",
    max_turns_reached: true,
    max_turns: 40,
    turn_count: 40,
    source: "terminal-result",
    message: "The agent reached its 40-turn limit before producing a final answer; its work is incomplete.",
  })
  assert.deepEqual(agentTurnLimitFailure(outcome), {
    stage: "agent",
    code: "max_turns_exceeded",
    classification: "max_turns",
    message: outcome!.message,
    max_turns: 40,
    turn_count: 40,
  })
}

// 2. The executor turn-limit record is discovered wherever the result nests it.
{
  const limit = { schema: "wp-codebox/agent-turn-limit/v1", max_turns: 12, source: "package_default", turn_count: 12, final_turn_tool_calls: 3, max_turns_reached: true }
  const runtimeResult = { success: true, agent_task_result: { raw: { agent_runtime: { result: { metadata: { turn_limit: limit } } } } } }
  assert.deepEqual(agentTurnLimitRecord(runtimeResult), limit)
  const outcome = agentTurnLimitOutcome({ runtimeResult, maxTurns: 12 })
  assert.equal(outcome?.status, "max_turns")
  assert.equal(outcome?.source, "runtime-turn-limit")
  assert.equal(outcome?.limit_source, "package_default")
  const within = agentTurnLimitOutcome({ runtimeResult: { metadata: { turn_limit: { ...limit, turn_count: 4, max_turns_reached: false } } }, maxTurns: 12 })
  assert.equal(within?.status, "within_limit")
  assert.equal(agentTurnLimitFailure(within), undefined)
}

// 3. Tool observability fallback: a tool call on the capped turn means the
//    agent was still working when it ran out (run 43726382831 shape).
{
  const capped = agentTurnLimitOutcome({ runtimeResult: { success: true }, toolObservability: { version: 1, calls: [call(11), call(12)] }, maxTurns: 12 })
  assert.equal(capped?.status, "max_turns")
  assert.equal(capped?.source, "tool-observability")
  assert.equal(capped?.turn_count, 12)
  const finished = agentTurnLimitOutcome({ runtimeResult: { success: true }, toolObservability: { version: 1, calls: [call(3)] }, maxTurns: 12 })
  assert.equal(finished?.status, "within_limit")
}

// 4. Nothing known about turns: no outcome is invented.
assert.equal(agentTurnLimitOutcome({ runtimeResult: { success: true }, maxTurns: 12 }), undefined)
assert.equal(agentTurnLimitOutcome({ runtimeResult: { success: true }, toolObservability: { version: 1, calls: [call(12)] } }), undefined)

console.log("agent task max turns ok")
