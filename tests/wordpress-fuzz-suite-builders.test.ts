import assert from "node:assert/strict"

import {
  WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  WORDPRESS_DATABASE_INVENTORY_SCHEMA,
  WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  adminPageInventoryToFuzzSuite,
  adminPageInventoryToCoveragePlan,
  databaseInventoryToFuzzSuite,
  databaseInventoryToCoveragePlan,
  frontendUrlInventoryToFuzzSuite,
  frontendUrlInventoryToCoveragePlan,
  restRouteInventoryToFuzzSuite,
  restRouteInventoryToCoveragePlan,
  type WordPressAdminPageInventory,
  type WordPressDatabaseInventory,
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
    { route: "/demo/v1/search", namespace: "demo/v1", methods: ["GET"], argNames: ["kind"], endpoints: [{ methods: ["GET"], permission: { mode: "public" }, args: [{ name: "kind", required: true, type: "string", enum: ["post", "page"] }] }] },
  ],
  namespaces: ["wp/v2"],
  diagnostics: [],
}

const restSuite = restRouteInventoryToFuzzSuite(restInventory, { session: "admin" })
assert.equal(restSuite.schema, "wp-codebox/fuzz-suite/v1")
assert.equal(restSuite.metadata?.sourceSchema, WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA)
assert.deepEqual(restSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:rest"], targetKinds: ["rest"] })
assert.equal(restSuite.coveragePlan?.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.deepEqual(restSuite.coveragePlan?.summary.caseIds, ["rest-get-wp-v2-posts-0", "rest-post-wp-v2-posts-0", "rest-get-wp-v2-posts-p-id-d-0", "rest-get-demo-v1-search-0"])
assert.equal(restSuite.cases.length, 4)
assert.equal(restSuite.cases[0]?.target?.kind, "rest")
assert.deepEqual(restSuite.cases[0]?.input, { method: "GET", path: "/wp/v2/posts", session: "admin" })
assert.equal((restSuite.cases[0]?.metadata?.safety as Record<string, unknown>).executable, true)
assert.equal(restSuite.cases[1]?.target?.kind, "rest-planned")
assert.equal((restSuite.cases[1]?.metadata?.safety as Record<string, unknown>).reason, "mutating_rest_method_requires_explicit_opt_in")
assert.equal(restSuite.cases[2]?.target?.kind, "rest")
assert.deepEqual(restSuite.cases[2]?.input, { method: "GET", path: "/wp/v2/posts/1", session: "admin" })
assert.deepEqual((restSuite.cases[2]?.metadata?.safety as Record<string, unknown>).generatedParameters, { path: { id: 1 } })
assert.equal(restSuite.cases[3]?.target?.kind, "rest")
assert.deepEqual(restSuite.cases[3]?.input, { method: "GET", path: "/demo/v1/search", params: { kind: "post" }, session: "admin" })

const restCoveragePlan = restRouteInventoryToCoveragePlan(restInventory, { session: "admin" })
assert.equal(restCoveragePlan.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.deepEqual({ discovered: restCoveragePlan.summary.discovered, generated: restCoveragePlan.summary.generated, executable: restCoveragePlan.summary.executable, executed: restCoveragePlan.summary.executed, skipped: restCoveragePlan.summary.skipped, untested: restCoveragePlan.summary.untested }, { discovered: 4, generated: 4, executable: 3, executed: 0, skipped: 0, untested: 1 })
assert.deepEqual(restCoveragePlan.summary.targetIds, ["wordpress.rest-request"])
assert.deepEqual(restCoveragePlan.executable[0]?.input, { method: "GET", path: "/wp/v2/posts", session: "admin" })
assert.deepEqual(restCoveragePlan.executable[1]?.input, { method: "GET", path: "/wp/v2/posts/1", session: "admin" })
assert.deepEqual(restCoveragePlan.executable[2]?.input, { method: "GET", path: "/demo/v1/search", params: { kind: "post" }, session: "admin" })
assert.equal(restCoveragePlan.untested[0]?.reason?.code, "mutating_rest_method_requires_explicit_opt_in")
assert.equal(restCoveragePlan.untested[0]?.parameterGeneration?.hook, "wordpress.rest-mutating-route-opt-in")
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
assert.equal(adminSuite.target?.entrypoint, "wordpress.simulated-admin-page-load")
assert.deepEqual(adminSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.simulated-admin-page-load"] })
assert.equal(adminSuite.metadata?.pageLoadMode, "simulated")
assert.deepEqual(adminSuite.cases[0]?.input, { args: ["path=tools.php", "user=admin"] })
assert.deepEqual(adminSuite.cases[1]?.input, { args: ["path=admin.php?page=demo-settings", "user=admin"] })

const serverAdminSuite = adminPageInventoryToFuzzSuite(adminInventory, { pageLoadMode: "server" })
assert.equal(serverAdminSuite.target?.entrypoint, "wordpress.server-page-load")
assert.deepEqual(serverAdminSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.server-page-load"] })
assert.deepEqual(serverAdminSuite.cases[0]?.input, { args: ["path=tools.php", "surface=admin"] })

const adminCoveragePlan = adminPageInventoryToCoveragePlan(adminInventory, { user: "admin" })
assert.deepEqual({ discovered: adminCoveragePlan.summary.discovered, generated: adminCoveragePlan.summary.generated, executable: adminCoveragePlan.summary.executable, executed: adminCoveragePlan.summary.executed, skipped: adminCoveragePlan.summary.skipped, untested: adminCoveragePlan.summary.untested }, { discovered: 3, generated: 3, executable: 2, executed: 0, skipped: 1, untested: 0 })
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
assert.equal(frontendSuite.target?.entrypoint, "wordpress.simulated-frontend-page-load")
assert.deepEqual(frontendSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.simulated-frontend-page-load"] })
assert.deepEqual(frontendSuite.cases[0]?.input, { args: ["path=/hello-world/?preview=true"] })
assert.equal((frontendSuite.cases[0]?.metadata?.safety as Record<string, unknown>).executable, true)

const browserFrontendSuite = frontendUrlInventoryToFuzzSuite(frontendInventory, { pageLoadMode: "browser" })
assert.equal(browserFrontendSuite.target?.entrypoint, "wordpress.browser-page-load")
assert.equal(browserFrontendSuite.metadata?.pageLoadMode, "browser")
assert.deepEqual(browserFrontendSuite.cases[0]?.input, { args: ["path=/hello-world/?preview=true", "surface=frontend"] })

const frontendCoveragePlan = frontendUrlInventoryToCoveragePlan(frontendInventory)
assert.deepEqual({ discovered: frontendCoveragePlan.summary.discovered, generated: frontendCoveragePlan.summary.generated, executable: frontendCoveragePlan.summary.executable, executed: frontendCoveragePlan.summary.executed, skipped: frontendCoveragePlan.summary.skipped, untested: frontendCoveragePlan.summary.untested }, { discovered: 2, generated: 2, executable: 2, executed: 0, skipped: 0, untested: 0 })
assert.equal(frontendCoveragePlan.executable[1]?.metadata?.pattern, "^sample-page/?$")

const databaseInventory: WordPressDatabaseInventory = {
  schema: WORDPRESS_DATABASE_INVENTORY_SCHEMA,
  command: "wordpress.inventory-database",
  status: "ok",
  prefix: "wp_",
  tables: [
    { name: "wp_posts", baseName: "posts", classification: "core", columns: [{ name: "ID", type: "bigint", nullable: false, key: "PRI", default: null, extra: "auto_increment" }] },
    { name: "wp_demo", baseName: "demo", classification: "prefixed", columns: [{ name: "id", type: "bigint", nullable: false, key: "PRI", default: null, extra: "" }] },
    { name: "external_events", baseName: "external_events", classification: "external", columns: [{ name: "id", type: "bigint", nullable: false, key: "PRI", default: null, extra: "" }] },
  ],
  totals: { tableCount: 3, rowCount: 0, columnCount: 3, indexCount: 0, dataBytes: 0, indexBytes: 0, totalBytes: 0 },
  diagnostics: [],
}

const databaseSuite = databaseInventoryToFuzzSuite(databaseInventory)
assert.equal(databaseSuite.target?.entrypoint, "wordpress.db-operation")
assert.deepEqual(databaseSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime", "db_operation"], targetKinds: ["runtime"], commands: ["wordpress.db-operation"] })
assert.equal(databaseSuite.cases.length, 2)
assert.equal(JSON.parse((databaseSuite.cases[0]?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").operation, "inspect")
assert.equal(JSON.parse((databaseSuite.cases[0]?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").resource.table, "posts")

const databaseCoveragePlan = databaseInventoryToCoveragePlan(databaseInventory)
assert.deepEqual({ discovered: databaseCoveragePlan.summary.discovered, generated: databaseCoveragePlan.summary.generated, executable: databaseCoveragePlan.summary.executable, executed: databaseCoveragePlan.summary.executed, skipped: databaseCoveragePlan.summary.skipped, untested: databaseCoveragePlan.summary.untested }, { discovered: 3, generated: 3, executable: 2, executed: 0, skipped: 1, untested: 0 })
assert.equal(databaseCoveragePlan.skipped[0]?.reason?.code, "external_table_not_fuzzed")

console.log("wordpress fuzz suite builders ok")
