import { fuzzCoveragePlanContract, type FuzzCoveragePlanContract, type FuzzCoveragePlanItem, type FuzzCoveragePlanParameterGenerationHook, type FuzzCoveragePlanReason } from "./fuzz-coverage-plan-contracts.js"
import type { FuzzFixtureSeedOperation, RestMutationFixtureOptInContract } from "./fuzz-fixture-plan-contracts.js"
import { fuzzSuiteContract, type FuzzSuiteCase, type FuzzSuiteContract, type FuzzSuiteMutationIntent, type FuzzSuiteResetPolicy, type FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js"
import { stripUndefined } from "./object-utils.js"
import { WORDPRESS_DB_OPERATION_SCHEMA, normalizeWordPressDbOperation } from "./wordpress-db-contracts.js"
import type { WordPressAdminPageDescriptor, WordPressAdminPageInteractionDescriptor, WordPressAdminPageInventory, WordPressDatabaseColumnDescriptor, WordPressDatabaseInventory, WordPressDatabaseTableDescriptor, WordPressFrontendUrlDescriptor, WordPressFrontendUrlInventory, WordPressRestRouteArgDescriptor, WordPressRestRouteDescriptor, WordPressRestRouteEndpointDescriptor, WordPressRestRouteInventory } from "./wordpress-runtime-discovery-contracts.js"

export interface WordPressInventoryFuzzSuiteOptions {
  id?: string
  version?: string
  metadata?: Record<string, unknown>
  user?: string
  session?: string
  pageLoadMode?: WordPressPageLoadFuzzMode
  capture?: readonly string[]
  restMutationOptIns?: readonly RestMutationFixtureOptInContract[]
  restPayloadFamilies?: readonly WordPressRestPayloadFamily[]
  restGeneratedMutationResetPolicy?: FuzzSuiteResetPolicy
  dbGeneratedMutationResetPolicy?: FuzzSuiteResetPolicy
}

export type WordPressPageLoadFuzzMode = "simulated" | "server" | "browser"
export type WordPressRestPayloadFamily = "valid-minimal" | "boundary-large-string" | "invalid-type" | "nested-object" | "null-empty" | "enum-variant" | "numeric-boundary" | "boolean-flip" | "repeated-field"

const SAFE_REST_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const REST_LARGE_STRING_LENGTH = 256
const REST_REPEATED_FIELD_COUNT = 3

const REST_REQUEST_TARGET: FuzzSuiteTargetRef = {
  kind: "rest",
  id: "wordpress.rest-request",
  entrypoint: "wordpress.rest-request",
  label: "WordPress REST request",
}

const PLANNED_REST_REQUEST_TARGET: FuzzSuiteTargetRef = {
  kind: "rest-planned",
  id: "wordpress.rest-request",
  entrypoint: "wordpress.rest-request",
  label: "Planned WordPress REST request",
}

const ADMIN_PAGE_LOAD_TARGET: FuzzSuiteTargetRef = {
  kind: "runtime",
  id: "wordpress.simulated-admin-page-load",
  entrypoint: "wordpress.simulated-admin-page-load",
  label: "WordPress admin page load",
}

const FRONTEND_PAGE_LOAD_TARGET: FuzzSuiteTargetRef = {
  kind: "runtime",
  id: "wordpress.simulated-frontend-page-load",
  entrypoint: "wordpress.simulated-frontend-page-load",
  label: "WordPress frontend page load",
}

const DB_OPERATION_TARGET: FuzzSuiteTargetRef = {
  kind: "runtime",
  id: "wordpress.db-operation",
  entrypoint: "wordpress.db-operation",
  label: "WordPress DB operation",
}

const ADMIN_ACTION_DISCOVERY_TARGET: FuzzSuiteTargetRef = {
  kind: "runtime",
  id: "wordpress.browser-actions",
  entrypoint: "wordpress.browser-actions",
  label: "WordPress admin action discovery",
}

const REST_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:rest"],
  targetKinds: ["rest"],
}

const REST_MUTATION_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:runtime-action", "runtime-action:rest_request", "rest-mutation:fixture-opt-in"],
  targetKinds: ["runtime-action"],
  runtimeActionTypes: ["rest_request"],
  commands: ["wordpress.rest-request", "wp-codebox.checkpoint-create", "wp-codebox.checkpoint-restore"],
}

const ADMIN_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:runtime", "runtime"],
  targetKinds: ["runtime"],
  commands: ["wordpress.simulated-admin-page-load"],
}

const FRONTEND_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:runtime", "runtime"],
  targetKinds: ["runtime"],
  commands: ["wordpress.simulated-frontend-page-load"],
}

const DB_OPERATION_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:runtime", "runtime", "db_operation"],
  targetKinds: ["runtime"],
  commands: ["wordpress.db-operation"],
}

const ADMIN_ACTION_DISCOVERY_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:runtime", "runtime"],
  targetKinds: ["runtime"],
  commands: ["wordpress.browser-actions"],
}

const REST_PARAMETER_GENERATION_HOOK: FuzzCoveragePlanParameterGenerationHook = {
  id: "wordpress.rest-route-parameters",
  label: "WordPress REST route parameter generator",
  description: "Generates conservative concrete REST path and query parameters from discovered safe-method route args.",
}

const REST_MUTATING_OPT_IN_HOOK: FuzzCoveragePlanParameterGenerationHook = {
  id: "wordpress.rest-mutating-route-opt-in",
  label: "WordPress REST mutating route opt-in",
  description: "Placeholder hook for consumers that explicitly choose safe fixtures and authorization for mutating REST methods.",
}

export function restRouteInventoryToFuzzSuite(inventory: WordPressRestRouteInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-rest-route-inventory-fuzz-suite",
    version: options.version,
    target: REST_REQUEST_TARGET,
    cases: inventory.routes.flatMap((route) => restRouteFuzzSuiteCases(route, options)),
    coveragePlan: restRouteInventoryToCoveragePlan(inventory, options),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, requiredRunnerCapabilities: REST_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES }),
  })
}

export function adminPageInventoryToFuzzSuite(inventory: WordPressAdminPageInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  const pageLoad = pageLoadFuzzMode("admin", options.pageLoadMode)
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-admin-page-inventory-fuzz-suite",
    version: options.version,
    target: pageLoad.target,
    cases: adminPageInventoryFuzzSuiteCases(inventory, options),
    coveragePlan: adminPageInventoryToCoveragePlan(inventory, options),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, adminUrl: inventory.adminUrl, menuLoaded: inventory.menuLoaded, pageLoadMode: pageLoad.mode, requiredRunnerCapabilities: pageLoad.requiredRunnerCapabilities }),
  })
}

export function frontendUrlInventoryToFuzzSuite(inventory: WordPressFrontendUrlInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  const pageLoad = pageLoadFuzzMode("frontend", options.pageLoadMode)
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-frontend-url-inventory-fuzz-suite",
    version: options.version,
    target: pageLoad.target,
    cases: inventory.urls.map((url) => frontendUrlFuzzSuiteCase(url, inventory.homeUrl, options)),
    coveragePlan: frontendUrlInventoryToCoveragePlan(inventory, options),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, homeUrl: inventory.homeUrl, permalinkStructure: inventory.permalinkStructure, pageLoadMode: pageLoad.mode, requiredRunnerCapabilities: pageLoad.requiredRunnerCapabilities }),
  })
}

export function databaseInventoryToFuzzSuite(inventory: WordPressDatabaseInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-database-inventory-fuzz-suite",
    version: options.version,
    target: DB_OPERATION_TARGET,
    cases: inventory.tables.filter((table) => table.classification !== "external").flatMap((table) => databaseTableFuzzSuiteCases(table, options)),
    coveragePlan: databaseInventoryToCoveragePlan(inventory, options),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, prefix: inventory.prefix, requiredRunnerCapabilities: DB_OPERATION_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES }),
  })
}

export function restRouteInventoryToCoveragePlan(inventory: WordPressRestRouteInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzCoveragePlanContract {
  const discovered = inventory.routes.flatMap((route) => restRouteCoveragePlanItems(route, options))
  const executable = discovered.filter((item) => item.input !== undefined && !item.reason)
  const untested = discovered.filter((item) => item.reason)

  return fuzzCoveragePlanContract({
    id: options.id ?? "wordpress-rest-route-inventory-coverage-plan",
    version: options.version,
    discovered,
    generated: discovered,
    executable,
    untested,
    parameterGenerationHooks: [REST_PARAMETER_GENERATION_HOOK, REST_MUTATING_OPT_IN_HOOK],
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status }),
  })
}

export function adminPageInventoryToCoveragePlan(inventory: WordPressAdminPageInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzCoveragePlanContract {
  const discovered = adminPageInventoryCoveragePlanItems(inventory, options)
  const executable = discovered.filter((item) => !item.reason)
  const skipped = discovered.filter((item) => item.reason?.code === "admin_page_capability_denied")

  return fuzzCoveragePlanContract({
    id: options.id ?? "wordpress-admin-page-inventory-coverage-plan",
    version: options.version,
    discovered,
    generated: discovered,
    executable,
    skipped,
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, adminUrl: inventory.adminUrl, menuLoaded: inventory.menuLoaded, pageLoadMode: pageLoadFuzzMode("admin", options.pageLoadMode).mode }),
  })
}

export function frontendUrlInventoryToCoveragePlan(inventory: WordPressFrontendUrlInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzCoveragePlanContract {
  const discovered = inventory.urls.map((url) => frontendUrlCoveragePlanItem(url, inventory.homeUrl, options))

  return fuzzCoveragePlanContract({
    id: options.id ?? "wordpress-frontend-url-inventory-coverage-plan",
    version: options.version,
    discovered,
    generated: discovered,
    executable: discovered,
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, homeUrl: inventory.homeUrl, permalinkStructure: inventory.permalinkStructure, pageLoadMode: pageLoadFuzzMode("frontend", options.pageLoadMode).mode }),
  })
}

export function databaseInventoryToCoveragePlan(inventory: WordPressDatabaseInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzCoveragePlanContract {
  const discovered = inventory.tables.flatMap((table) => databaseTableCoveragePlanItems(table, options))
  const executable = discovered.filter((item) => !item.reason)
  const skipped = discovered.filter((item) => item.reason)

  return fuzzCoveragePlanContract({
    id: options.id ?? "wordpress-database-inventory-coverage-plan",
    version: options.version,
    discovered,
    generated: discovered,
    executable,
    skipped,
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, prefix: inventory.prefix }),
  })
}

function restRouteFuzzSuiteCases(route: WordPressRestRouteDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase[] {
  const endpointCases = route.endpoints?.flatMap((endpoint, endpointIndex) => endpoint.methods.flatMap((method) => restRouteFuzzSuiteCasesForMethod(route, method, options, endpoint, endpointIndex)))
  if (endpointCases?.length) {
    return endpointCases
  }
  return route.methods.flatMap((method) => restRouteFuzzSuiteCasesForMethod(route, method, options))
}

function restRouteFuzzSuiteCasesForMethod(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint?: WordPressRestRouteEndpointDescriptor, endpointIndex?: number): FuzzSuiteCase[] {
  const payloadFamilies = options.restPayloadFamilies
  if (!payloadFamilies?.length) {
    return [restRouteFuzzSuiteCase(route, method, options, endpoint, endpointIndex)]
  }

  return payloadFamilies.flatMap((payloadFamily) => {
    const fuzzCase = restRouteFuzzSuiteCase(route, method, options, endpoint, endpointIndex, payloadFamily)
    return fuzzCase.input === undefined && (fuzzCase.metadata?.safety as Record<string, unknown> | undefined)?.payloadFamilySkipped ? [] : [fuzzCase]
  })
}

function restRouteFuzzSuiteCase(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint?: WordPressRestRouteEndpointDescriptor, endpointIndex?: number, payloadFamily?: WordPressRestPayloadFamily): FuzzSuiteCase {
  const normalizedMethod = method.toUpperCase()
  const requiredArgs = endpoint?.args.filter((arg) => arg.required).map((arg) => arg.name) ?? []
  const safeMethod = SAFE_REST_METHODS.has(normalizedMethod)
  const mutationOptIn = safeMethod ? undefined : matchingRestMutationOptIn(route.route, normalizedMethod, options)
  const concreteInput = safeMethod
    ? concreteRestInput(route, normalizedMethod, options, endpoint, payloadFamily)
    : concreteRestMutationInput(route, normalizedMethod, options, endpoint, mutationOptIn, payloadFamily)
  const executable = concreteInput !== undefined
  const generatedMutation = !safeMethod && !mutationOptIn && executable
  const mutation = generatedMutation ? restGeneratedMutationIntent(normalizedMethod) : undefined
  const safety = stripUndefined({
    executable,
    safeMethod,
    planned: !executable,
    reason: executable ? undefined : safeMethod ? "route_requires_discovered_parameters" : payloadFamily && !options.restGeneratedMutationResetPolicy ? "mutating_rest_method_requires_reset_policy" : "mutating_rest_method_requires_explicit_opt_in",
    requiredArgs: requiredArgs.length ? requiredArgs : undefined,
    generatedParameters: concreteInput?.generatedParameters,
    payloadFamily,
    payloadFamilySkipped: payloadFamily && concreteInput === undefined && generatedRestPayloadFamilySkippable(payloadFamily) ? true : undefined,
  })

  return stripUndefined({
    id: `${restRouteCaseId(route.route, normalizedMethod, endpointIndex)}${payloadFamily ? `-${slugify(payloadFamily)}` : ""}`,
    target: executable ? (safeMethod ? REST_REQUEST_TARGET : { kind: "runtime-action", id: "wordpress.rest-request", entrypoint: "wordpress.rest-request", label: "Rollback-isolated WordPress REST mutation" }) : PLANNED_REST_REQUEST_TARGET,
    description: `${normalizedMethod} ${route.route}`,
    input: concreteInput ? restInputForCase(concreteInput, !safeMethod) : undefined,
    resetPolicy: !safeMethod ? (mutationOptIn ? mutationOptIn.rollbackPolicy ?? mutationOptIn.rollback_policy : options.restGeneratedMutationResetPolicy) : undefined,
    mutation,
    metadata: stripUndefined({
      source: "wordpress.rest-route-inventory",
      route: route.route,
      namespace: route.namespace,
      method: normalizedMethod,
      permission: endpoint?.permission,
      argNames: route.argNames,
      safety,
      payloadFamily,
      seed: payloadFamily ? { source: "wordpress.rest-route-inventory", route: route.route, method: normalizedMethod, endpointIndex, payloadFamily } : undefined,
      replay: payloadFamily ? { source: "wordpress.rest-route-inventory", caseId: `${restRouteCaseId(route.route, normalizedMethod, endpointIndex)}-${slugify(payloadFamily)}`, route: route.route, method: normalizedMethod, payloadFamily } : undefined,
      restMutationFixtureOptIn: mutationOptIn,
      requiredRunnerCapabilities: safeMethod ? REST_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES : restMutationRequiredRunnerCapabilities(normalizedMethod),
    }),
  })
}

function restRouteCoveragePlanItems(route: WordPressRestRouteDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem[] {
  const endpointItems = route.endpoints?.flatMap((endpoint, endpointIndex) => endpoint.methods.map((method) => restRouteCoveragePlanItem(route, method, options, endpoint, endpointIndex)))
  if (endpointItems?.length) {
    return endpointItems
  }
  return route.methods.map((method) => restRouteCoveragePlanItem(route, method, options))
}

function restRouteCoveragePlanItem(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint?: WordPressRestRouteEndpointDescriptor, endpointIndex?: number): FuzzCoveragePlanItem {
  const normalizedMethod = method.toUpperCase()
  const requiredArgs = endpoint?.args.filter((arg) => arg.required).map((arg) => arg.name) ?? []
  const safeMethod = SAFE_REST_METHODS.has(normalizedMethod)
  const mutationOptIn = safeMethod ? undefined : matchingRestMutationOptIn(route.route, normalizedMethod, options)
  const concreteInput = safeMethod ? concreteRestInput(route, normalizedMethod, options, endpoint) : concreteRestMutationInput(route, normalizedMethod, options, endpoint, mutationOptIn)
  const executable = concreteInput !== undefined
  const reason = executable ? undefined : restRouteUntestedReason(safeMethod, requiredArgs)
  const parameterGeneration = executable ? undefined : stripUndefined({
    hook: safeMethod ? REST_PARAMETER_GENERATION_HOOK.id : REST_MUTATING_OPT_IN_HOOK.id,
    requiredInputs: requiredArgs.length ? requiredArgs : undefined,
  })

  return stripUndefined({
    id: restRouteCaseId(route.route, normalizedMethod, endpointIndex),
    target: executable ? (safeMethod ? REST_REQUEST_TARGET : { kind: "runtime-action", id: "wordpress.rest-request", entrypoint: "wordpress.rest-request", label: "Rollback-isolated WordPress REST mutation" }) : PLANNED_REST_REQUEST_TARGET,
    description: `${normalizedMethod} ${route.route}`,
    input: concreteInput ? restInputForCase(concreteInput, !safeMethod) : undefined,
    reason,
    parameterGeneration,
    metadata: stripUndefined({
      source: "wordpress.rest-route-inventory",
      route: route.route,
      namespace: route.namespace,
      method: normalizedMethod,
      permission: endpoint?.permission,
      argNames: route.argNames,
      generatedParameters: concreteInput?.generatedParameters,
      observationCapture: captureMetadata(options),
      restMutationFixtureOptIn: mutationOptIn,
      requiredRunnerCapabilities: safeMethod ? REST_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES : restMutationRequiredRunnerCapabilities(normalizedMethod),
    }),
  })
}

interface ConcreteRestInput {
  method: string
  path: string
  params?: Record<string, unknown>
  headers?: Record<string, unknown>
  bodyJson?: unknown
  user?: string
  session?: string
  generatedParameters?: Record<string, unknown>
  fixturePlanRef?: string
  mutationFixtureOperation?: FuzzFixtureSeedOperation
}

function concreteRestInput(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint?: WordPressRestRouteEndpointDescriptor, payloadFamily: WordPressRestPayloadFamily = "valid-minimal"): ConcreteRestInput | undefined {
  const args = endpoint?.args ?? []
  const pathArgNames = restRoutePathArgNames(route.route)
  const concreteArgs = restConcretePayloadArgs(args, pathArgNames, payloadFamily)
  if (payloadFamily !== "valid-minimal" && concreteArgs.length === 0 && pathArgNames.length === 0) {
    return undefined
  }
  const pathSamples: Record<string, unknown> = {}
  const querySamples: Record<string, unknown> = {}
  let path = route.route

  for (const name of pathArgNames) {
    const arg = args.find((candidate) => candidate.name === name)
    const sample = restArgSample(arg, restRoutePathPattern(route.route, name), payloadFamily)
    if (sample === undefined || typeof sample === "object") {
      return undefined
    }
    pathSamples[name] = sample
    path = path.replace(restRoutePathTokenPattern(name), encodeURIComponent(String(sample)))
  }

  for (const arg of concreteArgs) {
    if ((payloadFamily === "valid-minimal" && !arg.required) || pathArgNames.includes(arg.name)) {
      continue
    }
    const sample = restArgSample(arg, undefined, payloadFamily)
    if (sample === undefined) {
      return undefined
    }
    querySamples[arg.name] = sample
  }

  const generatedParameters = stripUndefined({
    path: Object.keys(pathSamples).length ? pathSamples : undefined,
    params: Object.keys(querySamples).length ? querySamples : undefined,
  })

  return stripUndefined({
    method,
    path,
    params: Object.keys(querySamples).length ? querySamples : undefined,
    user: options.user,
    session: options.session,
    generatedParameters: Object.keys(generatedParameters).length ? generatedParameters : undefined,
  })
}

function concreteRestMutationInput(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint: WordPressRestRouteEndpointDescriptor | undefined, optIn: RestMutationFixtureOptInContract | undefined, payloadFamily?: WordPressRestPayloadFamily): ConcreteRestInput | undefined {
  if (!optIn && (!payloadFamily || !options.restGeneratedMutationResetPolicy)) return undefined
  if (!optIn) return concreteGeneratedRestMutationInput(route, method, options, endpoint, payloadFamily ?? "valid-minimal")
  const operation = optIn.fixturePlan?.operations.find((candidate) => candidate.kind === "mutation" && (candidate.method ?? "").toUpperCase() === method && (candidate.target === route.route || candidate.target !== undefined))
  if (!operation && !optIn.fixturePlanRef) return undefined
  const operationInput = operation?.input && typeof operation.input === "object" && !Array.isArray(operation.input) ? operation.input as Record<string, unknown> : undefined
  const path = typeof operation?.target === "string" ? operation.target : route.route
  return stripUndefined({
    method,
    path,
    headers: optIn.auth?.headers,
    params: recordValue(operationInput?.params),
    bodyJson: operationInput?.bodyJson ?? operationInput?.body_json ?? operationInput?.body ?? operation?.input,
    user: optIn.auth?.user,
    session: optIn.auth?.session,
    fixturePlanRef: optIn.fixturePlanRef ?? optIn.fixturePlan?.id,
    mutationFixtureOperation: operation,
  })
}

function concreteGeneratedRestMutationInput(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint: WordPressRestRouteEndpointDescriptor | undefined, payloadFamily: WordPressRestPayloadFamily): ConcreteRestInput | undefined {
  const baseInput = concreteRestInput(route, method, options, endpoint, payloadFamily)
  if (!baseInput) return undefined
  const args = endpoint?.args ?? []
  const pathArgNames = restRoutePathArgNames(route.route)
  const bodyArgs = restConcretePayloadArgs(args, pathArgNames, payloadFamily).filter((arg) => !pathArgNames.includes(arg.name))
  const bodyJson: Record<string, unknown> = {}
  for (const arg of bodyArgs) {
    const sample = restArgSample(arg, undefined, payloadFamily)
    if (sample !== undefined) {
      bodyJson[arg.name] = sample
    }
  }

  return stripUndefined({
    ...baseInput,
    params: undefined,
    bodyJson: Object.keys(bodyJson).length ? bodyJson : payloadFamily === "valid-minimal" ? {} : undefined,
  })
}

function restInputForCase(input: ConcreteRestInput, runtimeAction = false): Record<string, unknown> {
  return stripUndefined({ type: runtimeAction ? "rest_request" : undefined, method: input.method, path: input.path, params: input.params, headers: input.headers, bodyJson: input.bodyJson, user: input.user, session: input.session, restMutationFixture: input.fixturePlanRef, mutationFixtureOperation: input.mutationFixtureOperation })
}

function matchingRestMutationOptIn(route: string, method: string, options: WordPressInventoryFuzzSuiteOptions): RestMutationFixtureOptInContract | undefined {
  return options.restMutationOptIns?.find((optIn) => optIn.route === route && optIn.methods.map((candidate) => candidate.toUpperCase()).includes(method))
}

function restMutationRequiredRunnerCapabilities(method: string): typeof REST_MUTATION_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES {
  const normalizedMethod = method.toUpperCase()
  const artifactCapability = normalizedMethod === "DELETE" ? "delete-boundary-artifact" : "mutation-isolation-artifact"
  const methodCapability = normalizedMethod === "DELETE" ? "rest-mutation:delete:delete-boundary-artifact" : `rest-mutation:${normalizedMethod.toLowerCase()}:mutation-isolation-artifact`
  return { ...REST_MUTATION_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES, capabilities: [...REST_MUTATION_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES.capabilities, artifactCapability, methodCapability] }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function restRoutePathArgNames(route: string): string[] {
  return [...route.matchAll(/\(\?P<([^>]+)>[^)]+\)/g)].map((match) => match[1]).filter((name): name is string => Boolean(name))
}

function restRoutePathPattern(route: string, name: string): string | undefined {
  return route.match(restRoutePathTokenPattern(name))?.[1]
}

function restRoutePathTokenPattern(name: string): RegExp {
  return new RegExp(`\\(\\?P<${escapeRegExp(name)}>([^)]+)\\)`)
}

function restArgSample(arg: WordPressRestRouteArgDescriptor | undefined, pathPattern?: string, payloadFamily: WordPressRestPayloadFamily = "valid-minimal"): unknown {
  if (payloadFamily === "boundary-large-string") {
    if (restArgAcceptsType(arg, "string") || !arg?.type) {
      return "x".repeat(REST_LARGE_STRING_LENGTH)
    }
    return undefined
  }

  if (payloadFamily === "invalid-type") {
    return restInvalidTypeSample(arg)
  }

  if (payloadFamily === "nested-object") {
    return restNestedSample(arg)
  }

  if (payloadFamily === "null-empty") {
    return restNullEmptySample(arg)
  }

  if (payloadFamily === "enum-variant") {
    return arg?.enum?.length ? arg.enum[arg.enum.length - 1] : undefined
  }

  if (payloadFamily === "numeric-boundary") {
    return restNumericBoundarySample(arg)
  }

  if (payloadFamily === "boolean-flip") {
    return restArgAcceptsType(arg, "boolean") ? false : undefined
  }

  if (payloadFamily === "repeated-field") {
    const sample = restArgSample(arg, pathPattern, "valid-minimal")
    return sample === undefined ? undefined : Array.from({ length: REST_REPEATED_FIELD_COUNT }, () => sample)
  }

  if (arg?.enum?.length) {
    return arg.enum[0]
  }

  const type = Array.isArray(arg?.type) ? arg?.type.find((candidate) => candidate !== "null") : arg?.type
  if (type === "integer") {
    return 1
  }
  if (type === "number") {
    return 1
  }
  if (type === "boolean") {
    return true
  }
  if (type === "array") {
    return []
  }
  if (type === "object") {
    return {}
  }

  if (arg?.format === "date-time") {
    return "2000-01-01T00:00:00"
  }
  if (arg?.format === "date") {
    return "2000-01-01"
  }
  if (arg?.format === "email") {
    return "sample@example.com"
  }

  if (pathPattern && /\\d|\[0-9]|\[\\d]/.test(pathPattern)) {
    return 1
  }

  return "sample"
}

function restConcretePayloadArgs(args: readonly WordPressRestRouteArgDescriptor[], pathArgNames: readonly string[], payloadFamily: WordPressRestPayloadFamily): WordPressRestRouteArgDescriptor[] {
  if (payloadFamily === "valid-minimal") {
    return [...args]
  }

  const optionalArg = args.find((arg) => !arg.required && !pathArgNames.includes(arg.name) && restArgSample(arg, undefined, payloadFamily) !== undefined)
  const requiredArgs = args.filter((arg) => arg.required)
  return optionalArg ? [...requiredArgs, optionalArg] : []
}

function generatedRestPayloadFamilySkippable(payloadFamily: WordPressRestPayloadFamily): boolean {
  return payloadFamily !== "valid-minimal"
}

function restArgAcceptsType(arg: WordPressRestRouteArgDescriptor | undefined, type: string): boolean {
  if (!arg?.type) return true
  return Array.isArray(arg.type) ? arg.type.includes(type) : arg.type === type
}

function restInvalidTypeSample(arg: WordPressRestRouteArgDescriptor | undefined): unknown {
  if (arg?.enum?.length) return "__wp_codebox_invalid_enum__"
  const type = Array.isArray(arg?.type) ? arg?.type.find((candidate) => candidate !== "null") : arg?.type
  if (type === "integer" || type === "number") return "not-a-number"
  if (type === "boolean") return "not-a-boolean"
  if (type === "array") return "not-an-array"
  if (type === "object") return "not-an-object"
  return 12345
}

function restNestedSample(arg: WordPressRestRouteArgDescriptor | undefined): unknown {
  if (restArgAcceptsType(arg, "object")) return { nested: { value: "sample", list: ["sample", "sample-2"] } }
  if (restArgAcceptsType(arg, "array")) return [{ value: "sample" }, { value: "sample-2" }]
  return undefined
}

function restNullEmptySample(arg: WordPressRestRouteArgDescriptor | undefined): unknown {
  if (Array.isArray(arg?.type) && arg.type.includes("null")) return null
  if (restArgAcceptsType(arg, "string") || !arg?.type) return ""
  if (restArgAcceptsType(arg, "array")) return []
  if (restArgAcceptsType(arg, "object")) return {}
  return undefined
}

function restNumericBoundarySample(arg: WordPressRestRouteArgDescriptor | undefined): unknown {
  if (restArgAcceptsType(arg, "integer")) return 0
  if (restArgAcceptsType(arg, "number")) return Number.EPSILON
  return undefined
}

function restGeneratedMutationIntent(method: string): FuzzSuiteMutationIntent {
  if (method === "DELETE") {
    return { intent: "delete", destructive: true, intensity: "high", resetRequired: true }
  }
  return { intent: "write", destructive: false, intensity: "medium", resetRequired: true }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function restRouteUntestedReason(safeMethod: boolean, requiredArgs: string[]): FuzzCoveragePlanReason {
  if (safeMethod) {
    return stripUndefined({
      code: "route_requires_discovered_parameters",
      message: "The REST route requires concrete discovered parameters before it can be executed safely.",
      data: requiredArgs.length ? { requiredArgs } : undefined,
    })
  }
  return {
    code: "mutating_rest_method_requires_explicit_opt_in",
    message: "The REST route uses a mutating method and requires explicit opt-in with safe fixtures before execution.",
  }
}

function adminPageInventoryFuzzSuiteCases(inventory: WordPressAdminPageInventory, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase[] {
  const accessiblePages = inventory.pages.filter((page) => page.canAccess !== false)
  return [...accessiblePages.map((page) => adminPageFuzzSuiteCase(page, options)), ...accessiblePages.flatMap((page) => adminPageSupplementalFuzzSuiteCases(page, options))]
}

function adminPageSupplementalFuzzSuiteCases(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase[] {
  const interactions = adminPageInteractions(page)
  return [...interactions.map((interaction) => adminPageInteractionFuzzSuiteCase(page, interaction, options)), interactions.length ? undefined : adminPageActionDiscoveryFuzzSuiteCase(page, options)].filter((entry): entry is FuzzSuiteCase => Boolean(entry))
}

function adminPageFuzzSuiteCase(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase {
  const path = adminPagePath(page)
  const pageLoad = pageLoadFuzzMode("admin", options.pageLoadMode)
  return stripUndefined({
    id: `admin-page-${slugify(page.menuSlug)}`,
    target: pageLoad.target,
    description: page.pageTitle || page.menuTitle,
    input: {
      args: pageLoadArgs(path, pageLoad.surface, options),
    },
    metadata: stripUndefined({ source: "wordpress.admin-page-inventory", menuSlug: page.menuSlug, parentSlug: page.parentSlug, capability: page.capability, pageLoadMode: pageLoad.mode, safety: { executable: true, safeMethod: true } }),
  })
}

function adminPageInventoryCoveragePlanItems(inventory: WordPressAdminPageInventory, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem[] {
  const accessiblePages = inventory.pages.filter((page) => page.canAccess !== false)
  return [...inventory.pages.map((page) => adminPageCoveragePlanItem(page, options)), ...accessiblePages.flatMap((page) => adminPageSupplementalCoveragePlanItems(page, options))]
}

function adminPageSupplementalCoveragePlanItems(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem[] {
  const interactions = adminPageInteractions(page)
  return [...interactions.map((interaction) => adminPageInteractionCoveragePlanItem(page, interaction, options)), interactions.length ? undefined : adminPageActionDiscoveryCoveragePlanItem(page, options)].filter((entry): entry is FuzzCoveragePlanItem => Boolean(entry))
}

function adminPageCoveragePlanItem(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const path = adminPagePath(page)
  const pageLoad = pageLoadFuzzMode("admin", options.pageLoadMode)
  return stripUndefined({
    id: `admin-page-${slugify(page.menuSlug)}`,
    target: pageLoad.target,
    description: page.pageTitle || page.menuTitle,
    input: page.canAccess === false ? undefined : { args: pageLoadArgs(path, pageLoad.surface, options) },
    reason: page.canAccess === false ? { code: "admin_page_capability_denied", message: "The discovered admin page is not accessible to the current runtime user.", data: { capability: page.capability } } : undefined,
    metadata: stripUndefined({ source: "wordpress.admin-page-inventory", menuSlug: page.menuSlug, parentSlug: page.parentSlug, capability: page.capability, pageLoadMode: pageLoad.mode, observationCapture: captureMetadata(options) }),
  })
}

function adminPageInteractionFuzzSuiteCase(page: WordPressAdminPageDescriptor, interaction: WordPressAdminPageInteractionDescriptor & { kind: string; index: number }, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase {
  const path = adminPagePath(page)
  const pageLoad = pageLoadFuzzMode("admin", options.pageLoadMode)
  const mutates = adminInteractionMutates(interaction)
  return stripUndefined({
    id: `admin-page-${slugify(page.menuSlug)}-${slugify(interaction.kind)}-${slugify(adminInteractionId(interaction))}`,
    target: pageLoad.target,
    description: `${mutates ? "Plan" : "Exercise"} ${interaction.kind} on ${page.pageTitle || page.menuTitle}`,
    input: mutates ? undefined : { args: [...pageLoadArgs(path, pageLoad.surface, options), `interaction=${interaction.kind}`, `interactionId=${adminInteractionId(interaction)}`] },
    resetPolicy: mutates ? options.dbGeneratedMutationResetPolicy : undefined,
    mutation: mutates ? { intent: "write", destructive: false, intensity: "medium", resetRequired: true } : undefined,
    metadata: stripUndefined({ source: "wordpress.admin-page-inventory", menuSlug: page.menuSlug, path, interaction, capability: interaction.capability ?? page.capability, nonce: interaction.nonceAction ?? interaction.nonce_action, pageLoadMode: pageLoad.mode, safety: { executable: !mutates, mutates, reason: mutates ? "admin_interaction_requires_runtime_form_execution" : undefined }, requiredRunnerCapabilities: pageLoad.requiredRunnerCapabilities }),
  })
}

function adminPageInteractionCoveragePlanItem(page: WordPressAdminPageDescriptor, interaction: WordPressAdminPageInteractionDescriptor & { kind: string; index: number }, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const fuzzCase = adminPageInteractionFuzzSuiteCase(page, interaction, options)
  return stripUndefined({
    id: fuzzCase.id,
    target: fuzzCase.target,
    description: fuzzCase.description,
    input: fuzzCase.input,
    reason: fuzzCase.input ? undefined : { code: "admin_interaction_requires_runtime_form_execution", message: "The admin interaction metadata is discovered, but execution requires a runtime that can bind nonces, fields, and reset state." },
    metadata: stripUndefined({ ...fuzzCase.metadata, observationCapture: captureMetadata(options) }),
  })
}

function adminPageActionDiscoveryFuzzSuiteCase(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase {
  const path = adminPagePath(page)
  return stripUndefined({
    id: `admin-page-${slugify(page.menuSlug)}-discover-actions`,
    target: ADMIN_ACTION_DISCOVERY_TARGET,
    description: `Discover admin actions on ${page.pageTitle || page.menuTitle}`,
    input: { args: adminActionDiscoveryArgs(path, options) },
    metadata: stripUndefined({ source: "wordpress.admin-page-inventory", menuSlug: page.menuSlug, path, capability: page.capability, pageLoadMode: "browser", actionDiscovery: { mode: "browser-dom-snapshot", executesActions: false, artifactEvidence: ["html", "dom-snapshot", "screenshot"] }, safety: { executable: true, readOnly: true }, requiredRunnerCapabilities: ADMIN_ACTION_DISCOVERY_REQUIRED_RUNNER_CAPABILITIES }),
  })
}

function adminPageActionDiscoveryCoveragePlanItem(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const fuzzCase = adminPageActionDiscoveryFuzzSuiteCase(page, options)
  return stripUndefined({ id: fuzzCase.id, target: fuzzCase.target, description: fuzzCase.description, input: fuzzCase.input, metadata: stripUndefined({ ...fuzzCase.metadata, observationCapture: captureMetadata(options) }) })
}

function adminPageInteractions(page: WordPressAdminPageDescriptor): Array<WordPressAdminPageInteractionDescriptor & { kind: string; index: number }> {
  return [...tagAdminInteractions(page.forms, "form"), ...tagAdminInteractions(page.actions, "action")]
}

function tagAdminInteractions(interactions: WordPressAdminPageInteractionDescriptor[] | undefined, kind: string): Array<WordPressAdminPageInteractionDescriptor & { kind: string; index: number }> {
  return interactions?.map((interaction, index) => ({ ...interaction, kind: interaction.kind ?? kind, index })) ?? []
}

function adminInteractionId(interaction: WordPressAdminPageInteractionDescriptor & { kind: string; index: number }): string {
  return interaction.id ?? interaction.selector ?? interaction.action ?? `${interaction.kind}-${interaction.index + 1}`
}

function adminInteractionMutates(interaction: WordPressAdminPageInteractionDescriptor): boolean {
  const method = String(interaction.method ?? "GET").toUpperCase()
  return interaction.safety?.mutates === true || !["GET", "HEAD"].includes(method)
}

function frontendUrlFuzzSuiteCase(url: WordPressFrontendUrlDescriptor, homeUrl: string, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase {
  const path = frontendPath(url.url, homeUrl)
  const pageLoad = pageLoadFuzzMode("frontend", options.pageLoadMode)
  return stripUndefined({
    id: `frontend-url-${slugify(path)}`,
    target: pageLoad.target,
    description: `Load ${path}`,
    input: {
      args: pageLoadArgs(path, pageLoad.surface, options),
    },
    metadata: stripUndefined({ source: "wordpress.frontend-url-inventory", url: url.url, sourceKind: url.source, pattern: url.pattern, query: url.query, pageLoadMode: pageLoad.mode, safety: { executable: true, safeMethod: true } }),
  })
}

function frontendUrlCoveragePlanItem(url: WordPressFrontendUrlDescriptor, homeUrl: string, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const path = frontendPath(url.url, homeUrl)
  const pageLoad = pageLoadFuzzMode("frontend", options.pageLoadMode)
  return stripUndefined({
    id: `frontend-url-${slugify(path)}`,
    target: pageLoad.target,
    description: `Load ${path}`,
    input: { args: pageLoadArgs(path, pageLoad.surface, options) },
    metadata: stripUndefined({ source: "wordpress.frontend-url-inventory", url: url.url, sourceKind: url.source, pattern: url.pattern, query: url.query, pageLoadMode: pageLoad.mode, observationCapture: captureMetadata(options) }),
  })
}

function databaseTableFuzzSuiteCases(table: WordPressDatabaseTableDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase[] {
  return databaseTableOperationPlans(table).filter((plan) => plan.operation === "inspect" || plan.operation === "read" || Boolean(options.dbGeneratedMutationResetPolicy)).map((plan) => databaseTableFuzzSuiteCase(table, plan, options))
}

function databaseTableFuzzSuiteCase(table: WordPressDatabaseTableDescriptor, plan: DatabaseTableOperationPlan, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase {
  const mutates = plan.operation !== "inspect" && plan.operation !== "read"
  const executable = !mutates || Boolean(options.dbGeneratedMutationResetPolicy)
  return stripUndefined({
    id: `db-${slugify(plan.id ?? plan.operation)}-${slugify(table.baseName || table.name)}`,
    target: DB_OPERATION_TARGET,
    description: `${plan.label} ${table.baseName || table.name}`,
    input: executable ? { args: [`operation-json=${JSON.stringify(databaseOperation(table, plan))}`] } : undefined,
    resetPolicy: mutates ? options.dbGeneratedMutationResetPolicy : undefined,
    mutation: mutates ? { intent: plan.operation === "delete" ? "delete" : "write", destructive: plan.operation === "delete", intensity: plan.operation === "delete" ? "high" : "medium", resetRequired: true } : undefined,
    metadata: stripUndefined({ source: "wordpress-db-inventory", table: table.name, tableLabel: table.baseName || table.name, baseName: table.baseName, classification: table.classification, columnLabels: table.columns.map((column) => column.name), primaryKeyColumns: primaryKeyColumns(table), writable: tableWritable(table), operation: plan.operation, queryFamily: plan.id, seed: plan.seed, replay: plan.replay, safety: { executable, readOnly: !mutates, mutates, reason: executable ? undefined : "db_mutation_requires_reset_policy" } }),
  })
}

function databaseTableCoveragePlanItems(table: WordPressDatabaseTableDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem[] {
  return databaseTableOperationPlans(table).map((plan) => databaseTableCoveragePlanItem(table, plan, options))
}

function databaseTableCoveragePlanItem(table: WordPressDatabaseTableDescriptor, plan: DatabaseTableOperationPlan, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const executable = table.classification !== "external"
  const mutates = plan.operation !== "inspect" && plan.operation !== "read"
  const mutationExecutable = !mutates || Boolean(options.dbGeneratedMutationResetPolicy)
  return stripUndefined({
    id: `db-${slugify(plan.id ?? plan.operation)}-${slugify(table.baseName || table.name)}`,
    target: DB_OPERATION_TARGET,
    description: `${plan.label} ${table.baseName || table.name}`,
    input: executable && mutationExecutable ? { args: [`operation-json=${JSON.stringify(databaseOperation(table, plan))}`] } : undefined,
    reason: !executable ? { code: "external_table_not_fuzzed", message: "External database tables are excluded from generic WordPress DB fuzzing." } : !mutationExecutable ? { code: "db_mutation_requires_reset_policy", message: "Generated database mutations require an explicit reset policy before execution." } : undefined,
    metadata: stripUndefined({ source: "wordpress-db-inventory", table: table.name, tableLabel: table.baseName || table.name, baseName: table.baseName, classification: table.classification, columnLabels: table.columns.map((column) => column.name), operation: plan.operation, queryFamily: plan.id, seed: plan.seed, replay: plan.replay, observationCapture: missingCaptureMetadata() }),
  })
}

interface DatabaseTableOperationPlan {
  id?: string
  operation: "inspect" | "read" | "insert" | "update" | "delete"
  label: string
  seed?: Record<string, unknown>
  replay?: Record<string, unknown>
}

function databaseTableOperationPlans(table: WordPressDatabaseTableDescriptor): DatabaseTableOperationPlan[] {
  const safePlans: DatabaseTableOperationPlan[] = [{ operation: "inspect", label: "Inspect" }, { operation: "read", label: "Read" }]
  const keyColumn = primaryishColumn(table)
  if (keyColumn) {
    safePlans.push({ id: "read-keyed", operation: "read", label: "Read keyed", seed: { source: "wordpress-db-inventory", table: table.name, operation: "read", queryFamily: "read-keyed" }, replay: { source: "wordpress-db-inventory", table: table.name, operation: "read", queryFamily: "read-keyed", column: keyColumn.name } })
  }
  if (table.classification === "external" || !tableWritable(table) || !primaryishColumn(table) || !writableSampleColumn(table)) {
    return safePlans
  }
  return [...safePlans, ...["insert", "update", "delete"].map((operation) => ({ operation: operation as DatabaseTableOperationPlan["operation"], label: operation[0]?.toUpperCase() + operation.slice(1), seed: { source: "wordpress-db-inventory", table: table.name, operation }, replay: { source: "wordpress-db-inventory", table: table.name, operation, primaryKeyColumns: primaryKeyColumns(table) } }))]
}

function databaseOperation(table: WordPressDatabaseTableDescriptor, plan: DatabaseTableOperationPlan) {
  const tableRef = table.baseName || table.name
  const keyColumn = primaryishColumn(table)
  const writableColumn = writableSampleColumn(table)
  if (plan.operation === "read") {
    if (plan.id === "read-keyed" && keyColumn) {
      return normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: "read", query: { table: tableRef, columns: readableColumns(table), where: { [keyColumn.name]: sampleDbValue(keyColumn) }, limit: 1 }, metadata: dbOperationMetadata(table, plan) })
    }
    return normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: "read", query: { table: tableRef, columns: readableColumns(table), limit: 1 }, metadata: dbOperationMetadata(table, plan) })
  }
  if (plan.operation === "insert") {
    return normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: "write", query: { table: tableRef, values: writableColumn ? { [writableColumn.name]: sampleDbValue(writableColumn) } : undefined }, options: { mutation: "insert", bounded: true }, metadata: dbOperationMetadata(table, plan) })
  }
  if (plan.operation === "update") {
    return normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: "write", query: { table: tableRef, where: keyColumn ? { [keyColumn.name]: sampleDbValue(keyColumn) } : undefined, values: writableColumn ? { [writableColumn.name]: sampleDbValue(writableColumn) } : undefined, limit: 1 }, options: { mutation: "update", bounded: true }, metadata: dbOperationMetadata(table, plan) })
  }
  if (plan.operation === "delete") {
    return normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: "write", query: { table: tableRef, where: keyColumn ? { [keyColumn.name]: sampleDbValue(keyColumn) } : undefined, limit: 1 }, options: { mutation: "delete", bounded: true }, metadata: dbOperationMetadata(table, plan) })
  }
  return normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: "inspect", resource: { table: tableRef }, metadata: dbOperationMetadata(table, plan) })
}

function dbOperationMetadata(table: WordPressDatabaseTableDescriptor, plan: DatabaseTableOperationPlan): Record<string, unknown> {
  return { source: "wordpress-db-inventory", table: table.name, tableLabel: table.baseName || table.name, classification: table.classification, operation: plan.operation, queryFamily: plan.id, primaryKeyColumns: primaryKeyColumns(table), columnLabels: table.columns.map((column) => column.name) }
}

function tableWritable(table: WordPressDatabaseTableDescriptor): boolean {
  return table.writable !== false && table.classification !== "external"
}

function primaryKeyColumns(table: WordPressDatabaseTableDescriptor): string[] {
  return table.primaryKeyColumns ?? table.primary_key_columns ?? table.indexes?.filter((index) => index.name === "PRIMARY" || index.unique).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((index) => index.column) ?? table.columns.filter((column) => column.key === "PRI").map((column) => column.name)
}

function primaryishColumn(table: WordPressDatabaseTableDescriptor): WordPressDatabaseColumnDescriptor | undefined {
  const primaryNames = primaryKeyColumns(table)
  return table.columns.find((column) => primaryNames.includes(column.name)) ?? table.columns.find((column) => column.key === "PRI" || column.key === "UNI")
}

function writableSampleColumn(table: WordPressDatabaseTableDescriptor): WordPressDatabaseColumnDescriptor | undefined {
  return table.columns.find((column) => !/auto_increment/i.test(column.extra) && column.key !== "PRI") ?? table.columns.find((column) => !/auto_increment/i.test(column.extra))
}

function readableColumns(table: WordPressDatabaseTableDescriptor): string[] {
  return table.columns.slice(0, 5).map((column) => column.name)
}

function sampleDbValue(column: WordPressDatabaseColumnDescriptor): string | number | boolean | null {
  const type = column.type.toLowerCase()
  if (type.includes("int") || type.includes("decimal") || type.includes("float") || type.includes("double")) return 1
  if (type.includes("bool")) return true
  if (type.includes("date") || type.includes("time")) return "2000-01-01 00:00:00"
  return "wp-codebox-fuzz-sample"
}

function pageLoadFuzzMode(surface: "admin" | "frontend", mode: WordPressPageLoadFuzzMode = "simulated") {
  if (mode === "server") {
    return { mode, surface, target: { kind: "runtime", id: "wordpress.server-page-load", entrypoint: "wordpress.server-page-load", label: "WordPress server page load", metadata: { pageLoadMode: mode, surface } }, requiredRunnerCapabilities: { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.server-page-load"] } }
  }
  if (mode === "browser") {
    return { mode, surface, target: { kind: "runtime", id: "wordpress.browser-page-load", entrypoint: "wordpress.browser-page-load", label: "WordPress browser page load", metadata: { pageLoadMode: mode, surface } }, requiredRunnerCapabilities: { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.browser-page-load"] } }
  }
  return surface === "admin"
    ? { mode, surface, target: ADMIN_PAGE_LOAD_TARGET, requiredRunnerCapabilities: ADMIN_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES }
    : { mode, surface, target: FRONTEND_PAGE_LOAD_TARGET, requiredRunnerCapabilities: FRONTEND_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES }
}

function pageLoadArgs(path: string, surface: "admin" | "frontend", options: WordPressInventoryFuzzSuiteOptions): string[] {
  return [`path=${path}`, options.pageLoadMode === "server" || options.pageLoadMode === "browser" ? `surface=${surface}` : undefined, optionalArg("user", options.user), optionalArg("session", options.session)].filter((arg): arg is string => Boolean(arg))
}

function adminActionDiscoveryArgs(path: string, options: WordPressInventoryFuzzSuiteOptions): string[] {
  return [
    `url=/wp-admin/${path.replace(/^\/+/, "")}`,
    "auth=wordpress-admin",
    numericString(options.user) ? `auth-user-id=${options.user}` : undefined,
    "capture=steps,html,screenshot,dom-snapshot",
    "max-dom-snapshot-elements=500",
  ].filter((arg): arg is string => Boolean(arg))
}

function numericString(value: string | undefined): boolean {
  return typeof value === "string" && /^\d+$/.test(value)
}

function adminPagePath(page: WordPressAdminPageDescriptor): string {
  if (page.menuSlug.endsWith(".php")) {
    return page.menuSlug
  }
  return `admin.php?page=${encodeURIComponent(page.menuSlug)}`
}

function frontendPath(url: string, homeUrl: string): string {
  try {
    const parsed = new URL(url, homeUrl)
    const base = new URL(homeUrl)
    if (parsed.origin === base.origin) {
      return `${parsed.pathname || "/"}${parsed.search}`
    }
  } catch {
    // Fall through to preserving the discovered value.
  }
  return url || "/"
}

function optionalArg(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${name}=${value}`
}

function captureMetadata(options: WordPressInventoryFuzzSuiteOptions): Record<string, unknown> {
  return options.capture?.length
    ? { status: "requested-not-captured", requested: [...options.capture], supported: false, reason: "coverage-plan-generation-does-not-capture-runtime-observations" }
    : missingCaptureMetadata()
}

function missingCaptureMetadata(): Record<string, unknown> {
  return { status: "not-requested", supported: false, reason: "coverage-plan-generation-does-not-capture-runtime-observations" }
}

function restRouteCaseId(route: string, method: string, endpointIndex?: number): string {
  return `rest-${slugify(method)}-${slugify(route)}${endpointIndex === undefined ? "" : `-${endpointIndex}`}`
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"
}
