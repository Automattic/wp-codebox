import assert from "node:assert/strict"

import {
  WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  adminPageInventoryToFuzzSuite,
  adminPageInventoryToCoveragePlan,
  frontendUrlInventoryToFuzzSuite,
  frontendUrlInventoryToCoveragePlan,
  restRouteInventoryToFuzzSuite,
  restRouteInventoryToCoveragePlan,
  type WordPressAdminPageInventory,
  type WordPressFrontendUrlInventory,
  type WordPressRestRouteInventory,
} from "../packages/runtime-core/src/public.js"

const restInventory: WordPressRestRouteInventory = {
  schema: WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  command: "wordpress.rest-route-inventory",
  status: "ok",
  routes: [
    { route: "/wp/v2/posts", namespace: "wp/v2", methods: ["GET", "POST"], argNames: [], endpoints: [{ methods: ["GET", "POST"], permission: { mode: "public" }, args: [] }] },
    { route: "/wp/v2/posts/(?P<id>[\\d]+)", namespace: "wp/v2", methods: ["GET"], argNames: ["id"], endpoints: [{ methods: ["GET"], permission: { mode: "callback", callbackType: "method" }, args: [{ name: "id", required: true, type: "integer" }] }] },
  ],
  namespaces: ["wp/v2"],
  diagnostics: [],
}

const restSuite = restRouteInventoryToFuzzSuite(restInventory, { session: "admin" })
assert.equal(restSuite.schema, "wp-codebox/fuzz-suite/v1")
assert.equal(restSuite.metadata?.sourceSchema, WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA)
assert.deepEqual(restSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:rest"], targetKinds: ["rest"] })
assert.equal(restSuite.cases.length, 3)
assert.equal(restSuite.cases[0]?.target?.kind, "rest")
assert.deepEqual(restSuite.cases[0]?.input, { method: "GET", path: "/wp/v2/posts", session: "admin" })
assert.equal((restSuite.cases[0]?.metadata?.safety as Record<string, unknown>).executable, true)
assert.equal(restSuite.cases[1]?.target?.kind, "rest-planned")
assert.equal((restSuite.cases[1]?.metadata?.safety as Record<string, unknown>).reason, "mutating_rest_method_requires_explicit_opt_in")
assert.equal(restSuite.cases[2]?.target?.kind, "rest-planned")
assert.deepEqual((restSuite.cases[2]?.metadata?.safety as Record<string, unknown>).requiredArgs, ["id"])

const restCoveragePlan = restRouteInventoryToCoveragePlan(restInventory, { session: "admin" })
assert.equal(restCoveragePlan.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.deepEqual(restCoveragePlan.summary, { discovered: 3, generated: 3, executable: 1, skipped: 0, untested: 2 })
assert.deepEqual(restCoveragePlan.executable[0]?.input, { method: "GET", path: "/wp/v2/posts", session: "admin" })
assert.equal(restCoveragePlan.untested[0]?.reason?.code, "mutating_rest_method_requires_explicit_opt_in")
assert.equal(restCoveragePlan.untested[0]?.parameterGeneration?.hook, "wordpress.rest-mutating-route-opt-in")
assert.equal(restCoveragePlan.untested[1]?.reason?.code, "route_requires_discovered_parameters")
assert.deepEqual(restCoveragePlan.untested[1]?.parameterGeneration?.requiredInputs, ["id"])
assert.equal(restCoveragePlan.parameterGenerationHooks?.length, 2)

const adminInventory: WordPressAdminPageInventory = {
  schema: WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  command: "wordpress.admin-page-inventory",
  status: "ok",
  adminUrl: "https://example.com/wp-admin/",
  menuLoaded: true,
  pages: [{ menuSlug: "tools.php", pageTitle: "Tools", menuTitle: "Tools", capability: "edit_posts" }, { menuSlug: "demo-settings", pageTitle: "Demo Settings", menuTitle: "Demo", capability: "manage_options" }, { menuSlug: "denied-settings", pageTitle: "Denied Settings", menuTitle: "Denied", capability: "manage_options", canAccess: false }],
  diagnostics: [],
}

const adminSuite = adminPageInventoryToFuzzSuite(adminInventory, { user: "admin" })
assert.equal(adminSuite.target?.entrypoint, "wordpress.admin-page-load")
assert.deepEqual(adminSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.admin-page-load"] })
assert.deepEqual(adminSuite.cases[0]?.input, { args: ["path=tools.php", "user=admin"] })
assert.deepEqual(adminSuite.cases[1]?.input, { args: ["path=admin.php?page=demo-settings", "user=admin"] })

const adminCoveragePlan = adminPageInventoryToCoveragePlan(adminInventory, { user: "admin" })
assert.deepEqual(adminCoveragePlan.summary, { discovered: 3, generated: 3, executable: 2, skipped: 1, untested: 0 })
assert.equal(adminCoveragePlan.skipped[0]?.reason?.code, "admin_page_capability_denied")

const frontendInventory: WordPressFrontendUrlInventory = {
  schema: WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  command: "wordpress.frontend-url-inventory",
  status: "ok",
  homeUrl: "https://example.com/",
  permalinkStructure: "/%postname%/",
  urls: [{ url: "https://example.com/hello-world/?preview=true", source: "home" }, { url: "https://example.com/sample-page/", source: "rewrite-rule", pattern: "^sample-page/?$", query: "index.php?pagename=sample-page" }],
  rewriteRules: [{ pattern: "^sample-page/?$", query: "index.php?pagename=sample-page" }],
  publicQueryVars: [],
  diagnostics: [],
}

const frontendSuite = frontendUrlInventoryToFuzzSuite(frontendInventory)
assert.equal(frontendSuite.target?.entrypoint, "wordpress.frontend-page-load")
assert.deepEqual(frontendSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.frontend-page-load"] })
assert.deepEqual(frontendSuite.cases[0]?.input, { args: ["path=/hello-world/?preview=true"] })
assert.equal((frontendSuite.cases[0]?.metadata?.safety as Record<string, unknown>).executable, true)

const frontendCoveragePlan = frontendUrlInventoryToCoveragePlan(frontendInventory)
assert.deepEqual(frontendCoveragePlan.summary, { discovered: 2, generated: 2, executable: 2, skipped: 0, untested: 0 })
assert.equal(frontendCoveragePlan.executable[1]?.metadata?.pattern, "^sample-page/?$")

console.log("wordpress fuzz suite builders ok")
