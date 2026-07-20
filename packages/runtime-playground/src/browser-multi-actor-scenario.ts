import { now } from "@automattic/wp-codebox-core/internals"
import { BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA, type BrowserMultiActorReplayArtifact, type BrowserMultiActorScenario } from "@automattic/wp-codebox-core"

export interface BrowserMultiActorEvent {
  type: "action" | "barrier" | "request-gate" | "failure" | "teardown"
  name: string
  actor?: string
  status: "started" | "waiting" | "released" | "completed" | "failed" | "closed"
  timestamp: string
  details?: Record<string, unknown>
}

export interface BrowserMultiActorClient {
  close(): Promise<void>
  execute(action: BrowserMultiActorScenario["actions"][number]): Promise<void>
  onRequest?(listener: (url: string, release: () => Promise<void>, fail: (reason: string) => Promise<void>) => void): Promise<void>
}

export interface BrowserMultiActorScenarioResult {
  schema: "wp-codebox/browser-multi-actor-result/v1"
  seed: string
  schedule: string[]
  events: BrowserMultiActorEvent[]
  replay: BrowserMultiActorReplayArtifact
  finalState: "completed" | "failed"
}

/** Carries replayable partial evidence when coordinated execution cannot finish. */
export class BrowserMultiActorScenarioError extends Error {
  constructor(message: string, readonly result: BrowserMultiActorScenarioResult) {
    super(message)
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function runBrowserMultiActorScenario(scenario: BrowserMultiActorScenario, clients: Record<string, BrowserMultiActorClient>): Promise<BrowserMultiActorScenarioResult> {
  validateScenario(scenario, clients)
  const events: BrowserMultiActorEvent[] = []
  const schedule = seededSchedule(scenario.actions.map((action) => action.id), scenario.seed)
  const actions = new Map(scenario.actions.map((action) => [action.id, action]))
  const gateReleases = new Map<string, () => void>()
  const gates = new Map(scenario.requestGates?.map((gate) => [gate.name, gate]) ?? [])
  const barriers = new Map(scenario.barriers?.map((barrier) => [barrier.name, barrier]) ?? [])
  const arrived = new Map<string, Set<string>>()
  const waiters = new Map<string, Array<() => void>>()
  let failure: Error | undefined

  for (const gate of gates.values()) {
    await clients[gate.actor]!.onRequest?.(async (url, release, fail) => {
      if (url !== gate.url || gateReleases.has(gate.name)) return release()
      events.push(event("request-gate", gate.name, gate.actor, "waiting", { url }))
      const timer = setTimeout(() => {
        gateReleases.delete(gate.name)
        events.push(event("request-gate", gate.name, gate.actor, "failed", { reason: "timeout", url }))
        void fail(`Request gate ${gate.name} timed out after ${gate.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)
      }, gate.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      gateReleases.set(gate.name, () => {
        clearTimeout(timer)
        gateReleases.delete(gate.name)
        events.push(event("request-gate", gate.name, gate.actor, "released", { url }))
        void release()
      })
    })
  }

  try {
    const tasks: Promise<void>[] = []
    for (const id of schedule) {
      const action = actions.get(id)!
      tasks.push((async () => {
        events.push(event("action", action.id, action.actor, "started"))
        await clients[action.actor]!.execute(action)
        events.push(event("action", action.id, action.actor, "completed"))
        for (const gate of action.releaseGates ?? []) {
          const release = gateReleases.get(gate)
          if (!release) throw new Error(`Action ${action.id} released request gate ${gate} before it was held`)
          release()
        }
        if (action.barrier) {
          const barrier = barriers.get(action.barrier)
          if (!barrier) throw new Error(`Action ${action.id} references unknown barrier ${action.barrier}`)
          const participants = arrived.get(barrier.name) ?? new Set<string>()
          participants.add(action.actor)
          arrived.set(barrier.name, participants)
          events.push(event("barrier", barrier.name, action.actor, participants.size === barrier.actors.length ? "released" : "waiting", { participants: [...participants].sort() }))
          if (participants.size === barrier.actors.length) {
            for (const resolve of waiters.get(barrier.name) ?? []) resolve()
            waiters.delete(barrier.name)
          } else {
            await withTimeout(new Promise<void>((resolve) => waiters.set(barrier.name, [...(waiters.get(barrier.name) ?? []), resolve])), barrier.timeoutMs ?? scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS, `Barrier ${barrier.name} timed out; waiting actors: ${barrier.actors.filter((actor) => !participants.has(actor)).join(", ")}`)
          }
        }
      })())
    }
    await Promise.all(tasks)
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    events.push(event("failure", "scenario", undefined, "failed", { message: failure.message }))
  } finally {
    for (const release of gateReleases.values()) release()
    await Promise.all(Object.entries(clients).map(async ([actor, client]) => {
      await client.close()
      events.push(event("teardown", actor, actor, "closed"))
    }))
  }
  if (failure) throw new BrowserMultiActorScenarioError(failure.message, result("failed", scenario, schedule, events))
  return result("completed", scenario, schedule, events)
}

function result(finalState: BrowserMultiActorScenarioResult["finalState"], scenario: BrowserMultiActorScenario, schedule: string[], events: BrowserMultiActorEvent[]): BrowserMultiActorScenarioResult {
  return { schema: "wp-codebox/browser-multi-actor-result/v1", seed: scenario.seed, schedule, events, replay: { schema: "wp-codebox/browser-multi-actor-replay/v1", seed: scenario.seed, scenario, schedule }, finalState }
}

function validateScenario(scenario: BrowserMultiActorScenario, clients: Record<string, BrowserMultiActorClient>): void {
  if (scenario.schema !== BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA) throw new Error(`Unsupported multi-actor scenario schema: ${scenario.schema}`)
  const actorNames = new Set(scenario.actors.map((actor) => actor.name))
  if (actorNames.size !== scenario.actors.length) throw new Error("Multi-actor scenario actor names must be unique")
  for (const actor of scenario.actors) {
    if (!actor.userSession) throw new Error(`Actor ${actor.name} must bind userSession`)
    if (!clients[actor.name]) throw new Error(`Missing browser client for actor ${actor.name}`)
  }
  for (const action of scenario.actions) if (!actorNames.has(action.actor)) throw new Error(`Action ${action.id} references unknown actor ${action.actor}`)
  for (const barrier of scenario.barriers ?? []) for (const actor of barrier.actors) if (!actorNames.has(actor)) throw new Error(`Barrier ${barrier.name} references unknown actor ${actor}`)
}

function seededSchedule(ids: string[], seed: string): string[] {
  let state = [...seed].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 2166136261)
  const output = [...ids]
  for (let index = output.length - 1; index > 0; index--) {
    state = (state * 1664525 + 1013904223) >>> 0
    const swap = state % (index + 1)
    ;[output[index], output[swap]] = [output[swap]!, output[index]!]
  }
  return output
}

function event(type: BrowserMultiActorEvent["type"], name: string, actor: string | undefined, status: BrowserMultiActorEvent["status"], details?: Record<string, unknown>): BrowserMultiActorEvent {
  return { type, name, ...(actor ? { actor } : {}), status, timestamp: now(), ...(details ? { details } : {}) }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
