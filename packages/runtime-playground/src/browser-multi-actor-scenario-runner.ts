import type { Page } from "playwright"
import { type BrowserMultiActorScenario, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { now } from "@automattic/wp-codebox-core/internals"
import { BrowserArtifactSession } from "./browser-artifact-session.js"
import { BrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import { attachBrowserCaptureListeners, launchChromiumBrowser, settleBrowserNetworkTasks } from "./browser-capture-session.js"
import { executeBrowserInteractionStep } from "./browser-interactions.js"
import { browserProbeReplayability } from "./browser-probe.js"
import { browserPreviewReadinessError, browserPreviewTopology, routeBrowserPreviewContextNetwork } from "./browser-preview-routing.js"
import { installWordPressAdminAuthCookies } from "./browser-probe-support.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { BrowserMultiActorScenarioError, runBrowserMultiActorScenario, type BrowserMultiActorClient, type BrowserMultiActorScenarioResult } from "./browser-multi-actor-scenario.js"
import { wordpressFixtureUserPhpCode, wordpressUserSessionFromCommandArgs, type WordPressFixtureUserSpec } from "./wordpress-user-sessions.js"
import type { BrowserArtifact, BrowserProbeErrorRecord, BrowserProbeNetworkRecord } from "./browser-artifacts.js"

const DEFAULT_STEP_TIMEOUT_MS = 15_000

export async function runBrowserMultiActorScenarioCommand(input: {
  artifactRoot: string
  scenario: BrowserMultiActorScenario & { url: string; captures?: string[]; stepTimeoutMs?: number }
  runtimeSpec: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const { artifactRoot, scenario, runtimeSpec, runPlaygroundCommand, server } = input
  // Traces are always retained for replay, even when callers narrow display captures.
  const captures = new Set([...(scenario.captures ?? ["steps", "console", "errors", "network", "screenshot"]), "trace"])
  const artifacts = new BrowserArtifactSession(artifactRoot, "files/browser", { source: "wordpress.browser-scenario", operation: "browser-multi-actor-scenario" })
  const routeHost = runtimeSpec.preview?.siteUrl ? new URL(runtimeSpec.preview.siteUrl).hostname : ""
  const topology = browserPreviewTopology(routeHost ? [`route-host=${routeHost}`] : [], runtimeSpec, server.serverUrl, server.previewProxyDiagnostics?.targetOrigin)
  const browser = await launchChromiumBrowser()
  const evidence: Record<string, ActorEvidence> = {}
  let result: BrowserMultiActorScenarioResult | undefined
  let failure: Error | undefined

  try {
    const previewReadinessError = browserPreviewReadinessError(topology.preview)
    if (previewReadinessError) {
      throw previewReadinessError
    }
    const clientEntries: Array<[string, BrowserMultiActorClient]> = []
    const actorPages: Array<{ actor: string; page: Pick<Page, "goto"> }> = []
    // Playground PHP commands share one runtime endpoint, so provision identities
    // and install cookies serially before actions begin concurrently.
    for (const actor of scenario.actors) {
      const session = wordpressUserSessionFromCommandArgs([`session=${actor.userSession}`], runtimeSpec)
      if (!session) throw new Error(`Actor ${actor.name} requires user session ${actor.userSession}`)
      const userId = await actorUserId(actor.name, session.user.userId, session.user, runtimeSpec, runPlaygroundCommand, server)
      const context = await browser.newContext(topology.contextOptions())
      await routeBrowserPreviewContextNetwork(context, topology.networkPolicy, topology.origins.localProxyOrigin)
      const page = await context.newPage()
      await context.tracing.start({ screenshots: true, snapshots: true })
      await installWordPressAdminAuthCookies({ command: "wordpress.browser-scenario", cookieUrls: topology.authCookieUrls([topology.resolveUrl(scenario.url)]), page, runPlaygroundCommand, runtimeSpec, server, userId })
      const actorEvidence = evidence[actor.name] = { console: [], errors: [], network: [], steps: [], files: {} }
      const networkTasks: Array<Promise<void>> = []
      attachBrowserCaptureListeners({ captureConsole: captures.has("console"), captureErrors: captures.has("errors"), captureNetwork: true, consoleMessages: actorEvidence.console, errors: actorEvidence.errors, network: actorEvidence.network, networkTasks, page })
      clientEntries.push([actor.name, actorClient({ actor: actor.name, artifacts, captures, context, evidence: actorEvidence, networkTasks, page, scenario, previewOrigin: topology.preview.effectiveOrigin })])
      actorPages.push({ actor: actor.name, page })
    }
    const clients = Object.fromEntries(clientEntries)
    await navigateBrowserMultiActorPages(actorPages, topology.resolveUrl(scenario.url))
    result = await runBrowserMultiActorScenario(scenario, clients)
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    if (error instanceof BrowserMultiActorScenarioError) result = error.result
  } finally {
    await browser.close()
  }

  const replay = result?.replay ?? { schema: "wp-codebox/browser-multi-actor-replay/v1", seed: scenario.seed, scenario, schedule: [] }
  const eventRecords = result?.events ?? []
  const network = Object.entries(evidence).flatMap(([actor, actorEvidence]) => actorEvidence.network.map((record) => ({ actor, ...record })))
  const requestCoverage = network.map((record) => ({ actor: record.actor, url: record.url, method: record.method, status: record.status }))
  const summary = { schema: "wp-codebox/browser-multi-actor-scenario-result/v1", capturedAt: now(), normalizedReplayInput: replay, scenario: result, actors: evidence, ...(failure ? { error: failure.message } : {}) }
  await artifacts.writeJson("summary", "multi-actor-scenario-summary.json", summary)
  await artifacts.writeJson("steps", "multi-actor-events.json", eventRecords)
  await artifacts.writeJson("steps", "multi-actor-replay.json", replay)
  await artifacts.writeJson("network", "multi-actor-network.json", network)
  await artifacts.writeJson("requestCoverage", "multi-actor-request-coverage.json", requestCoverage)
  await artifacts.writeJson("waterfall", "multi-actor-waterfall.json", network)
  const target = topology.resolveUrl(scenario.url)
  const traces = Object.values(evidence).map((actor) => actor.files.trace).filter((path): path is string => Boolean(path))
  const artifact = { artifactType: "scenario" as const, requestedUrl: target, url: target, preview: topology.preview, ...topology.origins, files: { summary: "files/browser/multi-actor-scenario-summary.json", steps: "files/browser/multi-actor-events.json", network: "files/browser/multi-actor-network.json", requestCoverage: "files/browser/multi-actor-request-coverage.json", waterfall: "files/browser/multi-actor-waterfall.json", ...(traces.length > 0 ? { traces } : {}) }, summary: { actions: scenario.actions.length, steps: scenario.actions.length, consoleMessages: Object.values(evidence).reduce((total, actor) => total + actor.console.length, 0), errors: Object.values(evidence).reduce((total, actor) => total + actor.errors.length, 0), finalUrl: target, htmlSnapshot: false, networkEvents: network.length, replayability: browserProbeReplayability(captures), screenshot: captures.has("screenshot"), viewport: null, multiActor: { seed: scenario.seed, finalState: result?.finalState ?? "failed", actors: Object.keys(evidence), replay: "files/browser/multi-actor-replay.json" } } } satisfies BrowserArtifact
  if (failure) throw new BrowserCommandArtifactError(`wordpress.browser-scenario failed: ${failure.message}`, artifact)
  return { artifact, output: `${JSON.stringify({ command: "wordpress.browser-scenario", files: artifact.files, summary: artifact.summary, scenario: summary }, null, 2)}\n` }
}

export async function navigateBrowserMultiActorPages(
  actorPages: Array<{ actor: string; page: Pick<Page, "goto"> }>,
  url: string,
): Promise<void> {
  await Promise.all(actorPages.map(async ({ actor, page }) => {
    try {
      await page.goto(url, { waitUntil: "load" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Actor ${actor} failed to navigate to ${url}: ${message}`)
    }
  }))
}

interface ActorEvidence {
  console: Record<string, unknown>[]
  errors: BrowserProbeErrorRecord[]
  network: BrowserProbeNetworkRecord[]
  steps: Array<Record<string, unknown>>
  files: Record<string, string>
}

function actorClient(input: { actor: string; artifacts: BrowserArtifactSession; captures: Set<string>; context: import("playwright").BrowserContext; evidence: ActorEvidence; networkTasks: Array<Promise<void>>; page: import("playwright").Page; scenario: BrowserMultiActorScenario & { stepTimeoutMs?: number }; previewOrigin: string }): BrowserMultiActorClient {
  const { actor, artifacts, captures, context, evidence, networkTasks, page, scenario, previewOrigin } = input
  return {
    async execute(action) {
      const startedAt = now()
      try {
        await executeBrowserInteractionStep(page, action.step, previewOrigin, scenario.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, async (name, write) => {
          const fileName = `${actor}-${name}`
          await artifacts.writeGenerated("screenshot", fileName, write)
          return { path: artifacts.path(fileName), isDefault: false }
        })
        evidence.steps.push({ action: action.id, status: "ok", startedAt, finalUrl: page.url() })
      } catch (error) {
        evidence.steps.push({ action: action.id, status: "failed", startedAt, finalUrl: page.url(), error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
    async onRequest(listener) {
      for (const gate of scenario.requestGates?.filter((candidate) => candidate.actor === actor) ?? []) {
        await page.route(gate.url, (route) => listener(route.request().url(), () => route.continue(), (reason) => route.abort(reason)))
      }
    },
    async close() {
      try {
        await settleBrowserNetworkTasks(networkTasks)
        if (captures.has("screenshot")) {
          const name = `${actor}-screenshot.png`
          await artifacts.writeGenerated("screenshot", name, (path) => page.screenshot({ path, fullPage: true }).then(() => undefined)).catch(() => undefined)
          evidence.files.screenshot = artifacts.path(name)
        }
        if (captures.has("trace")) {
          const name = `${actor}-trace.zip`
          await artifacts.writeGenerated("traces", name, (path) => context.tracing.stop({ path })).catch(() => undefined)
          evidence.files.trace = artifacts.path(name)
        }
        for (const [key, records] of Object.entries({ console: evidence.console, errors: evidence.errors, network: evidence.network, steps: evidence.steps })) {
          if (key === "steps" || captures.has(key)) {
            const name = `${actor}-${key}.jsonl`
            await artifacts.writeJsonLines(key as "console" | "errors" | "network" | "steps", name, records)
            evidence.files[key] = artifacts.path(name)
          }
        }
      } finally {
        await context.close()
      }
    },
  }
}

async function actorUserId(actor: string, knownUserId: number | undefined, user: WordPressFixtureUserSpec, runtimeSpec: RuntimeCreateSpec, runPlaygroundCommand: ((command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>) | undefined, server: PlaygroundCliServer): Promise<number> {
  if (knownUserId) return knownUserId
  if (!runPlaygroundCommand) throw new Error(`Actor ${actor} requires a fixture user ID and Playground PHP command support`)
  const response = await runPlaygroundCommand("wordpress.browser-scenario.actor-auth", server, { code: bootstrapPhpCode(runtimeSpec, `${wordpressFixtureUserPhpCode(user)} echo (string) get_current_user_id();`, []) })
  assertPlaygroundResponseOk("wordpress.browser-scenario.actor-auth", response)
  const match = response.text.match(/(\d+)\s*$/)
  if (!match) throw new Error(`Actor ${actor} fixture user ID was not returned`)
  return Number(match[1])
}
