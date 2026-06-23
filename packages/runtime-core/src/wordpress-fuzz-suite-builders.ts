import { fuzzCoveragePlanContract, type FuzzCoveragePlanContract, type FuzzCoveragePlanItem, type FuzzCoveragePlanParameterGenerationHook, type FuzzCoveragePlanReason } from "./fuzz-coverage-plan-contracts.js"
import { fuzzSuiteContract, type FuzzSuiteCase, type FuzzSuiteContract, type FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js"
import { stripUndefined } from "./object-utils.js"
import type { WordPressAdminPageDescriptor, WordPressAdminPageInventory, WordPressFrontendUrlDescriptor, WordPressFrontendUrlInventory, WordPressRestRouteDescriptor, WordPressRestRouteEndpointDescriptor, WordPressRestRouteInventory } from "./wordpress-runtime-discovery-contracts.js"

export interface WordPressInventoryFuzzSuiteOptions {
  id?: string
  version?: string
  metadata?: Record<string, unknown>
  user?: string
  session?: string
}

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
  id: "wordpress.admin-page-load",
  entrypoint: "wordpress.admin-page-load",
  label: "WordPress admin page load",
}

const FRONTEND_PAGE_LOAD_TARGET: FuzzSuiteTargetRef = {
  kind: "runtime",
  id: "wordpress.frontend-page-load",
  entrypoint: "wordpress.frontend-page-load",
  label: "WordPress frontend page load",
}

const REST_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:rest"],
  targetKinds: ["rest"],
}

const ADMIN_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:runtime", "runtime"],
  targetKinds: ["runtime"],
  commands: ["wordpress.admin-page-load"],
}

const FRONTEND_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES = {
  capabilities: ["target:runtime", "runtime"],
  targetKinds: ["runtime"],
  commands: ["wordpress.frontend-page-load"],
}

const REST_PARAMETER_GENERATION_HOOK: FuzzCoveragePlanParameterGenerationHook = {
  id: "wordpress.rest-route-parameters",
  label: "WordPress REST route parameter generator",
  description: "Placeholder hook for consumers that can generate concrete REST path/query/body parameters from discovered route args.",
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
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, requiredRunnerCapabilities: REST_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES }),
  })
}

export function adminPageInventoryToFuzzSuite(inventory: WordPressAdminPageInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-admin-page-inventory-fuzz-suite",
    version: options.version,
    target: ADMIN_PAGE_LOAD_TARGET,
    cases: inventory.pages.map((page) => adminPageFuzzSuiteCase(page, options)),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, adminUrl: inventory.adminUrl, menuLoaded: inventory.menuLoaded, requiredRunnerCapabilities: ADMIN_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES }),
  })
}

export function frontendUrlInventoryToFuzzSuite(inventory: WordPressFrontendUrlInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-frontend-url-inventory-fuzz-suite",
    version: options.version,
    target: FRONTEND_PAGE_LOAD_TARGET,
    cases: inventory.urls.map((url) => frontendUrlFuzzSuiteCase(url, inventory.homeUrl, options)),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, homeUrl: inventory.homeUrl, permalinkStructure: inventory.permalinkStructure, requiredRunnerCapabilities: FRONTEND_PAGE_FUZZ_SUITE_REQUIRED_RUNNER_CAPABILITIES }),
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
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, adminUrl: inventory.adminUrl, menuLoaded: inventory.menuLoaded }),
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
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, homeUrl: inventory.homeUrl, permalinkStructure: inventory.permalinkStructure }),
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
  const concreteRoute = !route.route.includes("(?P<") && requiredArgs.length === 0
  const safeMethod = SAFE_REST_METHODS.has(normalizedMethod)
  const executable = safeMethod && concreteRoute
  const safety = stripUndefined({
    executable,
    safeMethod,
    planned: !executable,
    reason: executable ? undefined : safeMethod ? "route_requires_discovered_parameters" : "mutating_rest_method_requires_explicit_opt_in",
    requiredArgs: requiredArgs.length ? requiredArgs : undefined,
  })

  return stripUndefined({
    id: `rest-${slugify(normalizedMethod)}-${slugify(route.route)}${endpointIndex === undefined ? "" : `-${endpointIndex}`}`,
    target: executable ? REST_REQUEST_TARGET : PLANNED_REST_REQUEST_TARGET,
    description: `${normalizedMethod} ${route.route}`,
    input: executable ? stripUndefined({ method: normalizedMethod, path: route.route, user: options.user, session: options.session }) : undefined,
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
  const concreteRoute = !route.route.includes("(?P<") && requiredArgs.length === 0
  const safeMethod = SAFE_REST_METHODS.has(normalizedMethod)
  const executable = safeMethod && concreteRoute
  const reason = executable ? undefined : restRouteUntestedReason(safeMethod, requiredArgs)
  const parameterGeneration = executable ? undefined : stripUndefined({
    hook: safeMethod ? REST_PARAMETER_GENERATION_HOOK.id : REST_MUTATING_OPT_IN_HOOK.id,
    requiredInputs: requiredArgs.length ? requiredArgs : undefined,
  })

  return stripUndefined({
    id: restRouteCaseId(route.route, normalizedMethod, endpointIndex),
    target: executable ? REST_REQUEST_TARGET : PLANNED_REST_REQUEST_TARGET,
    description: `${normalizedMethod} ${route.route}`,
    input: executable ? stripUndefined({ method: normalizedMethod, path: route.route, user: options.user, session: options.session }) : undefined,
    reason,
    parameterGeneration,
    metadata: stripUndefined({
      source: "wordpress.rest-route-inventory",
      route: route.route,
      namespace: route.namespace,
      method: normalizedMethod,
      permission: endpoint?.permission,
      argNames: route.argNames,
    }),
  })
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
  return stripUndefined({
    id: `admin-page-${slugify(page.menuSlug)}`,
    target: ADMIN_PAGE_LOAD_TARGET,
    description: page.pageTitle || page.menuTitle,
    input: {
      args: [`path=${path}`, optionalArg("user", options.user), optionalArg("session", options.session)].filter((arg): arg is string => Boolean(arg)),
    },
    metadata: stripUndefined({ source: "wordpress.admin-page-inventory", menuSlug: page.menuSlug, parentSlug: page.parentSlug, capability: page.capability, safety: { executable: true, safeMethod: true } }),
  })
}

function adminPageCoveragePlanItem(page: WordPressAdminPageDescriptor, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const path = adminPagePath(page)
  return stripUndefined({
    id: `admin-page-${slugify(page.menuSlug)}`,
    target: ADMIN_PAGE_LOAD_TARGET,
    description: page.pageTitle || page.menuTitle,
    input: page.canAccess === false ? undefined : { args: [`path=${path}`, optionalArg("user", options.user), optionalArg("session", options.session)].filter((arg): arg is string => Boolean(arg)) },
    reason: page.canAccess === false ? { code: "admin_page_capability_denied", message: "The discovered admin page is not accessible to the current runtime user.", data: { capability: page.capability } } : undefined,
    metadata: stripUndefined({ source: "wordpress.admin-page-inventory", menuSlug: page.menuSlug, parentSlug: page.parentSlug, capability: page.capability }),
  })
}

function frontendUrlFuzzSuiteCase(url: WordPressFrontendUrlDescriptor, homeUrl: string, options: WordPressInventoryFuzzSuiteOptions): FuzzSuiteCase {
  const path = frontendPath(url.url, homeUrl)
  return stripUndefined({
    id: `frontend-url-${slugify(path)}`,
    target: FRONTEND_PAGE_LOAD_TARGET,
    description: `Load ${path}`,
    input: {
      args: [`path=${path}`, optionalArg("user", options.user), optionalArg("session", options.session)].filter((arg): arg is string => Boolean(arg)),
    },
    metadata: stripUndefined({ source: "wordpress.frontend-url-inventory", url: url.url, sourceKind: url.source, pattern: url.pattern, query: url.query, safety: { executable: true, safeMethod: true } }),
  })
}

function frontendUrlCoveragePlanItem(url: WordPressFrontendUrlDescriptor, homeUrl: string, options: WordPressInventoryFuzzSuiteOptions): FuzzCoveragePlanItem {
  const path = frontendPath(url.url, homeUrl)
  return stripUndefined({
    id: `frontend-url-${slugify(path)}`,
    target: FRONTEND_PAGE_LOAD_TARGET,
    description: `Load ${path}`,
    input: { args: [`path=${path}`, optionalArg("user", options.user), optionalArg("session", options.session)].filter((arg): arg is string => Boolean(arg)) },
    metadata: stripUndefined({ source: "wordpress.frontend-url-inventory", url: url.url, sourceKind: url.source, pattern: url.pattern, query: url.query }),
  })
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
