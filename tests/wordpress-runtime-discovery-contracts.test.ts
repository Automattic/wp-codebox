import assert from "node:assert/strict"

import {
  WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  type WordPressAdminPageInventory,
  type WordPressFrontendUrlInventory,
  type WordPressRestRouteInventory,
  type WordPressRuntimeDiscoveryResult,
} from "../packages/runtime-core/src/index.js"
import { runtimeContractManifest } from "../packages/runtime-core/src/public.js"
import { getCommandDefinition, runtimeCommandDefinitions } from "../packages/runtime-core/src/command-registry.js"
import { runtimeDiscoverySurfacesFromArgs } from "../packages/runtime-playground/src/runtime-discovery-command-handlers.js"

const result: WordPressRuntimeDiscoveryResult = {
  schema: WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  command: "wordpress.runtime-discovery",
  status: "ok",
  surfaces: ["rest", "admin", "database", "frontend", "blocks"],
  diagnostics: [],
}

assert.equal(result.schema, "wp-codebox/wordpress-runtime-discovery/v1")
assert.deepEqual(runtimeDiscoverySurfacesFromArgs([]), ["rest", "admin", "database", "frontend", "blocks"])
assert.deepEqual(runtimeDiscoverySurfacesFromArgs(["surface=rest,blocks,rest"]), ["rest", "blocks"])
assert.throws(() => runtimeDiscoverySurfacesFromArgs(["surface=woocommerce"]), /unsupported: woocommerce/)

const definition = getCommandDefinition("wordpress.runtime-discovery")
assert.equal(definition?.handler.kind, "playground")
assert.equal(definition?.handler.kind === "playground" ? definition.handler.method : undefined, "runRuntimeDiscovery")
assert.equal(definition?.outputSchema?.id, WORDPRESS_RUNTIME_DISCOVERY_SCHEMA)
assert.equal(runtimeCommandDefinitions().some((command) => command.id === "wordpress.runtime-discovery"), true)

const restInventory: WordPressRestRouteInventory = {
  schema: WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  command: "wordpress.rest-route-inventory",
  status: "ok",
  routes: [],
  namespaces: [],
  diagnostics: [],
}
const adminInventory: WordPressAdminPageInventory = {
  schema: WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  command: "wordpress.admin-page-inventory",
  status: "unsupported",
  adminUrl: "https://example.com/wp-admin/",
  menuLoaded: false,
  pages: [],
  diagnostics: [],
}
const frontendInventory: WordPressFrontendUrlInventory = {
  schema: WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  command: "wordpress.frontend-url-inventory",
  status: "ok",
  homeUrl: "https://example.com/",
  permalinkStructure: "/%postname%/",
  urls: [{ url: "https://example.com/", source: "home" }],
  rewriteRules: [],
  publicQueryVars: [],
  diagnostics: [],
}

assert.equal(restInventory.schema, "wp-codebox/wordpress-rest-route-inventory/v1")
assert.equal(adminInventory.schema, "wp-codebox/wordpress-admin-page-inventory/v1")
assert.equal(frontendInventory.schema, "wp-codebox/wordpress-frontend-url-inventory/v1")

const inventoryDefinitions = [
  ["wordpress.rest-route-inventory", "runRestRouteInventory", WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA],
  ["wordpress.admin-page-inventory", "runAdminPageInventory", WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA],
  ["wordpress.frontend-url-inventory", "runFrontendUrlInventory", WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA],
] as const

for (const [command, method, schema] of inventoryDefinitions) {
  const inventoryDefinition = getCommandDefinition(command)
  assert.equal(inventoryDefinition?.handler.kind, "playground")
  assert.equal(inventoryDefinition?.handler.kind === "playground" ? inventoryDefinition.handler.method : undefined, method)
  assert.equal(inventoryDefinition?.outputSchema?.id, schema)
  assert.equal(runtimeCommandDefinitions().some((definition) => definition.id === command), true)
}

assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.restRouteInventory, WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.adminPageInventory, WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.frontendUrlInventory, WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA)

console.log("wordpress runtime discovery contracts ok")
