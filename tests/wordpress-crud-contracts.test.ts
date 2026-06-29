import assert from "node:assert/strict"
import {
  WORDPRESS_DB_OPERATION_SCHEMA,
  WORDPRESS_DB_RESULT_SCHEMA,
  WORDPRESS_CRUD_OPERATION_SCHEMA,
  WORDPRESS_CRUD_RESULT_SCHEMA,
  createUnsupportedWordPressDbResult,
  createUnsupportedWordPressCrudResult,
  normalizeWordPressDbOperation,
  normalizeWordPressCrudOperation,
} from "../packages/runtime-core/src/index.js"
import { getCommandDefinition } from "../packages/runtime-core/src/contracts.js"
import { wordpressCrudOperationPhpCode, wordpressDbOperationPhpCode } from "../packages/runtime-playground/src/wordpress-crud-command-handlers.js"
import { runPhpJson } from "../scripts/test-kit.js"

const operation = normalizeWordPressCrudOperation({
  schema: WORDPRESS_CRUD_OPERATION_SCHEMA,
  operation: "update",
  resource: {
    kind: "post",
    type: "page",
    id: "42",
    identifiers: { stable: true, source: "fuzz", index: 3, optional: null },
  },
  data: { title: "Fuzz target" },
  query: { context: "edit" },
  options: { dryRun: true },
})

assert.deepEqual(operation, {
  schema: WORDPRESS_CRUD_OPERATION_SCHEMA,
  operation: "update",
  resource: {
    kind: "post",
    type: "page",
    id: "42",
    identifiers: { stable: true, source: "fuzz", index: 3, optional: null },
  },
  data: { title: "Fuzz target" },
  query: { context: "edit" },
  options: { dryRun: true },
})

assert.deepEqual(createUnsupportedWordPressCrudResult(operation), {
  schema: WORDPRESS_CRUD_RESULT_SCHEMA,
  command: "wordpress.crud-operation",
  status: "unsupported",
  operation,
  diagnostics: [{ code: "crud-operation-unsupported", message: "wordpress.crud-operation is not implemented by this runtime backend.", severity: "warning" }],
  effects: [],
  artifactRefs: [],
})

const definition = getCommandDefinition("wordpress.crud-operation")
assert.equal(definition?.outputSchema?.id, WORDPRESS_CRUD_RESULT_SCHEMA)
assert.equal(definition?.handler.kind, "playground")
assert.equal(definition?.handler.kind === "playground" ? definition.handler.method : undefined, "runCrudOperation")

const guardedCreate = normalizeWordPressCrudOperation({
  operation: "create",
  resource: { kind: "post", type: "post" },
  data: { post_title: "Guarded" },
})
const crudPhp = wordpressCrudOperationPhpCode(guardedCreate)
assert.match(crudPhp, /wp_insert_post/)
assert.match(crudPhp, /wp_insert_term/)
assert.match(crudPhp, /wp_insert_comment/)
assert.match(crudPhp, /wp_insert_attachment/)
assert.match(crudPhp, /wp_insert_user/)
assert.match(crudPhp, /add_option/)
assert.match(crudPhp, /get_post_types/)
assert.match(crudPhp, /get_taxonomies/)
assert.match(crudPhp, /get_registered_settings/)
assert.match(crudPhp, /add_metadata/)
assert.match(crudPhp, /options\.destructivePermission=true/)
assert.match(crudPhp, /options\.dryRun=true/)
assert.match(crudPhp, /sandbox-boundary-required/)
assert.match(crudPhp, /mutation-isolation-artifact/)
assert.match(crudPhp, /delete-boundary-artifact/)

const phpPrelude = `
function wp_json_encode($data, $flags = 0) { return json_encode($data, $flags); }
function get_all_post_type_supports($post_type) { return array('title' => true, 'editor' => true); }
function get_post_types($args = array(), $output = 'names') { return array('page' => (object) array('name' => 'page', 'label' => 'Pages', 'public' => true, 'show_in_rest' => true, 'rest_base' => 'pages', 'hierarchical' => true)); }
function get_taxonomies($args = array(), $output = 'names') { return array('category' => (object) array('name' => 'category', 'label' => 'Categories', 'public' => true, 'show_in_rest' => true, 'rest_base' => 'categories', 'hierarchical' => true, 'object_type' => array('post'))); }
function get_registered_settings() { return array('posts_per_page' => array('type' => 'integer', 'group' => 'reading', 'description' => 'Posts per page', 'show_in_rest' => true, 'default' => 10)); }
function get_option($name, $default = null) { return $GLOBALS['wp_codebox_options'][$name] ?? $default; }
function update_option($name, $value) { $GLOBALS['wp_codebox_options'][$name] = $value; return true; }
function delete_option($name) { unset($GLOBALS['wp_codebox_options'][$name]); return true; }
`
const postTypeRead = await runPhpJson<Record<string, any>>(`${phpPrelude}\n${wordpressCrudOperationPhpCode(normalizeWordPressCrudOperation({ operation: "read", resource: { kind: "post_type", id: "page" } }))}`)
assert.equal(postTypeRead.status, "ok")
assert.equal(postTypeRead.item.name, "page")
assert.equal(postTypeRead.item.supports.title, true)

const taxonomyList = await runPhpJson<Record<string, any>>(`${phpPrelude}\n${wordpressCrudOperationPhpCode(normalizeWordPressCrudOperation({ operation: "list", resource: { kind: "taxonomy" } }))}`)
assert.equal(taxonomyList.status, "ok")
assert.equal(taxonomyList.items[0].name, "category")
assert.deepEqual(taxonomyList.items[0].object_type, ["post"])

const settingGuard = await runPhpJson<Record<string, any>>(`${phpPrelude}\n${wordpressCrudOperationPhpCode(normalizeWordPressCrudOperation({ operation: "update", resource: { kind: "setting", id: "posts_per_page" }, data: { value: 12 }, options: { destructivePermission: true } }))}`)
assert.equal(settingGuard.status, "error")
assert.equal(settingGuard.errors[0].code, "sandbox-boundary-required")

const settingUpdate = await runPhpJson<Record<string, any>>(`${phpPrelude}\n${wordpressCrudOperationPhpCode(normalizeWordPressCrudOperation({ operation: "update", resource: { kind: "setting", id: "posts_per_page" }, data: { value: 12 }, options: { destructivePermission: true }, metadata: { disposableSandboxBoundary: { disposable: true, destructivePermission: true, teardown: "discard", backend: "wordpress-playground" } } }))}`)
assert.equal(settingUpdate.status, "ok")
assert.equal(settingUpdate.item.name, "posts_per_page")
assert.equal(settingUpdate.artifactRefs[0].kind, "mutation-isolation-artifact")
assert.equal(settingUpdate.artifactRefs[0].payload.sandboxBoundary.backend, "wordpress-playground")

assert.throws(() => normalizeWordPressCrudOperation({ operation: "publish", resource: { kind: "post" } }), /operation must be create, read, update, delete, or list/)
assert.throws(() => normalizeWordPressCrudOperation({ operation: "read", resource: { kind: "post", identifiers: { nested: {} } } }), /identifiers\.nested must be a scalar value/)

const dbOperation = normalizeWordPressDbOperation({
  schema: WORDPRESS_DB_OPERATION_SCHEMA,
  operation: "read",
  resource: { table: "posts", identifiers: { source: "contract" } },
  query: { columns: ["ID", "post_title"], where: { post_type: "page" }, limit: 5 },
})

assert.deepEqual(dbOperation, {
  schema: WORDPRESS_DB_OPERATION_SCHEMA,
  operation: "read",
  resource: { table: "posts", identifiers: { source: "contract" } },
  query: { columns: ["ID", "post_title"], where: { post_type: "page" }, limit: 5 },
})

assert.deepEqual(createUnsupportedWordPressDbResult(dbOperation), {
  schema: WORDPRESS_DB_RESULT_SCHEMA,
  command: "wordpress.db-operation",
  status: "unsupported",
  operation: dbOperation,
  diagnostics: [{ code: "db-operation-unsupported", message: "wordpress.db-operation is not implemented by this runtime backend.", severity: "warning" }],
  artifactRefs: [],
})

const dbDefinition = getCommandDefinition("wordpress.db-operation")
assert.equal(dbDefinition?.outputSchema?.id, WORDPRESS_DB_RESULT_SCHEMA)
assert.equal(dbDefinition?.handler.kind === "playground" ? dbDefinition.handler.method : undefined, "runDbOperation")
assert.match(dbDefinition?.policyRequirement ?? "", /explicit disposable sandbox destructive permission/i)
assert.match(dbDefinition?.policyRequirement ?? "", /discovered prefixed WordPress tables/i)

const dbPhp = wordpressDbOperationPhpCode(dbOperation)
assert.match(dbPhp, /SHOW TABLES LIKE/)
assert.match(dbPhp, /DESCRIBE/)
assert.match(dbPhp, /SHOW INDEX FROM/)
assert.match(dbPhp, /SHOW TABLE STATUS LIKE/)
assert.match(dbPhp, /SELECT/)
assert.match(dbPhp, /db-destructive-permission-required/)
assert.match(dbPhp, /wp_codebox_db_discovered_tables/)
assert.match(dbPhp, /classification.*core.*prefixed.*external/s)
assert.match(dbPhp, /unsafe-column/)
assert.match(dbPhp, /attribution/)

assert.throws(() => normalizeWordPressDbOperation({ operation: "drop" }), /operation must be schema, read, inspect, query-summary, or write/)
assert.throws(() => normalizeWordPressDbOperation({ operation: "read", resource: { identifiers: { nested: {} } } }), /identifiers\.nested must be a scalar value/)
assert.throws(() => normalizeWordPressDbOperation({ operation: "read", query: { where: { nested: {} } } }), /query\.where\.nested must be a scalar value/)

console.log("wordpress CRUD contract normalization passed")
