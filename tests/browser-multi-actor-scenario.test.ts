import assert from "node:assert/strict"
import { BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA, type BrowserMultiActorScenario } from "../packages/runtime-core/src/browser-multi-actor-scenario-contracts.js"
import { BrowserMultiActorScenarioError, runBrowserMultiActorScenario, type BrowserMultiActorClient } from "../packages/runtime-playground/src/browser-multi-actor-scenario.js"

const closed: string[] = []
const actions: string[] = []
let requestListener: ((url: string, release: () => Promise<void>, fail: (reason: string) => Promise<void>) => void) | undefined
let releaseRequest!: () => void
const requestHeld = new Promise<void>((resolve) => { releaseRequest = resolve })

const clients: Record<string, BrowserMultiActorClient> = {
  author: {
    async execute(action) {
      actions.push(action.id)
      if (action.id === "author-request") {
        const released = new Promise<void>((resolve, reject) => requestListener?.("https://example.test/save", async () => resolve(), async (reason) => reject(new Error(reason))))
        await released
        releaseRequest()
      }
    },
    async close() { closed.push("author") },
    async onRequest(listener) { requestListener = listener },
  },
  reviewer: {
    async execute(action) { actions.push(action.id) },
    async close() { closed.push("reviewer") },
  },
}

const scenario: BrowserMultiActorScenario = {
  schema: BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA,
  seed: "proof-1899",
  actors: [{ name: "author", userSession: "author-session" }, { name: "reviewer", userSession: "reviewer-session" }],
  actions: [
    { id: "author-request", actor: "author", step: { kind: "waitFor", waitFor: "duration", duration: "1ms" }, barrier: "both-ready" },
    { id: "reviewer-ready", actor: "reviewer", step: { kind: "waitFor", waitFor: "duration", duration: "1ms" }, barrier: "both-ready", releaseGates: ["author-save"] },
  ],
  barriers: [{ name: "both-ready", actors: ["author", "reviewer"], timeoutMs: 200 }],
  requestGates: [{ name: "author-save", actor: "author", url: "https://example.test/save", timeoutMs: 200 }],
}

const result = await runBrowserMultiActorScenario(scenario, clients)
await requestHeld
assert.equal(result.finalState, "completed")
assert.equal(result.replay.seed, "proof-1899")
assert.deepEqual(result.replay.schedule, result.schedule)
assert.ok(result.events.some((event) => event.type === "barrier" && event.status === "waiting"))
assert.ok(result.events.some((event) => event.type === "barrier" && event.status === "released"))
assert.ok(result.events.some((event) => event.type === "request-gate" && event.status === "waiting"))
assert.ok(result.events.some((event) => event.type === "request-gate" && event.status === "released"))
assert.ok(actions.indexOf("reviewer-ready") < actions.indexOf("author-request") || result.events.findIndex((event) => event.name === "reviewer-ready" && event.status === "completed") < result.events.findIndex((event) => event.name === "author-save" && event.status === "released"))
assert.deepEqual(closed.sort(), ["author", "reviewer"])

const timeoutClients: Record<string, BrowserMultiActorClient> = {
  author: { async execute() {}, async close() { closed.push("timeout-author") } },
  reviewer: { async execute() {}, async close() { closed.push("timeout-reviewer") } },
}
let timeoutError: unknown
try {
  await runBrowserMultiActorScenario({ ...scenario, actions: [scenario.actions[0]!], requestGates: [] }, timeoutClients)
} catch (error) {
  timeoutError = error
}
assert.ok(timeoutError instanceof BrowserMultiActorScenarioError)
assert.match(timeoutError.message, /Barrier both-ready timed out; waiting actors: reviewer/)
assert.equal(timeoutError.result.finalState, "failed")
assert.ok(timeoutError.result.events.some((event) => event.type === "failure" && event.status === "failed"))
assert.deepEqual(timeoutError.result.replay.scenario.actions, [scenario.actions[0]!])
assert.ok(closed.includes("timeout-author") && closed.includes("timeout-reviewer"))
console.log("multi-actor browser scenarios ok")
