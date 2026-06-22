import assert from "node:assert/strict"

import {
  WORDPRESS_ADMIN_PAGE_INVENTORY_SCHEMA,
  WORDPRESS_FRONTEND_URL_INVENTORY_SCHEMA,
  WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
  WORDPRESS_REST_MATRIX_SCHEMA,
  WORDPRESS_REST_ROUTE_INVENTORY_SCHEMA,
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  type WordPressAdminPageInventory,
  type WordPressFrontendUrlInventory,
  type WordPressRestRouteInventory,
  type WordPressRuntimeDiscoveryResult,
} from "../packages/runtime-core/src/index.js"
import { runtimeContractManifest } from "../packages/runtime-core/src/public.js"
import { getCommandDefinition, runtimeCommandDefinitions } from "../packages/runtime-core/src/command-registry.js"
import { runtimeDiscoveryPhpCode, runtimeDiscoverySurfacesFromArgs } from "../packages/runtime-playground/src/runtime-discovery-command-handlers.js"
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
