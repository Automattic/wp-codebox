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

const generatedRestInventory: WordPressRestRouteInventory = {
  schema: WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  command: "wordpress.rest-route-inventory",
  status: "ok",
  routes: [
    { route: "/example/v1/items", namespace: "example/v1", methods: ["GET", "POST"], argNames: ["search", "title"], endpoints: [{ methods: ["GET"], permission: { mode: "public" }, args: [{ name: "search", required: false, type: "string" }, { name: "count", required: false, type: "integer" }, { name: "metadata", required: false, type: "object" }, { name: "status", required: false, type: "string", enum: ["draft", "published"] }, { name: "enabled", required: false, type: "boolean" }] }, { methods: ["POST"], permission: { mode: "callback" }, args: [{ name: "title", required: true, type: "string" }, { name: "count", required: false, type: "integer" }, { name: "metadata", required: false, type: "object" }, { name: "status", required: false, type: "string", enum: ["draft", "published"] }, { name: "enabled", required: false, type: "boolean" }] }] },
    { route: "/example/v1/items/(?P<id>[\\d]+)", namespace: "example/v1", methods: ["DELETE"], argNames: ["id", "force"], endpoints: [{ methods: ["DELETE"], permission: { mode: "callback" }, args: [{ name: "id", required: true, type: "integer" }, { name: "force", required: false, type: "boolean" }] }] },
  ],
  namespaces: ["example/v1"],
  diagnostics: [],
}
const generatedRestSuite = restRouteInventoryToFuzzSuite(generatedRestInventory, {
  session: "admin",
  restPayloadFamilies: ["valid-minimal", "boundary-large-string", "invalid-type"],
  restGeneratedMutationResetPolicy: { mode: "checkpoint-per-case", checkpointName: "generated-rest-baseline" },
})
const generatedGetBoundary = generatedRestSuite.cases.find((fuzzCase) => fuzzCase.id === "rest-get-example-v1-items-0-boundary-large-string")
assert.deepEqual(generatedGetBoundary?.input, { method: "GET", path: "/example/v1/items", params: { search: "x".repeat(256) }, session: "admin" })
assert.equal(generatedGetBoundary?.metadata?.payloadFamily, "boundary-large-string")
assert.equal((generatedGetBoundary?.metadata?.seed as Record<string, unknown> | undefined)?.source, "wordpress.rest-route-inventory")
assert.equal((generatedGetBoundary?.metadata?.replay as Record<string, unknown> | undefined)?.caseId, "rest-get-example-v1-items-0-boundary-large-string")

const generatedPostInvalid = generatedRestSuite.cases.find((fuzzCase) => fuzzCase.id === "rest-post-example-v1-items-1-invalid-type")
assert.equal(generatedPostInvalid?.target?.kind, "runtime-action")
assert.deepEqual(generatedPostInvalid?.input, { type: "rest_request", method: "POST", path: "/example/v1/items", bodyJson: { title: 12345, count: "not-a-number" }, session: "admin" })
assert.deepEqual(generatedPostInvalid?.resetPolicy, { mode: "checkpoint-per-case", checkpointName: "generated-rest-baseline" })
assert.deepEqual(generatedPostInvalid?.mutation, { intent: "write", destructive: false, intensity: "medium" })
assert.equal((generatedPostInvalid?.metadata?.safety as Record<string, unknown> | undefined)?.executable, true)

const generatedDeleteInvalid = generatedRestSuite.cases.find((fuzzCase) => fuzzCase.id === "rest-delete-example-v1-items-p-id-d-0-invalid-type")
assert.deepEqual(generatedDeleteInvalid?.input, { type: "rest_request", method: "DELETE", path: "/example/v1/items/not-a-number", bodyJson: { force: "not-a-boolean" }, session: "admin" })
assert.deepEqual(generatedDeleteInvalid?.mutation, { intent: "delete", destructive: true, intensity: "high" })
assert.deepEqual(generatedDeleteInvalid?.resetPolicy, { mode: "checkpoint-per-case", checkpointName: "generated-rest-baseline" })
assert.equal((generatedDeleteInvalid?.metadata?.safety as Record<string, unknown> | undefined)?.payloadFamily, "invalid-type")

const advancedRestFamilies = ["nested-object", "null-empty", "enum-variant", "numeric-boundary", "boolean-flip", "repeated-field"] as const
const advancedRestSuiteA = restRouteInventoryToFuzzSuite(generatedRestInventory, {
  session: "admin",
  restPayloadFamilies: advancedRestFamilies,
  restGeneratedMutationResetPolicy: { mode: "checkpoint-per-case", checkpointName: "advanced-rest-baseline" },
})
const advancedRestSuiteB = restRouteInventoryToFuzzSuite(generatedRestInventory, {
  session: "admin",
  restPayloadFamilies: advancedRestFamilies,
  restGeneratedMutationResetPolicy: { mode: "checkpoint-per-case", checkpointName: "advanced-rest-baseline" },
})
assert.deepEqual(advancedRestSuiteA.cases, advancedRestSuiteB.cases)
assert.deepEqual(advancedRestSuiteA.cases.find((fuzzCase) => fuzzCase.id === "rest-get-example-v1-items-0-nested-object")?.input, { method: "GET", path: "/example/v1/items", params: { metadata: { nested: { value: "sample", list: ["sample", "sample-2"] } } }, session: "admin" })
assert.deepEqual(advancedRestSuiteA.cases.find((fuzzCase) => fuzzCase.id === "rest-get-example-v1-items-0-null-empty")?.input, { method: "GET", path: "/example/v1/items", params: { search: "" }, session: "admin" })
assert.deepEqual(advancedRestSuiteA.cases.find((fuzzCase) => fuzzCase.id === "rest-get-example-v1-items-0-enum-variant")?.input, { method: "GET", path: "/example/v1/items", params: { status: "published" }, session: "admin" })
assert.deepEqual(advancedRestSuiteA.cases.find((fuzzCase) => fuzzCase.id === "rest-get-example-v1-items-0-numeric-boundary")?.input, { method: "GET", path: "/example/v1/items", params: { count: 0 }, session: "admin" })
assert.deepEqual(advancedRestSuiteA.cases.find((fuzzCase) => fuzzCase.id === "rest-get-example-v1-items-0-boolean-flip")?.input, { method: "GET", path: "/example/v1/items", params: { enabled: false }, session: "admin" })
assert.deepEqual(advancedRestSuiteA.cases.find((fuzzCase) => fuzzCase.id === "rest-get-example-v1-items-0-repeated-field")?.input, { method: "GET", path: "/example/v1/items", params: { search: ["sample", "sample", "sample"] }, session: "admin" })
assert.equal(JSON.stringify(advancedRestSuiteA).includes("Woo"), false)
assert.equal(JSON.stringify(advancedRestSuiteA).includes("Gutenberg"), false)
assert.equal(JSON.stringify(advancedRestSuiteA).includes("Jetpack"), false)

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
assert.equal(adminSuite.cases.some((fuzzCase) => fuzzCase.id === "admin-page-denied-settings"), false)
assert.equal(adminSuite.cases[2]?.target?.entrypoint, "wordpress.browser-actions")
assert.deepEqual(adminSuite.cases[2]?.input, { args: ["url=/wp-admin/tools.php", "auth=wordpress-admin", "capture=steps,html,screenshot,dom-snapshot", "max-dom-snapshot-elements=500"] })
assert.deepEqual(adminSuite.cases[2]?.metadata?.actionDiscovery, { mode: "browser-dom-snapshot", executesActions: false, artifactEvidence: ["html", "dom-snapshot", "screenshot"] })

const serverAdminSuite = adminPageInventoryToFuzzSuite(adminInventory, { pageLoadMode: "server" })
assert.equal(serverAdminSuite.target?.entrypoint, "wordpress.server-page-load")
assert.deepEqual(serverAdminSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.server-page-load"] })
assert.deepEqual(serverAdminSuite.cases[0]?.input, { args: ["path=tools.php", "surface=admin"] })

const adminCoveragePlan = adminPageInventoryToCoveragePlan(adminInventory, { user: "admin" })
assert.deepEqual({ discovered: adminCoveragePlan.summary.discovered, generated: adminCoveragePlan.summary.generated, executable: adminCoveragePlan.summary.executable, executed: adminCoveragePlan.summary.executed, skipped: adminCoveragePlan.summary.skipped, untested: adminCoveragePlan.summary.untested }, { discovered: 5, generated: 5, executable: 4, executed: 0, skipped: 1, untested: 0 })
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
    { name: "wp_demo", baseName: "demo", classification: "prefixed", columns: [{ name: "id", type: "bigint", nullable: false, key: "PRI", default: null, extra: "auto_increment" }, { name: "name", type: "varchar(255)", nullable: false, key: "", default: null, extra: "" }], indexes: [{ name: "PRIMARY", column: "id", unique: true, sequence: 1 }] },
    { name: "external_events", baseName: "external_events", classification: "external", columns: [{ name: "id", type: "bigint", nullable: false, key: "PRI", default: null, extra: "" }] },
  ],
  totals: { tableCount: 3, rowCount: 0, columnCount: 4, indexCount: 1, dataBytes: 0, indexBytes: 0, totalBytes: 0 },
  diagnostics: [],
}

const databaseSuite = databaseInventoryToFuzzSuite(databaseInventory)
assert.equal(databaseSuite.target?.entrypoint, "wordpress.db-operation")
assert.deepEqual(databaseSuite.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime", "db_operation"], targetKinds: ["runtime"], commands: ["wordpress.db-operation"] })
assert.equal(databaseSuite.cases.length, 6)
assert.equal(JSON.parse((databaseSuite.cases[0]?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").operation, "inspect")
assert.equal(JSON.parse((databaseSuite.cases[0]?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").resource.table, "posts")
assert.equal(JSON.parse((databaseSuite.cases[1]?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").operation, "read")
assert.deepEqual(JSON.parse((databaseSuite.cases[2]?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").query.where, { ID: 1 })
assert.deepEqual(databaseSuite.cases[2]?.metadata?.columnLabels, ["ID"])
assert.equal(databaseSuite.cases.some((entry) => entry.id === "db-insert-demo"), false)

const mutatingDatabaseSuite = databaseInventoryToFuzzSuite(databaseInventory, { dbGeneratedMutationResetPolicy: { mode: "checkpoint-per-case", checkpointName: "db-baseline" } })
assert.equal(mutatingDatabaseSuite.cases.length, 9)
const dbInsert = mutatingDatabaseSuite.cases.find((entry) => entry.id === "db-insert-demo")
assert.equal(JSON.parse((dbInsert?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").options.mutation, "insert")
assert.deepEqual(JSON.parse((dbInsert?.input as { args: string[] }).args[0]?.replace("operation-json=", "") ?? "{}").metadata.generatedMutation, { status: "candidate", fixtureBound: false, fixtureBinding: "unbound", preRead: false, affectedRows: "unknown" })
assert.deepEqual(dbInsert?.resetPolicy, { mode: "checkpoint-per-case", checkpointName: "db-baseline" })
assert.deepEqual(dbInsert?.mutation, { intent: "write", destructive: false, intensity: "medium" })
assert.deepEqual(dbInsert?.metadata?.generatedMutation, { status: "candidate", fixtureBound: false, fixtureBinding: "unbound", preRead: false, affectedRows: "unknown" })
const dbDelete = mutatingDatabaseSuite.cases.find((entry) => entry.id === "db-delete-demo")
assert.deepEqual(dbDelete?.mutation, { intent: "delete", destructive: true, intensity: "high" })

const databaseCoveragePlan = databaseInventoryToCoveragePlan(databaseInventory)
assert.deepEqual({ discovered: databaseCoveragePlan.summary.discovered, generated: databaseCoveragePlan.summary.generated, executable: databaseCoveragePlan.summary.executable, executed: databaseCoveragePlan.summary.executed, skipped: databaseCoveragePlan.summary.skipped, untested: databaseCoveragePlan.summary.untested }, { discovered: 12, generated: 12, executable: 6, executed: 0, skipped: 6, untested: 0 })
assert.equal(databaseCoveragePlan.skipped.some((entry) => entry.reason?.code === "external_table_not_fuzzed"), true)
assert.equal(databaseCoveragePlan.skipped.some((entry) => entry.reason?.code === "db_mutation_requires_explicit_opt_in"), true)

console.log("wordpress fuzz suite builders ok")
