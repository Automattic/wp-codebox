import { fuzzCoveragePlanContract, type FuzzCoveragePlanContract, type FuzzCoveragePlanItem, type FuzzCoveragePlanParameterGenerationHook, type FuzzCoveragePlanReason } from "./fuzz-coverage-plan-contracts.js"
import { fuzzSuiteContract, type FuzzSuiteCase, type FuzzSuiteContract, type FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js"
import { stripUndefined } from "./object-utils.js"
import { WORDPRESS_DB_OPERATION_SCHEMA, normalizeWordPressDbOperation } from "./wordpress-db-contracts.js"
import type { WordPressAdminPageDescriptor, WordPressAdminPageInventory, WordPressDatabaseInventory, WordPressDatabaseTableDescriptor, WordPressFrontendUrlDescriptor, WordPressFrontendUrlInventory, WordPressRestRouteArgDescriptor, WordPressRestRouteDescriptor, WordPressRestRouteEndpointDescriptor, WordPressRestRouteInventory } from "./wordpress-runtime-discovery-contracts.js"

export interface WordPressInventoryFuzzSuiteOptions {
  id?: string
  version?: string
  metadata?: Record<string, unknown>
  user?: string
  session?: string
  pageLoadMode?: WordPressPageLoadFuzzMode
}

export type WordPressPageLoadFuzzMode = "simulated" | "server" | "browser"

const SAFE_REST_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

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

const REST_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:rest"],
  targetKinds: ["rest"],
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
    cases: inventory.pages.map((page) => adminPageFuzzSuiteCase(page, options)),
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
    cases: inventory.tables.filter((table) => table.classification !== "external").map((table) => databaseTableFuzzSuiteCase(table)),
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
  const discovered = inventory.pages.map((page) => adminPageCoveragePlanItem(page, options))
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
  const discovered = inventory.tables.map((table) => databaseTableCoveragePlanItem(table))
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
  const endpointCases = route.endpoints?.flatMap((endpoint, endpointIndex) => endpoint.methods.map((method) => restRouteFuzzSuiteCase(route, method, options, endpoint, endpointIndex)))
  if (endpointCases?.length) {
    return endpointCases
  }
  return route.methods.map((method) => restRouteFuzzSuiteCase(route, method, options))
}

function restRouteFuzzSuiteCase(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint?: WordPressRestRouteEndpointDescriptor, endpointIndex?: number): FuzzSuiteCase {
  const normalizedMethod = method.toUpperCase()
  const requiredArgs = endpoint?.args.filter((arg) => arg.required).map((arg) => arg.name) ?? []
  const safeMethod = SAFE_REST_METHODS.has(normalizedMethod)
  const concreteInput = safeMethod ? concreteRestInput(route, normalizedMethod, options, endpoint) : undefined
  const executable = concreteInput !== undefined
  const safety = stripUndefined({
    executable,
    safeMethod,
    planned: !executable,
    reason: executable ? undefined : safeMethod ? "route_requires_discovered_parameters" : "mutating_rest_method_requires_explicit_opt_in",
    requiredArgs: requiredArgs.length ? requiredArgs : undefined,
    generatedParameters: concreteInput?.generatedParameters,
  })

  return stripUndefined({
    id: `rest-${slugify(normalizedMethod)}-${slugify(route.route)}${endpointIndex === undefined ? "" : `-${endpointIndex}`}`,
    target: executable ? REST_REQUEST_TARGET : PLANNED_REST_REQUEST_TARGET,
    description: `${normalizedMethod} ${route.route}`,
    input: concreteInput ? restInputForCase(concreteInput) : undefined,
    metadata: stripUndefined({
      source: "wordpress.rest-route-inventory",
      route: route.route,
      namespace: route.namespace,
      method: normalizedMethod,
      permission: endpoint?.permission,
      argNames: route.argNames,
      safety,
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
  const concreteInput = safeMethod ? concreteRestInput(route, normalizedMethod, options, endpoint) : undefined
  const executable = concreteInput !== undefined
  const reason = executable ? undefined : restRouteUntestedReason(safeMethod, requiredArgs)
  const parameterGeneration = executable ? undefined : stripUndefined({
    hook: safeMethod ? REST_PARAMETER_GENERATION_HOOK.id : REST_MUTATING_OPT_IN_HOOK.id,
    requiredInputs: requiredArgs.length ? requiredArgs : undefined,
  })

  return stripUndefined({
    id: restRouteCaseId(route.route, normalizedMethod, endpointIndex),
    target: executable ? REST_REQUEST_TARGET : PLANNED_REST_REQUEST_TARGET,
    description: `${normalizedMethod} ${route.route}`,
    input: concreteInput ? restInputForCase(concreteInput) : undefined,
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
    }),
  })
}

interface ConcreteRestInput {
  method: string
  path: string
  params?: Record<string, unknown>
  user?: string
  session?: string
  generatedParameters?: Record<string, unknown>
}

function concreteRestInput(route: WordPressRestRouteDescriptor, method: string, options: WordPressInventoryFuzzSuiteOptions, endpoint?: WordPressRestRouteEndpointDescriptor): ConcreteRestInput | undefined {
  const args = endpoint?.args ?? []
  const pathArgNames = restRoutePathArgNames(route.route)
  const pathSamples: Record<string, unknown> = {}
  const querySamples: Record<string, unknown> = {}
  let path = route.route

  for (const name of pathArgNames) {
    const arg = args.find((candidate) => candidate.name === name)
    const sample = restArgSample(arg, restRoutePathPattern(route.route, name))
    if (sample === undefined || typeof sample === "object") {
      return undefined
    }
    pathSamples[name] = sample
    path = path.replace(restRoutePathTokenPattern(name), encodeURIComponent(String(sample)))
  }

  for (const arg of args) {
    if (!arg.required || pathArgNames.includes(arg.name)) {
      continue
    }
    const sample = restArgSample(arg)
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

function restInputForCase(input: ConcreteRestInput): Record<string, unknown> {
  return stripUndefined({ method: input.method, path: input.path, params: input.params, user: input.user, session: input.session })
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

function restArgSample(arg: WordPressRestRouteArgDescriptor | undefined, pathPattern?: string): unknown {
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

function adminPageCoveragePlanItem(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const path = adminPagePath(page)
  const pageLoad = pageLoadFuzzMode("admin", options.pageLoadMode)
  return stripUndefined({
    id: `admin-page-${slugify(page.menuSlug)}`,
    target: pageLoad.target,
    description: page.pageTitle || page.menuTitle,
    input: page.canAccess === false ? undefined : { args: pageLoadArgs(path, pageLoad.surface, options) },
    reason: page.canAccess === false ? { code: "admin_page_capability_denied", message: "The discovered admin page is not accessible to the current runtime user.", data: { capability: page.capability } } : undefined,
    metadata: stripUndefined({ source: "wordpress.admin-page-inventory", menuSlug: page.menuSlug, parentSlug: page.parentSlug, capability: page.capability, pageLoadMode: pageLoad.mode }),
  })
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
    metadata: stripUndefined({ source: "wordpress.frontend-url-inventory", url: url.url, sourceKind: url.source, pattern: url.pattern, query: url.query, pageLoadMode: pageLoad.mode }),
  })
}

function databaseTableFuzzSuiteCase(table: WordPressDatabaseTableDescriptor): FuzzSuiteCase {
  return stripUndefined({
    id: `db-inspect-${slugify(table.baseName || table.name)}`,
    target: DB_OPERATION_TARGET,
    description: `Inspect ${table.baseName || table.name}`,
    input: { args: [`operation-json=${JSON.stringify(databaseInspectOperation(table))}`] },
    metadata: stripUndefined({ source: "wordpress-db-inventory", table: table.name, baseName: table.baseName, classification: table.classification, safety: { executable: true, readOnly: true } }),
  })
}

function databaseTableCoveragePlanItem(table: WordPressDatabaseTableDescriptor): FuzzCoveragePlanItem {
  const executable = table.classification !== "external"
  return stripUndefined({
    id: `db-inspect-${slugify(table.baseName || table.name)}`,
    target: DB_OPERATION_TARGET,
    description: `Inspect ${table.baseName || table.name}`,
    input: executable ? { args: [`operation-json=${JSON.stringify(databaseInspectOperation(table))}`] } : undefined,
    reason: executable ? undefined : { code: "external_table_not_fuzzed", message: "External database tables are excluded from generic WordPress DB fuzzing." },
    metadata: stripUndefined({ source: "wordpress-db-inventory", table: table.name, baseName: table.baseName, classification: table.classification }),
  })
}

function databaseInspectOperation(table: WordPressDatabaseTableDescriptor) {
  return normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: "inspect", resource: { table: table.baseName || table.name }, metadata: { source: "wordpress-db-inventory", table: table.name, classification: table.classification } })
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

function restRouteCaseId(route: string, method: string, endpointIndex?: number): string {
  return `rest-${slugify(method)}-${slugify(route)}${endpointIndex === undefined ? "" : `-${endpointIndex}`}`
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"
}
