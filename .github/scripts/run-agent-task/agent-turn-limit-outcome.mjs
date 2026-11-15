/**
 * Explicit agent turn-limit outcome for the agent-task workflow result.
 *
 * The Agents API loop ends a synthesized max_turns budget silently and still
 * reports a completed run, so a turn-capped agent used to surface as a green
 * no-op (or fail later at verification). This projection makes the cap visible.
 *
 * Kept free of side effects so it is unit-testable without running the
 * executor entrypoint.
 */

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export const AGENT_TURN_LIMIT_SCHEMA = "wp-codebox/agent-turn-limit/v1"
export const AGENT_TURN_LIMIT_OUTCOME_SCHEMA = "wp-codebox/agent-turn-limit-outcome/v1"

/** Finds the content-free turn-limit record the runtime package executor stamps into result metadata. */
export function agentTurnLimitRecord(value) {
  let found
  const visit = (entry, depth) => {
    if (found || depth > 12) return
    if (Array.isArray(entry)) return entry.forEach((item) => visit(item, depth + 1))
    const item = record(entry)
    if (item.schema === AGENT_TURN_LIMIT_SCHEMA) {
      found = item
      return
    }
    Object.values(item).forEach((child) => visit(child, depth + 1))
  }
  visit(value, 0)
  return found
}

/** Finds a canonical terminal result that reports a max_turns stop. */
function maxTurnsTerminalResult(runtimeResult) {
  const runtime = record(runtimeResult)
  const candidates = [
    runtime.terminal_result,
    record(runtime.agent_task_run_result).terminal_result,
    record(record(runtime.agent_task_run_result).metadata).terminal_result,
  ].map(record)
  return candidates.find((candidate) => candidate.status === "max_turns" || record(candidate.max_turns).reached === true)
}

/**
 * Projects whether the agent stopped because it hit its turn cap without a
 * final answer. Sources, strongest first:
 *   1. a canonical `max_turns` terminal result,
 *   2. the executor's `wp-codebox/agent-turn-limit/v1` metadata record,
 *   3. tool observability: a tool call on the capped final turn means the model
 *      was still working when the loop ran out of turns.
 * Returns undefined when nothing about the turn limit is known.
 */
export function agentTurnLimitOutcome({ runtimeResult, toolObservability, maxTurns }) {
  const requestedMax = positiveInteger(maxTurns)
  const terminal = maxTurnsTerminalResult(runtimeResult)
  const limitRecord = agentTurnLimitRecord(runtimeResult)
  const calls = Array.isArray(record(toolObservability).calls) ? record(toolObservability).calls.map(record) : []
  const lastObservedTurn = calls.reduce((max, call) => Math.max(max, positiveInteger(call.turn) ?? 0), 0) || undefined

  const max = positiveInteger(record(terminal?.max_turns).max) ?? positiveInteger(limitRecord?.max_turns) ?? requestedMax
  const turnCount = positiveInteger(record(terminal?.max_turns).current) ?? positiveInteger(limitRecord?.turn_count) ?? lastObservedTurn
  let source
  let reached = false
  if (terminal) {
    source = "terminal-result"
    reached = true
  } else if (limitRecord) {
    source = "runtime-turn-limit"
    reached = limitRecord.max_turns_reached === true
  } else if (requestedMax && lastObservedTurn) {
    source = "tool-observability"
    reached = lastObservedTurn >= requestedMax
  } else {
    return undefined
  }

  return Object.fromEntries(Object.entries({
    schema: AGENT_TURN_LIMIT_OUTCOME_SCHEMA,
    status: reached ? "max_turns" : "within_limit",
    max_turns_reached: reached,
    max_turns: max,
    turn_count: turnCount,
    limit_source: typeof limitRecord?.source === "string" ? limitRecord.source : undefined,
    source,
    message: reached
      ? `The agent reached its ${max ? `${max}-turn ` : "turn "}limit before producing a final answer; its work is incomplete.`
      : undefined,
  }).filter(([, entry]) => entry !== undefined))
}

/** The workflow failure recorded when the agent stopped at its turn cap. */
export function agentTurnLimitFailure(outcome) {
  if (outcome?.status !== "max_turns") return undefined
  return Object.fromEntries(Object.entries({
    stage: "agent",
    code: "max_turns_exceeded",
    classification: "max_turns",
    message: outcome.message,
    max_turns: outcome.max_turns,
    turn_count: outcome.turn_count,
  }).filter(([, entry]) => entry !== undefined))
}
