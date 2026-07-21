import type { BrowserInteractionStep } from "./browser-interaction.js"
import type { WorkspaceRecipeBrowserActor } from "./runtime-contracts.js"

export const BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA = "wp-codebox/browser-multi-actor-scenario/v1" as const

export interface BrowserMultiActorAction {
  id: string
  actor: string
  step: BrowserInteractionStep
  barrier?: string
  releaseGates?: string[]
}

export interface BrowserMultiActorBarrier {
  name: string
  actors: string[]
  timeoutMs?: number
}

export interface BrowserMultiActorRequestGate {
  name: string
  actor: string
  url: string
  occurrence?: number
  timeoutMs?: number
}

export interface BrowserMultiActorScenario {
  schema: typeof BROWSER_MULTI_ACTOR_SCENARIO_SCHEMA
  seed: string
  actors: WorkspaceRecipeBrowserActor[]
  actions: BrowserMultiActorAction[]
  barriers?: BrowserMultiActorBarrier[]
  requestGates?: BrowserMultiActorRequestGate[]
  timeoutMs?: number
}

export interface BrowserMultiActorReplayArtifact {
  schema: "wp-codebox/browser-multi-actor-replay/v1"
  seed: string
  scenario: BrowserMultiActorScenario
  schedule: string[]
}
