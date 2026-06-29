import { stripUndefined } from "./object-utils.js"
import type { FuzzSuiteResetPolicy } from "./fuzz-suite-contracts.js"
import type { WordPressRestRouteArgDescriptor, WordPressRestRouteDescriptor, WordPressRestRouteEndpointDescriptor } from "./wordpress-runtime-discovery-contracts.js"

export const FUZZ_FIXTURE_PLAN_SCHEMA = "wp-codebox/fuzz-fixture-plan/v1" as const
export const REST_MUTATION_FIXTURE_OPT_IN_SCHEMA = "wp-codebox/rest-mutation-fixture-opt-in/v1" as const
export const REST_MUTATION_GENERATED_FIXTURES_SCHEMA = "wp-codebox/rest-mutation-generated-fixtures/v1" as const

export type FuzzFixtureOperationKind = "crud" | "read" | "mutation" | (string & {})
export type FuzzFixtureMutationMethod = "POST" | "PUT" | "PATCH" | "DELETE" | (string & {})
export type RestMutationFixtureConfidence = "high" | "medium" | "low" | "unsupported"
export type RestMutationFixtureSource = "collection-sample" | "route-schema" | "typed-generator"

export interface FuzzFixtureResourceRef {
  kind: string
  id?: string
  name?: string
  metadata?: Record<string, unknown>
}

export interface FuzzFixtureSeedOperation {
  id: string
  kind: FuzzFixtureOperationKind
  resource?: FuzzFixtureResourceRef
  method?: string
  target?: string
  input?: unknown
  expected?: unknown
  metadata?: Record<string, unknown>
}

export interface FuzzFixturePlanContract {
  schema: typeof FUZZ_FIXTURE_PLAN_SCHEMA
  id: string
  version?: string
  operations: FuzzFixtureSeedOperation[]
  operationKinds: string[]
  metadata?: Record<string, unknown>
}

export interface RestMutationFixtureOptInContract {
  schema: typeof REST_MUTATION_FIXTURE_OPT_IN_SCHEMA
  id: string
  route: string
  methods: FuzzFixtureMutationMethod[]
  auth?: RestMutationAuthPolicy
  rollbackPolicy?: FuzzSuiteResetPolicy
  rollback_policy?: FuzzSuiteResetPolicy
  fixturePlan?: FuzzFixturePlanContract
  fixturePlanRef?: string
  metadata?: Record<string, unknown>
}

export interface RestMutationGeneratedFixturesContract {
  schema: typeof REST_MUTATION_GENERATED_FIXTURES_SCHEMA
  id: string
  route: string
  methods: FuzzFixtureMutationMethod[]
  fixturePlan: FuzzFixturePlanContract
  optIns: RestMutationFixtureOptInContract[]
  unsupported: RestMutationGeneratedFixtureUnsupported[]
  artifacts: RestMutationFixtureArtifactRef[]
  metadata?: Record<string, unknown>
}

export interface RestMutationGeneratedFixtureUnsupported {
  method: string
  route: string
  reasons: string[]
  metadata?: Record<string, unknown>
}

export interface RestMutationFixtureArtifactRef {
  schema: typeof REST_MUTATION_GENERATED_FIXTURES_SCHEMA
  kind: "rest-mutation-generated-fixtures"
  path: string
  bounded: true
  contentType: "application/json"
  metadata?: Record<string, unknown>
}

export interface RestMutationAuthPolicy {
  user?: string
  session?: string
  headers?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function fuzzFixturePlanContract(input: {
  id: string
  version?: string
  operations?: FuzzFixtureSeedOperation[]
  metadata?: Record<string, unknown>
}): FuzzFixturePlanContract {
  const operations = input.operations ?? []
  return stripUndefined({
    schema: FUZZ_FIXTURE_PLAN_SCHEMA,
    id: input.id,
    version: input.version,
    operations,
    operationKinds: dedupeStrings(operations.map((operation) => operation.kind)),
    metadata: input.metadata,
  })
}

export function crudFixtureSeedOperation(input: Omit<FuzzFixtureSeedOperation, "kind">): FuzzFixtureSeedOperation {
  return fuzzFixtureSeedOperation({ ...input, kind: "crud" })
}

export function readFixtureSeedOperation(input: Omit<FuzzFixtureSeedOperation, "kind">): FuzzFixtureSeedOperation {
  return fuzzFixtureSeedOperation({ ...input, kind: "read" })
}

export function mutationFixtureSeedOperation(input: Omit<FuzzFixtureSeedOperation, "kind">): FuzzFixtureSeedOperation {
  return fuzzFixtureSeedOperation({ ...input, kind: "mutation" })
}

export function restMutationFixtureOptInContract(input: {
  id: string
  route: string
  methods: readonly string[]
  auth?: RestMutationAuthPolicy
  rollbackPolicy?: FuzzSuiteResetPolicy
  rollback_policy?: FuzzSuiteResetPolicy
  fixturePlan?: FuzzFixturePlanContract
  fixturePlanRef?: string
  metadata?: Record<string, unknown>
}): RestMutationFixtureOptInContract {
  return stripUndefined({
    schema: REST_MUTATION_FIXTURE_OPT_IN_SCHEMA,
    id: input.id,
    route: input.route,
    methods: dedupeStrings(input.methods.map((method) => method.toUpperCase())) as FuzzFixtureMutationMethod[],
    auth: input.auth,
    rollbackPolicy: input.rollbackPolicy,
    rollback_policy: input.rollback_policy,
    fixturePlan: input.fixturePlan,
    fixturePlanRef: input.fixturePlanRef,
    metadata: input.metadata,
  })
}

export function restMutationGeneratedFixturesContract(input: {
  id: string
  route: WordPressRestRouteDescriptor
  methods?: readonly string[]
  auth?: RestMutationAuthPolicy
  resetPolicy?: FuzzSuiteResetPolicy
  collectionSamples?: readonly Record<string, unknown>[]
  artifactPath?: string
  metadata?: Record<string, unknown>
}): RestMutationGeneratedFixturesContract {
  const methods = dedupeStrings((input.methods ?? input.route.methods).map((method) => method.toUpperCase())).filter((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method))
  const generated = methods.map((method) => generatedRestMutationOperation(input.route, method, input.collectionSamples ?? [])).filter((entry): entry is GeneratedRestMutationOperation => Boolean(entry))
  const operations = generated.filter((entry) => entry.confidence !== "unsupported").map((entry) => entry.operation)
  const fixturePlan = fuzzFixturePlanContract({
    id: `${input.id}-fixture-plan`,
    operations,
    metadata: stripUndefined({
      source: "rest-mutation-generated-fixtures",
      route: input.route.route,
      bounded: true,
      semanticValidity: "syntactic-route-schema-fixtures-only",
      collectionSampleCount: input.collectionSamples?.length,
    }),
  })
  const optIns = operations.map((operation) => restMutationFixtureOptInContract({
    id: `${input.id}-${String(operation.method ?? "mutation").toLowerCase()}-opt-in`,
    route: input.route.route,
    methods: operation.method ? [operation.method] : [],
    auth: input.auth,
    rollbackPolicy: input.resetPolicy,
    fixturePlan,
    metadata: stripUndefined({ source: REST_MUTATION_GENERATED_FIXTURES_SCHEMA, confidence: operation.metadata?.confidence, bounded: true }),
  }))
  const unsupported = generated.filter((entry) => entry.confidence === "unsupported").map((entry) => ({ method: entry.method, route: input.route.route, reasons: entry.unsupportedReasons, metadata: { source: REST_MUTATION_GENERATED_FIXTURES_SCHEMA } }))
  const artifactPath = input.artifactPath ?? `rest-mutation-fixtures/${slugify(input.route.namespace || "rest")}-${slugify(input.route.route)}.json`
  const artifacts: RestMutationFixtureArtifactRef[] = [{ schema: REST_MUTATION_GENERATED_FIXTURES_SCHEMA, kind: "rest-mutation-generated-fixtures", path: artifactPath, bounded: true, contentType: "application/json", metadata: { route: input.route.route, operationCount: operations.length } }]

  return stripUndefined({
    schema: REST_MUTATION_GENERATED_FIXTURES_SCHEMA,
    id: input.id,
    route: input.route.route,
    methods: methods as FuzzFixtureMutationMethod[],
    fixturePlan,
    optIns,
    unsupported,
    artifacts,
    metadata: stripUndefined({ ...input.metadata, source: "wordpress.rest-route-schema", collectionSampleCount: input.collectionSamples?.length, bounded: true, confidence: aggregateConfidence(generated.map((entry) => entry.confidence)), semanticValidity: "not-claimed" }),
  })
}

function fuzzFixtureSeedOperation(input: FuzzFixtureSeedOperation): FuzzFixtureSeedOperation {
  return stripUndefined({
    id: input.id,
    kind: input.kind,
    resource: input.resource,
    method: input.method,
    target: input.target,
    input: input.input,
    expected: input.expected,
    metadata: input.metadata,
  })
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => Boolean(value)))]
}

interface GeneratedRestMutationOperation {
  method: string
  confidence: RestMutationFixtureConfidence
  unsupportedReasons: string[]
  operation: FuzzFixtureSeedOperation
}

function generatedRestMutationOperation(route: WordPressRestRouteDescriptor, method: string, collectionSamples: readonly Record<string, unknown>[]): GeneratedRestMutationOperation | undefined {
  const endpoint = route.endpoints?.find((candidate) => candidate.methods.map((entry) => entry.toUpperCase()).includes(method))
  const args = endpoint?.args ?? []
  const pathBindings = bindPathTokens(route.route, args, collectionSamples)
  const bodyBindings = bindBodyArgs(args, pathBindings.tokenNames)
  const unsupportedReasons = [...pathBindings.unsupportedReasons, ...bodyBindings.unsupportedReasons]
  const confidence = unsupportedReasons.length ? "unsupported" : generatedConfidence(pathBindings.sources, bodyBindings.sources, endpoint)
  const operation = mutationFixtureSeedOperation({
    id: `${method.toLowerCase()}-${slugify(route.route)}`,
    method,
    target: pathBindings.path,
    input: stripUndefined({ bodyJson: Object.keys(bodyBindings.bodyJson).length ? bodyBindings.bodyJson : {}, params: undefined }),
    metadata: stripUndefined({
      source: REST_MUTATION_GENERATED_FIXTURES_SCHEMA,
      confidence,
      sources: dedupeStrings([...pathBindings.sources, ...bodyBindings.sources]),
      unsupportedReasons: unsupportedReasons.length ? unsupportedReasons : undefined,
      bounded: true,
      semanticValidity: "syntactic-route-schema-fixtures-only",
      route: route.route,
      namespace: route.namespace,
    }),
  })
  return { method, confidence, unsupportedReasons, operation }
}

function bindPathTokens(route: string, args: readonly WordPressRestRouteArgDescriptor[], collectionSamples: readonly Record<string, unknown>[]): { path: string; tokenNames: string[]; sources: RestMutationFixtureSource[]; unsupportedReasons: string[] } {
  let path = route
  const sources: RestMutationFixtureSource[] = []
  const unsupportedReasons: string[] = []
  const tokenNames = [...route.matchAll(/\(\?P<([^>]+)>[^)]+\)/g)].map((match) => match[1]).filter((name): name is string => Boolean(name))
  for (const name of tokenNames) {
    const sample = collectionSampleValue(collectionSamples, name) ?? typedArgSample(args.find((arg) => arg.name === name), restRoutePathPattern(route, name))
    if (sample === undefined || typeof sample === "object") {
      unsupportedReasons.push(`path_token_${name}_unbound`)
      continue
    }
    sources.push(collectionSampleValue(collectionSamples, name) === undefined ? "typed-generator" : "collection-sample")
    path = path.replace(restRoutePathTokenPattern(name), encodeURIComponent(String(sample)))
  }
  return { path, tokenNames, sources, unsupportedReasons }
}

function bindBodyArgs(args: readonly WordPressRestRouteArgDescriptor[], pathArgNames: readonly string[]): { bodyJson: Record<string, unknown>; sources: RestMutationFixtureSource[]; unsupportedReasons: string[] } {
  const bodyJson: Record<string, unknown> = {}
  const sources: RestMutationFixtureSource[] = []
  const unsupportedReasons: string[] = []
  for (const arg of args.filter((candidate) => !pathArgNames.includes(candidate.name) && candidate.required)) {
    const sample = typedArgSample(arg)
    if (sample === undefined) {
      unsupportedReasons.push(`required_arg_${arg.name}_unsupported`)
      continue
    }
    bodyJson[arg.name] = sample
    sources.push(arg.enum?.length ? "route-schema" : "typed-generator")
  }
  return { bodyJson, sources, unsupportedReasons }
}

function collectionSampleValue(collectionSamples: readonly Record<string, unknown>[], name: string): unknown {
  for (const sample of collectionSamples) {
    const value = sample[name] ?? sample.id ?? sample.ID
    if (["string", "number", "boolean"].includes(typeof value)) return value
  }
  return undefined
}

function typedArgSample(arg: WordPressRestRouteArgDescriptor | undefined, pathPattern?: string): unknown {
  if (arg?.enum?.length) return arg.enum[0]
  const type = Array.isArray(arg?.type) ? arg.type.find((candidate) => candidate !== "null") : arg?.type
  if (type === "integer" || type === "number") return 1
  if (type === "boolean") return true
  if (type === "array") return []
  if (type === "object") return {}
  if (arg?.format === "date-time") return "2000-01-01T00:00:00"
  if (arg?.format === "date") return "2000-01-01"
  if (arg?.format === "email") return "sample@example.com"
  if (pathPattern && /\\d|\[0-9]|\[\\d]/.test(pathPattern)) return 1
  return "sample"
}

function generatedConfidence(sources: RestMutationFixtureSource[], bodySources: RestMutationFixtureSource[], endpoint: WordPressRestRouteEndpointDescriptor | undefined): RestMutationFixtureConfidence {
  if (sources.includes("collection-sample") && endpoint) return "high"
  if (bodySources.length || endpoint) return "medium"
  return "low"
}

function aggregateConfidence(confidences: RestMutationFixtureConfidence[]): RestMutationFixtureConfidence {
  if (!confidences.length || confidences.every((confidence) => confidence === "unsupported")) return "unsupported"
  if (confidences.includes("high")) return "high"
  if (confidences.includes("medium")) return "medium"
  return "low"
}

function restRoutePathPattern(route: string, name: string): string | undefined {
  return route.match(restRoutePathTokenPattern(name))?.[1]
}

function restRoutePathTokenPattern(name: string): RegExp {
  return new RegExp(`\\(\\?P<${escapeRegExp(name)}>([^)]+)\\)`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"
}
