import assert from "node:assert/strict"

import {
  WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA,
  WORDPRESS_DATABASE_INVENTORY_SCHEMA,
  WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA,
  WORDPRESS_EXECUTION_SURFACES_SCHEMA,
  WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
  WORDPRESS_REST_MATRIX_SCHEMA,
  WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  type WordPressAdminPageInventory,
  type WordPressAdminActionInventory,
  type WordPressDatabaseInventory,
  type WordPressExecutionActionResult,
  type WordPressExecutionSurfaceDiscovery,
  type WordPressFrontendUrlInventory,
  type WordPressRestRouteInventory,
  type WordPressRuntimeDiscoveryResult,
} from "../packages/runtime-core/src/index.js"
import { runtimeContractManifest } from "../packages/runtime-core/src/public.js"
import { getCommandDefinition, runtimeCommandDefinitions } from "../packages/runtime-core/src/command-registry.js"
import { runtimeAdminActionInventoryPhpCode, runtimeDiscoveryPhpCode, runtimeDiscoverySurfacesFromArgs, runtimeInventoryPhpCode } from "../packages/runtime-playground/src/runtime-discovery-command-handlers.js"
import { wordpressExecutionActionInputFromArgs, wordpressExecutionActionPhpCode } from "../packages/runtime-playground/src/wordpress-execution-command-handlers.js"
import { runPhpJson } from "../scripts/test-kit.js"

const result: WordPressRuntimeDiscoveryResult = {
  schema: WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  command: "wordpress.runtime-discovery",
  status: "ok",
  surfaces: ["rest", "admin", "database", "frontend", "blocks", "auth", "execution"],
  diagnostics: [],
}

assert.equal(result.schema, "wp-codebox/wordpress-runtime-discovery/v1")
assert.deepEqual(runtimeDiscoverySurfacesFromArgs([]), ["rest", "admin", "database", "frontend", "blocks", "auth", "execution"])
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
    routes: [{
      route: "/wp/v2/posts/(?P<id>[\\d]+)",
      namespace: "wp",
      methods: ["GET", "POST"],
      argNames: ["id", "context"],
      endpoints: [{
        methods: ["GET"],
        permission: { mode: "public", callbackType: "function" },
        args: [{ name: "id", required: true, type: "integer", description: "Post id", defaultPresent: false, validateCallback: true, sanitizeCallback: false }],
      }],
      schema: { title: "post", type: "object", properties: ["id", "title"] },
    }],
  namespaces: [],
  diagnostics: [],
}
const adminInventory: WordPressAdminPageInventory = {
  schema: WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  command: "wordpress.admin-page-inventory",
  status: "unsupported",
  adminUrl: "https://example.com/wp-admin/",
  menuLoaded: false,
  user: { isLoggedIn: false, id: 0, roles: [] },
  pages: [],
  diagnostics: [],
}
const adminActionInventory: WordPressAdminActionInventory = {
  schema: WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA,
  command: "wordpress.admin-action-inventory",
  status: "ok",
  adminUrl: "https://example.com/wp-admin/",
  menuLoaded: true,
  user: { isLoggedIn: true, id: 7, roles: ["administrator"] },
  pages: [],
  actions: [],
  diagnostics: [],
  redaction: { samplePayloadValues: "redacted", nonceValues: "redacted" },
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
const databaseInventory: WordPressDatabaseInventory = {
  schema: WORDPRESS_DATABASE_INVENTORY_SCHEMA,
  command: "wordpress.inventory-database",
  status: "ok",
  prefix: "wp_",
  tables: [{
    name: "wp_posts",
    baseName: "posts",
    classification: "core",
    engine: "InnoDB",
    rowCount: 1,
    dataBytes: 256,
    indexBytes: 256,
    totalBytes: 512,
    columns: [{ name: "ID", type: "bigint unsigned", nullable: false, key: "PRI", default: null, extra: "auto_increment" }],
    indexes: [{ name: "PRIMARY", column: "ID", unique: true, sequence: 1 }],
    status: { engine: "InnoDB", rows: 1, collation: "utf8mb4_unicode_ci", dataBytes: 256, indexBytes: 256, totalBytes: 512 },
  }],
  totals: { tableCount: 1, rowCount: 1, columnCount: 1, indexCount: 1, dataBytes: 256, indexBytes: 256, totalBytes: 512 },
  diagnostics: [],
}
const executionSurfaces: WordPressExecutionSurfaceDiscovery = {
  schema: WORDPRESS_EXECUTION_SURFACES_SCHEMA,
  command: "wordpress.execution-surfaces",
  status: "ok",
  surfaces: [{
    kind: "hook",
    command: "wordpress.invoke-hook",
    supported: true,
    executable: true,
    discovery: { supported: false, reason: "hook_discovery_not_declared" },
    counting: { supported: false, reason: "hook_counting_not_declared" },
    invocation: { supported: true, argumentEncoding: "args-json", resultSchema: WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA },
    safety: { mutates: "declared-by-caller", requiresMutationDeclaration: true, capabilityField: "capability", destructiveBoundaryField: "destructive-boundary", defaultDestructiveBoundary: "disposable-runtime", rollbackRequired: false },
  }],
  unsupported: [{ surface: "hook", capability: "discovery", reason: "hook_discovery_not_declared" }],
  diagnostics: [],
}

assert.equal(restInventory.schema, "wp-codebox/wordpress-rest-route-inventory/v1")
assert.equal(adminInventory.schema, "wp-codebox/wordpress-admin-page-inventory/v1")
assert.equal(adminActionInventory.schema, "wp-codebox/wordpress-admin-action-inventory/v1")
assert.equal(databaseInventory.schema, "wp-codebox/wordpress-db-inventory/v1")
assert.equal(frontendInventory.schema, "wp-codebox/wordpress-frontend-url-inventory/v1")
assert.equal(executionSurfaces.schema, "wp-codebox/wordpress-execution-surfaces/v1")
assert.equal(executionSurfaces.surfaces[0]?.invocation.resultSchema, WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA)

const inventoryDefinitions = [
  ["wordpress.rest-route-inventory", "runRestRouteInventory", WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA],
  ["wordpress.inventory-rest-routes", "runRestRouteInventory", WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA],
  ["wordpress.admin-page-inventory", "runAdminPageInventory", WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA],
  ["wordpress.admin-action-inventory", "runAdminActionInventory", WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA],
  ["wordpress.inventory-database", "runDatabaseInventory", WORDPRESS_DATABASE_INVENTORY_SCHEMA],
  ["wordpress.frontend-url-inventory", "runFrontendUrlInventory", WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA],
  ["wordpress.execution-surfaces", "runExecutionSurfaces", WORDPRESS_EXECUTION_SURFACES_SCHEMA],
  ["wordpress.invoke-wp-cli", "runInvokeWpCli", WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA],
  ["wordpress.invoke-hook", "runInvokeHook", WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA],
  ["wordpress.invoke-cron-event", "runInvokeCronEvent", WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA],
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
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.adminActionInventory, WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.databaseInventory, WORDPRESS_DATABASE_INVENTORY_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.frontendUrlInventory, WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.executionSurfaces, WORDPRESS_EXECUTION_SURFACES_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.executionActionResult, WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.restMatrix, WORDPRESS_REST_MATRIX_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.restMatrixResult, WORDPRESS_REST_MATRIX_RESULT_SCHEMA)

const discoveryPhp = runtimeDiscoveryPhpCode(["rest"]).replace(/^<\?php\n/, "")
assert.doesNotMatch(discoveryPhp, /wp_codebox|WP_CODEBOX/)
const discovered = await runPhpJson<WordPressRuntimeDiscoveryResult>(`
function wp_strip_all_tags( $text ) { return strip_tags( $text ); }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function rest_get_server() {
    return new class {
        public function get_routes() {
            return array(
                '/demo/v1/items/(?P<id>[\\d]+)' => array(
                    array(
                        'methods' => array( 'GET' => true ),
                        'permission_callback' => '__return_true',
                        'args' => array(
                            'id' => array(
                                'required' => true,
                                'type' => 'integer',
                                'description' => '<strong>Item id</strong>',
                                'validate_callback' => 'absint',
                            ),
                            'context' => array(
                                'required' => false,
                                'type' => 'string',
                                'enum' => array( 'view', 'edit' ),
                                'default' => 'view',
                            ),
                        ),
                        'schema' => array(
                            'title' => 'demo-item',
                            'type' => 'object',
                            'properties' => array( 'id' => array(), 'name' => array() ),
                        ),
                    ),
                    array(
                        'methods' => array( 'POST' => true ),
                        'permission_callback' => array( 'Demo_Controller', 'create_item_permissions_check' ),
                        'args' => array(),
                    ),
                ),
            );
        }
    };
}
${discoveryPhp}
`)

const route = discovered.rest?.routes[0]
assert.equal(route?.route, "/demo/v1/items/(?P<id>[\\d]+)")
assert.deepEqual(route?.methods, ["GET", "POST"])
assert.equal(route?.endpoints?.[0]?.permission.mode, "public")
assert.equal(route?.endpoints?.[1]?.permission.mode, "callback")
assert.equal(route?.endpoints?.[1]?.permission.callbackType, "method")
assert.equal(route?.endpoints?.[0]?.args[0]?.name, "id")
assert.equal(route?.endpoints?.[0]?.args[0]?.required, true)
assert.equal(route?.endpoints?.[0]?.args[0]?.description, "Item id")
assert.deepEqual(route?.endpoints?.[0]?.args[1]?.enum, ["view", "edit"])
assert.equal(route?.endpoints?.[0]?.args[1]?.defaultPresent, true)
assert.deepEqual(route?.schema?.properties, ["id", "name"])

const inventoryPhp = runtimeInventoryPhpCode("rest", "wordpress.inventory-rest-routes", WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA).replace(/^<\?php\n/, "")
const inventoryDiscovered = await runPhpJson<WordPressRestRouteInventory>(`
function wp_strip_all_tags( $text ) { return strip_tags( $text ); }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function rest_get_server() {
    return new class {
        public function get_routes() {
            return array(
                '/demo/v1/items' => array(
                    array(
                        'methods' => array( 'GET' => true ),
                        'permission_callback' => '__return_true',
                        'args' => array(),
                    ),
                ),
            );
        }
    };
}
${inventoryPhp}
`)

assert.equal(inventoryDiscovered.command, "wordpress.inventory-rest-routes")
assert.equal(inventoryDiscovered.schema, WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA)
assert.equal(inventoryDiscovered.routes[0]?.route, "/demo/v1/items")

const databaseInventoryPhp = runtimeInventoryPhpCode("database", "wordpress.inventory-database", WORDPRESS_DATABASE_INVENTORY_SCHEMA).replace(/^<\?php\n/, "")
const databaseDiscovered = await runPhpJson<WordPressDatabaseInventory>(`
define( 'ARRAY_A', 'ARRAY_A' );
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
class RuntimeDiscoveryWpdb {
    public $prefix = 'wp_';
    public function tables( $scope ) { return array( 'posts', 'options' ); }
    public function esc_like( $text ) { return addcslashes( $text, '_%\\\\' ); }
    public function prepare( $query, $value ) { return str_replace( '%s', "'" . str_replace( "'", "''", $value ) . "'", $query ); }
    public function get_col( $query ) { return array( 'wp_posts', 'wp_wc_orders' ); }
    public function get_results( $query, $format = null ) {
        if ( str_starts_with( $query, 'DESCRIBE ' ) ) {
            return array( array( 'Field' => 'ID', 'Type' => 'bigint unsigned', 'Null' => 'NO', 'Key' => 'PRI', 'Default' => null, 'Extra' => 'auto_increment' ) );
        }
        if ( str_starts_with( $query, 'SHOW INDEX FROM ' ) ) {
            return array( array( 'Key_name' => 'PRIMARY', 'Column_name' => 'ID', 'Non_unique' => '0', 'Seq_in_index' => '1' ) );
        }
        if ( str_starts_with( $query, 'SHOW TABLE STATUS LIKE ' ) ) {
            return array( array( 'Engine' => 'InnoDB', 'Rows' => '12', 'Data_length' => '256', 'Index_length' => '128', 'Collation' => 'utf8mb4_unicode_ci' ) );
        }
        return array();
    }
}
$GLOBALS['wpdb'] = new RuntimeDiscoveryWpdb();
$wpdb = $GLOBALS['wpdb'];
${databaseInventoryPhp}
`)

assert.equal(databaseDiscovered.command, "wordpress.inventory-database")
assert.equal(databaseDiscovered.schema, WORDPRESS_DATABASE_INVENTORY_SCHEMA)
assert.equal(databaseDiscovered.prefix, "wp_")
assert.equal(databaseDiscovered.tables[0]?.baseName, "posts")
assert.equal(databaseDiscovered.tables[0]?.classification, "core")
assert.equal(databaseDiscovered.tables[1]?.baseName, "wc_orders")
assert.equal(databaseDiscovered.tables[1]?.classification, "prefixed")
assert.equal(databaseDiscovered.tables[1]?.columns[0]?.name, "ID")
assert.equal(databaseDiscovered.tables[1]?.indexes?.[0]?.unique, true)
assert.equal(databaseDiscovered.tables[1]?.status?.rows, 12)
assert.equal(databaseDiscovered.tables[1]?.rowCount, 12)
assert.equal(databaseDiscovered.tables[1]?.dataBytes, 256)
assert.equal(databaseDiscovered.tables[1]?.indexBytes, 128)
assert.equal(databaseDiscovered.tables[1]?.totalBytes, 384)
assert.deepEqual(databaseDiscovered.totals, { tableCount: 2, rowCount: 24, columnCount: 2, indexCount: 2, dataBytes: 512, indexBytes: 256, totalBytes: 768 })

const executionDiscoveryPhp = runtimeDiscoveryPhpCode(["execution"]).replace(/^<\?php\n/, "")
const executionDiscovered = await runPhpJson<WordPressRuntimeDiscoveryResult>(`
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
${executionDiscoveryPhp}
`)
assert.equal(executionDiscovered.execution?.schema, WORDPRESS_EXECUTION_SURFACES_SCHEMA)
assert.equal(executionDiscovered.execution?.surfaces.find((surface) => surface.kind === "wp-cli")?.invocation.supported, true)
assert.equal(executionDiscovered.execution?.surfaces.find((surface) => surface.kind === "hook")?.discovery.supported, false)
assert.equal(executionDiscovered.execution?.surfaces.find((surface) => surface.kind === "cron")?.scheduling?.supported, true)

const executionInventoryPhp = runtimeInventoryPhpCode("execution", "wordpress.execution-surfaces", WORDPRESS_EXECUTION_SURFACES_SCHEMA).replace(/^<\?php\n/, "")
const executionInventory = await runPhpJson<WordPressExecutionSurfaceDiscovery>(`
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
${executionInventoryPhp}
`)
assert.equal(executionInventory.command, "wordpress.execution-surfaces")
assert.equal(executionInventory.unsupported.some((capability) => capability.surface === "hook" && capability.capability === "counting"), true)

const hookInput = wordpressExecutionActionInputFromArgs(["hook=wp_codebox_test_hook", 'args-json=["demo"]', "mutates=true", "capability=read"], "wordpress.invoke-hook")
const hookPhp = wordpressExecutionActionPhpCode(hookInput, "wordpress.invoke-hook").replace(/^<\?php\n/, "")
const hookResult = await runPhpJson<WordPressExecutionActionResult>(`
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function current_user_can( $capability ) { return $capability === 'read'; }
$GLOBALS['wp_codebox_test_did_action'] = array();
$GLOBALS['wp_codebox_test_hook_seen'] = array();
function add_action( $hook, $callback ) { $GLOBALS['wp_codebox_test_callback'] = $callback; }
function did_action( $hook ) { return $GLOBALS['wp_codebox_test_did_action'][$hook] ?? 0; }
function do_action_ref_array( $hook, $args ) { $GLOBALS['wp_codebox_test_did_action'][$hook] = ($GLOBALS['wp_codebox_test_did_action'][$hook] ?? 0) + 1; $GLOBALS['wp_codebox_test_callback'](...$args); }
add_action( 'wp_codebox_test_hook', function ( $value ) { $GLOBALS['wp_codebox_test_hook_seen'][] = $value; } );
${hookPhp}
`)
assert.equal(hookResult.schema, WORDPRESS_EXECUTION_ACTION_RESULT_SCHEMA)
assert.equal(hookResult.command, "wordpress.invoke-hook")
assert.equal(hookResult.status, "ok")
assert.equal(hookResult.safety.mutates, true)
assert.equal(hookResult.safety.capability, "read")
assert.equal(hookResult.result.didActionDelta, 1)

const adminDiscoveryPhp = runtimeDiscoveryPhpCode(["admin"]).replace(/^<\?php\n/, "")
assert.match(adminDiscoveryPhp, /wp-admin\/menu\.php/)
const adminDiscovered = await runPhpJson<WordPressRuntimeDiscoveryResult>(`
class WP_User {
    public $ID = 7;
    public $roles = array( 'administrator' );
}
function is_user_logged_in() { return true; }
function wp_get_current_user() { return new WP_User(); }
function current_user_can( $capability ) { return in_array( $capability, array( 'read', 'manage_options' ), true ); }
function admin_url( $path = '' ) { return 'https://example.com/wp-admin/' . ltrim( $path, '/' ); }
function wp_strip_all_tags( $text ) { return strip_tags( $text ); }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
$GLOBALS['menu'] = array(
    array( 'Dashboard', 'read', 'index.php' ),
    array( 'Demo Plugin', 'manage_options', 'demo-plugin' ),
);
$GLOBALS['submenu'] = array(
    'tools.php' => array(
        array( 'Import Demo', 'import', 'demo-import' ),
    ),
);
${adminDiscoveryPhp}
`)

assert.equal(adminDiscovered.admin?.menuLoaded, true)
assert.equal(adminDiscovered.admin?.user?.id, 7)
assert.deepEqual(adminDiscovered.admin?.user?.roles, ["administrator"])
const dashboardPage = adminDiscovered.admin?.pages.find((page) => page.menuSlug === "index.php")
assert.equal(dashboardPage?.canonicalUrl, "https://example.com/wp-admin/index.php")
assert.equal(dashboardPage?.canAccess, true)
const pluginPage = adminDiscovered.admin?.pages.find((page) => page.menuSlug === "demo-plugin")
assert.equal(pluginPage?.canonicalUrl, "https://example.com/wp-admin/admin.php?page=demo-plugin")
assert.equal(pluginPage?.canAccess, true)
const importPage = adminDiscovered.admin?.pages.find((page) => page.menuSlug === "demo-import")
assert.equal(importPage?.canonicalUrl, "https://example.com/wp-admin/tools.php?page=demo-import")
assert.equal(importPage?.canAccess, false)

const adminActionInventoryPhp = runtimeAdminActionInventoryPhpCode(5).replace(/^<\?php\n/, "")
const adminActionsDiscovered = await runPhpJson<WordPressAdminActionInventory>(`
class WP_User {
    public $ID = 7;
    public $roles = array( 'administrator' );
}
function is_user_logged_in() { return true; }
function wp_get_current_user() { return new WP_User(); }
function current_user_can( $capability ) { return $capability === 'manage_options'; }
function admin_url( $path = '' ) { return 'https://example.com/wp-admin/' . ltrim( $path, '/' ); }
function home_url( $path = '' ) { return 'https://example.com/' . ltrim( $path, '/' ); }
function wp_strip_all_tags( $text ) { return strip_tags( $text ); }
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) { $GLOBALS['wp_codebox_actions'][$hook][] = $callback; }
function do_action( $hook, ...$args ) {
    foreach ( (array) ( $GLOBALS['wp_codebox_actions'][$hook] ?? array() ) as $callback ) {
        $callback( ...$args );
    }
}
$GLOBALS['menu'] = array(
    array( 'Demo Plugin', 'manage_options', 'demo-plugin' ),
);
$GLOBALS['submenu'] = array();
add_action( 'demo-plugin', static function() {
    ?>
    <form id="demo-form" method="post" action="admin-post.php?token=secret-token">
        <input type="hidden" name="action" value="demo_save" />
        <input type="hidden" name="_wpnonce" value="secret-nonce" />
        <input type="text" name="title" value="Sensitive title" />
        <select name="mode"><option value="draft">Draft</option><option value="publish">Publish</option></select>
        <textarea name="notes">private notes</textarea>
        <select name="action2"><option value="-1">Bulk actions</option><option value="delete">Delete</option><option value="export">Export</option></select>
        <button type="submit" name="submit" value="save">Save</button>
    </form>
    <?php
} );
${adminActionInventoryPhp}
`)

assert.equal(adminActionsDiscovered.schema, WORDPRESS_ADMIN_ACTION_INVENTORY_SCHEMA)
assert.equal(adminActionsDiscovered.command, "wordpress.admin-action-inventory")
assert.equal(adminActionsDiscovered.status, "ok")
assert.equal(adminActionsDiscovered.redaction.samplePayloadValues, "redacted")
const discoveredAdminAction = adminActionsDiscovered.actions[0]
assert.equal(discoveredAdminAction?.kind, "form")
assert.equal(discoveredAdminAction?.method, "POST")
assert.equal(discoveredAdminAction?.actionFamily, "admin-post")
assert.equal(discoveredAdminAction?.actionUrl, "https://example.com/wp-admin/admin-post.php?token=[redacted]")
assert.equal(discoveredAdminAction?.nonceField, "_wpnonce")
assert.equal(discoveredAdminAction?.samplePayload?.title, "[redacted]")
assert.equal(discoveredAdminAction?.samplePayload?._wpnonce, "[redacted]")
assert.deepEqual(discoveredAdminAction?.bulkActions, [{ controlName: "action2", actions: ["delete", "export"] }])
assert.equal(discoveredAdminAction?.inputs?.some((input) => input.name === "mode" && input.tag === "select" && input.options?.includes("publish")), true)
assert.deepEqual(discoveredAdminAction?.submitButtons?.[0], { name: "submit", valuePresent: true, valueRedacted: true, label: "Save" })
assert.equal(adminActionsDiscovered.pages[0]?.forms[0]?.id, discoveredAdminAction?.id)

const blockDiscoveryPhp = runtimeDiscoveryPhpCode(["blocks"]).replace(/^<\?php\n/, "")
const blocksDiscovered = await runPhpJson<WordPressRuntimeDiscoveryResult>(`
function wp_json_encode( $data, $flags = 0 ) { return json_encode( $data, $flags ); }
function admin_url( $path = '' ) { return 'https://example.com/wp-admin/' . ltrim( $path, '/' ); }
function get_post_types( $args, $output ) {
    return array( 'post' => (object) array( 'label' => 'Posts', 'rest_base' => 'posts' ) );
}
class WP_Block_Type_Registry {
    public static function get_instance() { return new self(); }
    public function get_all_registered() {
        return array(
            'demo/card' => (object) array(
                'title' => 'Card',
                'category' => 'widgets',
                'supports' => array( 'inserter' => true ),
                'attributes' => array(
                    'title' => array( 'type' => 'string', 'default' => 'Hello' ),
                    'tone' => array( 'type' => 'string', 'enum' => array( 'light', 'dark' ) ),
                ),
                'example' => array( 'attributes' => array( 'title' => 'Example title' ) ),
            ),
        );
    }
}
${blockDiscoveryPhp}
`)

const block = blocksDiscovered.blocks?.blocks[0]
assert.equal(block?.name, "demo/card")
assert.deepEqual(block?.attributes[0], { name: "title", type: "string", defaultPresent: true, default: "Hello" })
assert.deepEqual(block?.attributes[1], { name: "tone", type: "string", enum: ["light", "dark"] })
assert.deepEqual(block?.exampleAttributes, { title: "Example title" })

console.log("wordpress runtime discovery contracts ok")
