import assert from "node:assert/strict"

import {
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  wordpressRuntimeDiscoveryToCoveragePlan,
  type WordPressRuntimeDiscoveryResult,
} from "../packages/runtime-core/src/public.js"

const discovery: WordPressRuntimeDiscoveryResult = {
  schema: WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  command: "wordpress.runtime-discovery",
  status: "ok",
  surfaces: ["rest", "admin", "database", "frontend", "blocks"],
  rest: {
    schema: "wp-codebox/wordpress-rest-route-discovery/v1",
    namespaces: ["wp/v2"],
    routes: [
      { route: "/wp/v2/posts", namespace: "wp/v2", methods: ["GET", "POST"], argNames: [], endpoints: [{ methods: ["GET", "POST"], permission: { mode: "public" }, args: [] }] },
      { route: "/wp/v2/posts/(?P<id>[\\d]+)", namespace: "wp/v2", methods: ["GET"], argNames: ["id"], endpoints: [{ methods: ["GET"], permission: { mode: "callback" }, args: [{ name: "id", required: true, type: "integer" }] }] },
    ],
  },
  admin: {
    schema: "wp-codebox/wordpress-admin-page-discovery/v1",
    adminUrl: "https://example.com/wp-admin/",
    menuLoaded: true,
    pages: [{ menuSlug: "tools.php", pageTitle: "Tools", menuTitle: "Tools", capability: "edit_posts" }, { menuSlug: "secret", pageTitle: "Secret", menuTitle: "Secret", capability: "manage_options", canAccess: false }],
  },
  frontend: {
    schema: "wp-codebox/wordpress-frontend-route-discovery/v1",
    homeUrl: "https://example.com/",
    permalinkStructure: "/%postname%/",
    rewriteRules: [],
    publicQueryVars: [],
  },
  database: {
    schema: "wp-codebox/wordpress-db-schema-discovery/v1",
    prefix: "wp_",
    tables: [{ name: "wp_posts", baseName: "posts", classification: "core", columns: [{ name: "ID", type: "bigint", nullable: false, key: "PRI", default: null, extra: "auto_increment" }] }, { name: "external_events", baseName: "external_events", classification: "external", columns: [{ name: "id", type: "bigint", nullable: false, key: "PRI", default: null, extra: "" }] }],
  },
  blocks: {
    schema: "wp-codebox/wordpress-block-editor-target-discovery/v1",
    blocks: [{ name: "core/paragraph", title: "Paragraph", category: "text", supportsInserter: true, attributes: [{ name: "content", type: "string" }] }, { name: "core/template-part", title: "Template Part", category: "theme", supportsInserter: false, attributes: [] }],
    editorPostTypes: [{ name: "post", label: "Posts", restBase: "posts", editorUrl: "https://example.com/wp-admin/post-new.php" }],
  },
  diagnostics: [],
}

const plan = wordpressRuntimeDiscoveryToCoveragePlan(discovery, { id: "runtime-plan" })

assert.equal(plan.schema, "wp-codebox/fuzz-coverage-plan/v1")
assert.equal(plan.id, "runtime-plan")
assert.equal(plan.metadata?.sourceSchema, WORDPRESS_RUNTIME_DISCOVERY_SCHEMA)
assert.equal(plan.discovered.some((item) => item.id === "rest-get-wp-v2-posts-0"), true)
assert.equal(plan.discovered.some((item) => item.id === "admin-page-tools-php"), true)
assert.equal(plan.discovered.some((item) => item.id === "frontend-url-root"), true)
assert.equal(plan.discovered.some((item) => item.id === "db-inspect-posts"), true)
assert.equal(plan.discovered.some((item) => item.id === "block-core-paragraph-server-render-sample-attributes"), true)
assert.equal(plan.discovered.some((item) => item.target?.entrypoint === "wordpress.block-render"), true)
assert.equal(plan.discovered.some((item) => item.target?.entrypoint === "wordpress.block-exercise"), true)
assert.equal(plan.discovered.some((item) => item.id === "crud-list-post"), true)
assert.equal(plan.discovered.some((item) => item.id === "crud-read-post"), true)
assert.equal(plan.discovered.some((item) => item.id === "page-load-mode-wordpress-simulated-frontend-page-load"), true)
assert.equal(plan.discovered.some((item) => item.target?.entrypoint === "wordpress.frontend-page-load"), false)
assert.equal(plan.discovered.some((item) => item.target?.entrypoint === "wordpress.admin-page-load"), false)

assert.equal(plan.skipped.some((item) => item.reason?.code === "admin_page_capability_denied"), true)
assert.equal(plan.skipped.some((item) => item.reason?.code === "external_table_not_fuzzed"), true)
assert.equal(plan.untested.some((item) => item.reason?.code === "mutating_rest_method_requires_explicit_opt_in"), true)
assert.equal(plan.untested.some((item) => item.reason?.code === "block_inserter_unsupported"), true)
assert.equal(plan.untested.some((item) => item.reason?.code === "crud_resource_identifier_required"), true)
assert.equal(plan.executable.every((item) => item.input !== undefined && !item.reason), true)
assert.equal(plan.discovered.every((item) => Boolean(item.metadata?.requiredRunnerCapabilities)), true)
assert.deepEqual(plan.discovered.find((item) => item.id === "crud-list-post")?.metadata?.requiredRunnerCapabilities, { capabilities: ["target:runtime", "runtime"], targetKinds: ["runtime"], commands: ["wordpress.crud-operation"] })
assert.equal(plan.parameterGenerationHooks?.some((hook) => hook.id === "wordpress.rest-route-parameters"), true)
assert.equal(plan.parameterGenerationHooks?.some((hook) => hook.id === "wordpress.crud-resource-identifiers"), true)
assert.deepEqual(plan.summary.targetIds.includes("wordpress.simulated-frontend-page-load"), true)

console.log("wordpress runtime discovery coverage plan ok")
