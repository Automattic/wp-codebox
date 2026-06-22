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

export function restRouteInventoryToFuzzSuite(inventory: WordPressRestRouteInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-rest-route-inventory-fuzz-suite",
    version: options.version,
    target: REST_REQUEST_TARGET,
    cases: inventory.routes.flatMap((route) => restRouteFuzzSuiteCases(route, options)),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status }),
  })
}

export function adminPageInventoryToFuzzSuite(inventory: WordPressAdminPageInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-admin-page-inventory-fuzz-suite",
    version: options.version,
    target: ADMIN_PAGE_LOAD_TARGET,
    cases: inventory.pages.map((page) => adminPageFuzzSuiteCase(page, options)),
    metadata: stripUndefined({ ...options.metadata, sourceSchema: inventory.schema, sourceCommand: inventory.command, inventoryStatus: inventory.status, adminUrl: inventory.adminUrl, menuLoaded: inventory.menuLoaded }),
  })
}

export function frontendUrlInventoryToFuzzSuite(inventory: WordPressFrontendUrlInventory, options: WordPressInventoryFuzzSuiteOptions = {}): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: options.id ?? "wordpress-frontend-url-inventory-fuzz-suite",
    version: options.version,
    target: FRONTEND_PAGE_LOAD_TARGET,
    cases: inventory.urls.map((url) => frontendUrlFuzzSuiteCase(url, inventory.homeUrl, options)),
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

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root"
}
