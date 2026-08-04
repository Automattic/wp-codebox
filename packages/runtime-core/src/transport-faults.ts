import { createHash } from "node:crypto"

import { stableJson, stripUndefined } from "./object-utils.js"

export const TRANSPORT_FAULT_MODEL_SCHEMA = "wp-codebox/transport-fault-model/v1" as const
export const TRANSPORT_FAULT_CAPABILITIES_SCHEMA = "wp-codebox/transport-fault-capabilities/v1" as const
export const TRANSPORT_FAULT_EVIDENCE_SCHEMA = "wp-codebox/transport-fault-evidence/v1" as const
export const TRANSPORT_FAULT_SAFE_SCHEDULE_SCHEMA = "wp-codebox/transport-fault-safe-schedule/v1" as const

export type TransportFaultSemantic =
  | "response-substitution"
  | "malformed-response"
  | "truncated-response"
  | "chunked-response"
  | "delay"
  | "jitter"
  | "bandwidth"
  | "timeout"
  | "connection-refusal"
  | "connection-reset"
  | "half-close"
  | "disconnect-after-bytes"
  | "host-remap"
  | "request-corruption"
  | "response-corruption"

export type TransportFaultFidelity = "exact" | "emulated" | "unsupported"

export interface TransportRequestMatcher {
  host?: string
  method?: string
  path?: string
  pathPattern?: string
  headers?: Record<string, string>
}

export interface TransportFaultOutcome {
  passthrough?: true
  status?: number
  headers?: Record<string, string>
  body?: string
  bodyBase64?: string
  malformed?: boolean
  truncateAfterBytes?: number
  chunkBytes?: number
  delayMs?: number
  jitterMs?: number
  bandwidthBytesPerSecond?: number
  timeoutMs?: number
  connection?: "refuse" | "reset" | "half-close"
  disconnectAfterBytes?: number
  remapHost?: string
  requestCorruption?: "truncate" | "flip-byte" | "invalid-encoding"
  responseCorruption?: "flip-byte" | "invalid-encoding"
  metadata?: Record<string, unknown>
}

export interface TransportFaultRule {
  id: string
  match: TransportRequestMatcher
  sequence: TransportFaultOutcome[]
  repeat?: "last" | "cycle" | "none"
  metadata?: Record<string, unknown>
}

export interface TransportFaultModel {
  schema: typeof TRANSPORT_FAULT_MODEL_SCHEMA
  seed: string
  rules: TransportFaultRule[]
  redactHeaders?: string[]
  metadata?: Record<string, unknown>
}

export interface TransportFaultCapability {
  semantic: TransportFaultSemantic
  fidelity: TransportFaultFidelity
  reason?: string
}

export interface TransportFaultCapabilities {
  schema: typeof TRANSPORT_FAULT_CAPABILITIES_SCHEMA
  adapter: string
  capabilities: TransportFaultCapability[]
}

export interface TransportFaultNegotiation {
  supported: boolean
  required: TransportFaultSemantic[]
  unsupported: TransportFaultCapability[]
  capabilities: TransportFaultCapabilities
}

export interface TransportFaultRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: Uint8Array | string
}

export interface TransportFaultDecision {
  ruleId: string
  sequenceIndex: number
  invocation: number
  outcome: TransportFaultOutcome
  semantics: TransportFaultSemantic[]
  delayMs: number
}

export interface TransportFaultEvidence {
  schema: typeof TRANSPORT_FAULT_EVIDENCE_SCHEMA
  fingerprint: string
  adapter: string
  fidelity: TransportFaultCapability[]
  request: {
    url: string
    method: string
    headers: Record<string, string>
    bodyBytes?: number
  }
  fault?: {
    ruleId: string
    sequenceIndex: number
    invocation: number
    semantics: TransportFaultSemantic[]
    delayMs: number
  }
  response?: {
    status?: number
    headers?: Record<string, string>
    bodyBytes?: number
    connection?: string
  }
}

export interface TransportFaultSafeSchedule {
  schema: typeof TRANSPORT_FAULT_SAFE_SCHEDULE_SCHEMA
  seed: string
  structuralFingerprint: string
  rules: Array<{
    id: string
    match: Omit<TransportRequestMatcher, "headers"> & { headerNames?: string[] }
    sequence: Array<Omit<TransportFaultOutcome, "headers" | "body" | "bodyBase64" | "metadata"> & {
      headerNames?: string[]
      body?: { encoding: "utf8" | "base64"; bytes: number; redacted: true }
      metadataRedacted?: true
    }>
    repeat?: TransportFaultRule["repeat"]
    metadataRedacted?: true
  }>
  redactHeaders?: string[]
  metadataRedacted?: true
}

export class TransportFaultEngine {
  readonly model: TransportFaultModel
  readonly capabilities: TransportFaultCapabilities
  readonly evidence: TransportFaultEvidence[] = []
  readonly #counts = new Map<string, number>()

  constructor(model: TransportFaultModel, capabilities: TransportFaultCapabilities) {
    this.model = transportFaultModel(model)
    this.capabilities = capabilities
  }

  decide(request: TransportFaultRequest): TransportFaultDecision | undefined {
    const rule = this.model.rules.find((candidate) => transportRequestMatches(candidate.match, request))
    if (!rule) return undefined
    const invocation = this.#counts.get(rule.id) ?? 0
    this.#counts.set(rule.id, invocation + 1)
    const sequenceIndex = faultSequenceIndex(rule, invocation)
    if (sequenceIndex === undefined) return undefined
    const outcome = rule.sequence[sequenceIndex] as TransportFaultOutcome
    const jitter = outcome.jitterMs ? deterministicRange(`${this.model.seed}:${rule.id}:${invocation}`, outcome.jitterMs) : 0
    return {
      ruleId: rule.id,
      sequenceIndex,
      invocation,
      outcome,
      semantics: transportFaultOutcomeSemantics(outcome),
      delayMs: Math.max(0, (outcome.delayMs ?? 0) + jitter),
    }
  }

  record(request: TransportFaultRequest, decision: TransportFaultDecision | undefined, response?: TransportFaultEvidence["response"]): TransportFaultEvidence {
    const fidelity = decision
      ? decision.semantics.map((semantic) => this.capabilities.capabilities.find((item) => item.semantic === semantic) ?? { semantic, fidelity: "unsupported" as const, reason: "Adapter did not declare this semantic." })
      : []
    const rule = decision ? this.model.rules.find(({ id }) => id === decision.ruleId) : undefined
    const declaredHeaders = [...Object.keys(rule?.match.headers ?? {}), ...Object.keys(decision?.outcome.headers ?? {})]
    const redactedHeaders = [...(this.model.redactHeaders ?? []), ...declaredHeaders]
    const requestHeaders = redactTransportHeaders(request.headers ?? {}, redactedHeaders)
    const responseHeaders = response?.headers ? redactTransportHeaders(response.headers, redactedHeaders) : undefined
    const evidence = stripUndefined({
      schema: TRANSPORT_FAULT_EVIDENCE_SCHEMA,
      fingerprint: transportFaultFingerprint({ adapter: this.capabilities.adapter, request: { url: redactTransportUrl(request.url), method: request.method.toUpperCase() }, fault: decision ? { ruleId: decision.ruleId, sequenceIndex: decision.sequenceIndex, semantics: decision.semantics } : undefined, response: response ? { status: response.status, connection: response.connection } : undefined }),
      adapter: this.capabilities.adapter,
      fidelity,
      request: {
        url: redactTransportUrl(request.url),
        method: request.method.toUpperCase(),
        headers: requestHeaders,
        bodyBytes: transportBodyBytes(request.body),
      },
      fault: decision ? { ruleId: decision.ruleId, sequenceIndex: decision.sequenceIndex, invocation: decision.invocation, semantics: decision.semantics, delayMs: decision.delayMs } : undefined,
      response: response ? { ...response, headers: responseHeaders } : undefined,
    })
    this.evidence.push(evidence)
    return evidence
  }
}

export function transportFaultModel(input: Omit<TransportFaultModel, "schema"> & { schema?: string }): TransportFaultModel {
  if (input.schema !== undefined && input.schema !== TRANSPORT_FAULT_MODEL_SCHEMA) throw new Error(`Transport fault model schema must be ${TRANSPORT_FAULT_MODEL_SCHEMA}.`)
  if (!input.seed) throw new Error("Transport fault model requires a non-empty seed.")
  const ids = new Set<string>()
  const rules = input.rules.map((rule) => {
    if (!rule.id || ids.has(rule.id)) throw new Error(`Transport fault rule ids must be non-empty and unique: ${rule.id}`)
    if (rule.sequence.length === 0) throw new Error(`Transport fault rule ${rule.id} requires at least one outcome.`)
    ids.add(rule.id)
    if (rule.match.pathPattern) new RegExp(rule.match.pathPattern)
    return { ...rule, sequence: rule.sequence.map(normalizeTransportFaultOutcome) }
  })
  return stripUndefined({ schema: TRANSPORT_FAULT_MODEL_SCHEMA, seed: input.seed, rules, redactHeaders: input.redactHeaders, metadata: input.metadata })
}

export function transportFaultCapabilities(adapter: string, capabilities: readonly TransportFaultCapability[]): TransportFaultCapabilities {
  const bySemantic = new Map<TransportFaultSemantic, TransportFaultCapability>()
  for (const capability of capabilities) bySemantic.set(capability.semantic, capability)
  return { schema: TRANSPORT_FAULT_CAPABILITIES_SCHEMA, adapter, capabilities: [...bySemantic.values()].sort((left, right) => left.semantic.localeCompare(right.semantic)) }
}

export function transportFaultSafeSchedule(modelInput: TransportFaultModel): TransportFaultSafeSchedule {
  const model = transportFaultModel(modelInput)
  const safe = stripUndefined({
    schema: TRANSPORT_FAULT_SAFE_SCHEDULE_SCHEMA,
    seed: model.seed,
    rules: model.rules.map((rule) => stripUndefined({
      id: rule.id,
      match: stripUndefined({
        host: rule.match.host,
        method: rule.match.method,
        path: rule.match.path,
        pathPattern: rule.match.pathPattern,
        headerNames: rule.match.headers ? Object.keys(rule.match.headers).map((name) => name.toLowerCase()).sort() : undefined,
      }),
      sequence: rule.sequence.map((outcome) => safeTransportFaultOutcome(outcome)),
      repeat: rule.repeat,
      metadataRedacted: rule.metadata ? true as const : undefined,
    })),
    redactHeaders: model.redactHeaders ? [...model.redactHeaders].map((name) => name.toLowerCase()).sort() : undefined,
    metadataRedacted: model.metadata ? true as const : undefined,
  })
  return { ...safe, structuralFingerprint: transportFaultFingerprint(safe) }
}

export function negotiateTransportFaults(model: TransportFaultModel, capabilities: TransportFaultCapabilities): TransportFaultNegotiation {
  const required = [...new Set(model.rules.flatMap((rule) => rule.sequence.flatMap(transportFaultOutcomeSemantics)))].sort()
  const unsupported = required.map((semantic) => capabilities.capabilities.find((item) => item.semantic === semantic) ?? { semantic, fidelity: "unsupported" as const, reason: "Adapter did not declare this semantic." }).filter((item) => item.fidelity === "unsupported")
  return { supported: unsupported.length === 0, required, unsupported, capabilities }
}

export function transportRequestMatches(matcher: TransportRequestMatcher, request: TransportFaultRequest): boolean {
  let url: URL
  try { url = new URL(request.url) } catch { return false }
  if (matcher.host && url.host.toLowerCase() !== matcher.host.toLowerCase() && url.hostname.toLowerCase() !== matcher.host.toLowerCase()) return false
  if (matcher.method && request.method.toUpperCase() !== matcher.method.toUpperCase()) return false
  if (matcher.path && url.pathname !== matcher.path) return false
  if (matcher.pathPattern && !new RegExp(matcher.pathPattern).test(url.pathname)) return false
  const headers = normalizeHeaders(request.headers ?? {})
  return Object.entries(matcher.headers ?? {}).every(([name, value]) => headers[name.toLowerCase()] === value)
}

export function transportFaultOutcomeSemantics(outcome: TransportFaultOutcome): TransportFaultSemantic[] {
  const semantics: TransportFaultSemantic[] = []
  if (outcome.status !== undefined || outcome.headers || outcome.body !== undefined || outcome.bodyBase64 !== undefined) semantics.push("response-substitution")
  if (outcome.malformed) semantics.push("malformed-response")
  if (outcome.truncateAfterBytes !== undefined) semantics.push("truncated-response")
  if (outcome.chunkBytes !== undefined) semantics.push("chunked-response")
  if (outcome.delayMs !== undefined) semantics.push("delay")
  if (outcome.jitterMs !== undefined) semantics.push("jitter")
  if (outcome.bandwidthBytesPerSecond !== undefined) semantics.push("bandwidth")
  if (outcome.timeoutMs !== undefined) semantics.push("timeout")
  if (outcome.connection === "refuse") semantics.push("connection-refusal")
  if (outcome.connection === "reset") semantics.push("connection-reset")
  if (outcome.connection === "half-close") semantics.push("half-close")
  if (outcome.disconnectAfterBytes !== undefined) semantics.push("disconnect-after-bytes")
  if (outcome.remapHost) semantics.push("host-remap")
  if (outcome.requestCorruption) semantics.push("request-corruption")
  if (outcome.responseCorruption) semantics.push("response-corruption")
  return [...new Set(semantics)]
}

export function transportFaultFingerprint(value: unknown): string {
  return createHash("sha256").update("wp-codebox/transport-fault-fingerprint/v1\n").update(stableJson(value)).digest("hex")
}

export function redactTransportHeaders(headers: Record<string, string>, extra: readonly string[] = []): Record<string, string> {
  const sensitive = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", ...extra.map((name) => name.toLowerCase())])
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, sensitive.has(name.toLowerCase()) ? "[redacted]" : value]))
}

export function redactTransportUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ""
    url.password = ""
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|nonce|password|passwd|pwd|key|signature|authorization/i.test(key)) url.searchParams.set(key, "[redacted]")
    }
    return url.toString()
  } catch {
    return raw.replace(/([?&](?:token|secret|nonce|password|key)=[^&#]*)/gi, "$1[redacted]")
  }
}

function normalizeTransportFaultOutcome(outcome: TransportFaultOutcome): TransportFaultOutcome {
  if (outcome.passthrough !== undefined && outcome.passthrough !== true) throw new Error("Transport fault outcome passthrough must be true when declared.")
  if (outcome.passthrough && Object.entries(outcome).some(([name, value]) => value !== undefined && name !== "passthrough" && name !== "metadata")) throw new Error("Transport fault passthrough outcomes cannot declare another fault effect.")
  for (const [name, value] of Object.entries(outcome)) {
    if ((name.endsWith("Ms") || name.endsWith("Bytes") || name === "bandwidthBytesPerSecond") && typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Transport fault outcome ${name} must be a finite non-negative number.`)
    }
  }
  if (outcome.status !== undefined && (!Number.isInteger(outcome.status) || outcome.status < 100 || outcome.status > 599)) throw new Error("Transport fault status must be between 100 and 599.")
  return { ...outcome, headers: outcome.headers ? normalizeHeaders(outcome.headers) : undefined }
}

function safeTransportFaultOutcome(outcome: TransportFaultOutcome): TransportFaultSafeSchedule["rules"][number]["sequence"][number] {
  const { headers, body, bodyBase64, metadata, remapHost, ...safe } = outcome
  return stripUndefined({
    ...safe,
    remapHost: remapHost ? redactTransportUrl(remapHost) : undefined,
    headerNames: headers ? Object.keys(headers).map((name) => name.toLowerCase()).sort() : undefined,
    body: body !== undefined
      ? { encoding: "utf8" as const, bytes: Buffer.byteLength(body), redacted: true as const }
      : bodyBase64 !== undefined
        ? { encoding: "base64" as const, bytes: Buffer.from(bodyBase64, "base64").byteLength, redacted: true as const }
        : undefined,
    metadataRedacted: metadata ? true as const : undefined,
  })
}

function faultSequenceIndex(rule: TransportFaultRule, invocation: number): number | undefined {
  if (invocation < rule.sequence.length) return invocation
  if ((rule.repeat ?? "last") === "cycle") return invocation % rule.sequence.length
  if ((rule.repeat ?? "last") === "last") return rule.sequence.length - 1
  return undefined
}

function deterministicRange(seed: string, maximum: number): number {
  const digest = createHash("sha256").update(seed).digest()
  return digest.readUInt32BE(0) % (Math.floor(maximum) + 1)
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
}

function transportBodyBytes(body: TransportFaultRequest["body"]): number | undefined {
  if (body === undefined) return undefined
  return typeof body === "string" ? Buffer.byteLength(body) : body.byteLength
}
