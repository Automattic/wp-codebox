import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA, type BrowserMultiActorScenario } from "../packages/runtime-core/src/browser-multi-actor-scenario-contracts.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/runtime-contracts.js"
import { BrowserMultiActorScenarioError, runBrowserMultiActorScenario, type BrowserMultiActorClient } from "../packages/runtime-playground/src/browser-multi-actor-scenario.js"
import { navigateBrowserMultiActorPages, runBrowserMultiActorScenarioCommand, selectBrowserMultiActorScenarioFailure } from "../packages/runtime-playground/src/browser-multi-actor-scenario-runner.js"
import { closeBrowserAndDrainPreviewRoutes, createBrowserPreviewRouteTracker } from "../packages/runtime-playground/src/browser-preview-routing.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const navigationStarted: string[] = []
let releaseNavigation!: () => void
const navigationRelease = new Promise<void>((resolve) => { releaseNavigation = resolve })
const navigation = navigateBrowserMultiActorPages([
  { actor: "author", page: { async goto(url) { navigationStarted.push(`author:${url}`); await navigationRelease; return null } } },
  { actor: "reviewer", page: { async goto(url) { navigationStarted.push(`reviewer:${url}`); await navigationRelease; return null } } },
], "https://example.test/wp-admin/post.php?post=1&action=edit")
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(navigationStarted, [
  "author:https://example.test/wp-admin/post.php?post=1&action=edit",
  "reviewer:https://example.test/wp-admin/post.php?post=1&action=edit",
])
releaseNavigation()
await navigation

await assert.rejects(
  navigateBrowserMultiActorPages([
    { actor: "reviewer", page: { async goto() { throw new Error("net::ERR_FAILED") } } },
  ], "https://example.test/editor"),
  /Actor reviewer failed to navigate to https:\/\/example\.test\/editor: net::ERR_FAILED/,
)

const closeTimeoutErrors = await closeBrowserAndDrainPreviewRoutes({ close: () => new Promise<void>(() => {}) }, createBrowserPreviewRouteTracker(), 10)
assert.equal(selectBrowserMultiActorScenarioFailure(undefined, closeTimeoutErrors), undefined)

const closeFailureErrors = await closeBrowserAndDrainPreviewRoutes({ close: async () => { throw new Error("browser close failed") } }, createBrowserPreviewRouteTracker())
assert.strictEqual(selectBrowserMultiActorScenarioFailure(undefined, closeFailureErrors), closeFailureErrors[0])

const probeFailure = new Error("editor validation failed")
assert.strictEqual(selectBrowserMultiActorScenarioFailure(probeFailure, closeTimeoutErrors), probeFailure)

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

await assert.rejects(
  runBrowserMultiActorScenario({ ...scenario, requestGates: [{ ...scenario.requestGates![0]!, occurrence: 0 }] }, clients),
  /positive occurrence/,
)

const environmentServer = createServer((_request, response) => response.end("<!doctype html><meta name=viewport content='width=device-width'><main>actors</main>"))
await new Promise<void>((resolve) => environmentServer.listen(0, "127.0.0.1", resolve))
const environmentAddress = environmentServer.address()
assert(environmentAddress && typeof environmentAddress === "object")
const environmentArtifacts = await mkdtemp(join(tmpdir(), "wp-codebox-multi-actor-environment-"))
const environmentRuntimeSpec = {
  backend: "wordpress-playground",
  environment: {},
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.browser-scenario"], secrets: "none", approvals: "never" },
  metadata: { recipe: { inputs: { fixtureUsers: [{ name: "author", userId: 11, role: "author" }, { name: "reviewer", userId: 12, role: "editor" }], userSessions: [{ name: "author-session", user: "author" }, { name: "reviewer-session", user: "reviewer" }] } } },
} as RuntimeCreateSpec
const environmentCliServer = {
  serverUrl: `http://127.0.0.1:${environmentAddress.port}`,
  playground: { async run() { return { text: "", exitCode: 0 } } },
  async [Symbol.asyncDispose]() {},
} satisfies PlaygroundCliServer
try {
  const result = await runBrowserMultiActorScenarioCommand({
    artifactRoot: environmentArtifacts,
    runtimeSpec: environmentRuntimeSpec,
    server: environmentCliServer,
    runPlaygroundCommand: async (_command, _server, _options) => ({ exitCode: 0, text: JSON.stringify([{ name: "actor_auth", value: "ready", domain: "127.0.0.1", path: "/", httpOnly: false, sameSite: "Lax" }]) }),
    scenario: {
      schema: BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA,
      seed: "actor-environments",
      url: "/",
      environment: { device: "Pixel 5", geolocation: { latitude: 32.7765, longitude: -79.9311, permission: "granted" } },
      browserArgs: [],
      actors: [{ name: "author", userSession: "author-session" }, { name: "reviewer", userSession: "reviewer-session" }],
      actions: [
        { id: "author-environment", actor: "author", step: { kind: "evaluate", expression: "const prior = localStorage.getItem('actor'); localStorage.setItem('actor', 'author'); return { prior, actor: localStorage.getItem('actor'), touch: navigator.maxTouchPoints > 0, permission: (await navigator.permissions.query({ name: 'geolocation' })).state }", assert: { prior: null, actor: "author", touch: true, permission: "granted" } } },
        { id: "reviewer-environment", actor: "reviewer", step: { kind: "evaluate", expression: "const prior = localStorage.getItem('actor'); localStorage.setItem('actor', 'reviewer'); return { prior, actor: localStorage.getItem('actor'), touch: navigator.maxTouchPoints > 0, permission: (await navigator.permissions.query({ name: 'geolocation' })).state }", assert: { prior: null, actor: "reviewer", touch: true, permission: "granted" } } },
      ],
    },
  })
  const output = JSON.parse(result.output)
  assert.equal(output.scenario.actors.author.environment.observed.hasTouch, true)
  assert.equal(output.scenario.actors.reviewer.environment.observed.hasTouch, true)
  assert.notStrictEqual(output.scenario.actors.author.environment, output.scenario.actors.reviewer.environment)

  await assert.rejects(runBrowserMultiActorScenarioCommand({
    artifactRoot: environmentArtifacts,
    runtimeSpec: environmentRuntimeSpec,
    server: environmentCliServer,
    scenario: { schema: BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA, seed: "unsupported", url: "/", environment: { device: "Unknown Device" }, browserArgs: [], actors: [], actions: [] },
  }), /browser environment is unsupported: browser.environment.device/)
} finally {
  environmentServer.close()
  await rm(environmentArtifacts, { recursive: true, force: true })
}
console.log("multi-actor browser scenarios ok")
