import assert from "node:assert/strict"

import {
  WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  WORDPRESS_DATABASE_INVENTORY_SCHEMA,
  WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
  WORDPRESS_REST_MATRIX_SCHEMA,
  WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  type WordPressAdminPageInventory,
  type WordPressDatabaseInventory,
  type WordPressFrontendUrlInventory,
  type WordPressRestRouteInventory,
  type WordPressRuntimeDiscoveryResult,
} from "../packages/runtime-core/src/index.js"
import { runtimeContractManifest } from "../packages/runtime-core/src/public.js"
import { getCommandDefinition, runtimeCommandDefinitions } from "../packages/runtime-core/src/command-registry.js"
import { runtimeDiscoveryPhpCode, runtimeDiscoverySurfacesFromArgs, runtimeInventoryPhpCode } from "../packages/runtime-playground/src/runtime-discovery-command-handlers.js"
import { runPhpJson } from "../scripts/test-kit.js"

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

assert.equal(restInventory.schema, "wp-codebox/wordpress-rest-route-inventory/v1")
assert.equal(adminInventory.schema, "wp-codebox/wordpress-admin-page-inventory/v1")
assert.equal(databaseInventory.schema, "wp-codebox/wordpress-db-inventory/v1")
assert.equal(frontendInventory.schema, "wp-codebox/wordpress-frontend-url-inventory/v1")

const inventoryDefinitions = [
  ["wordpress.rest-route-inventory", "runRestRouteInventory", WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA],
  ["wordpress.inventory-rest-routes", "runRestRouteInventory", WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA],
  ["wordpress.admin-page-inventory", "runAdminPageInventory", WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA],
  ["wordpress.inventory-database", "runDatabaseInventory", WORDPRESS_DATABASE_INVENTORY_SCHEMA],
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
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.databaseInventory, WORDPRESS_DATABASE_INVENTORY_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntimeDiscovery.frontendUrlInventory, WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA)
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

console.log("wordpress runtime discovery contracts ok")
