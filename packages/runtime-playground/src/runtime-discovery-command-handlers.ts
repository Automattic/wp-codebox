import { commaListArg } from "./command-args.js"

export type RuntimeDiscoverySurface = "rest" | "admin" | "database" | "frontend" | "blocks" | "auth"
export type RuntimeInventorySurface = "rest" | "admin" | "database" | "frontend"

const runtimeDiscoverySurfaces = ["rest", "admin", "database", "frontend", "blocks", "auth"] as const satisfies readonly RuntimeDiscoverySurface[]

export function runtimeDiscoverySurfacesFromArgs(args: string[]): RuntimeDiscoverySurface[] {
  const requested = commaListArg(args, "surface")
  if (requested.length === 0) {
    return [...runtimeDiscoverySurfaces]
  }

  const unsupported = requested.filter((surface) => !runtimeDiscoverySurfaces.includes(surface as RuntimeDiscoverySurface))
  if (unsupported.length > 0) {
    throw new Error(`wordpress.runtime-discovery surface must be one of ${runtimeDiscoverySurfaces.join(", ")}; unsupported: ${unsupported.join(", ")}`)
  }

  return [...new Set(requested)] as RuntimeDiscoverySurface[]
}

export function runtimeDiscoveryPhpCode(surfaces: RuntimeDiscoverySurface[]): string {
  return `<?php
$runtime_discovery_surfaces = json_decode(base64_decode('${Buffer.from(JSON.stringify(surfaces), "utf8").toString("base64")}'), true);
if (!is_array($runtime_discovery_surfaces)) {
    throw new RuntimeException('wordpress.runtime-discovery received invalid surfaces.');
}

function runtime_discovery_diagnostic(string $surface, string $code, string $message, $data = null): array {
    $diagnostic = array('surface' => $surface, 'code' => $code, 'message' => $message);
    if ($data !== null) {
        $diagnostic['data'] = $data;
    }
    return $diagnostic;
}

function runtime_discovery_rest(): array {
    if (!function_exists('rest_get_server')) {
        return array(
            'payload' => array('schema' => 'wp-codebox/wordpress-rest-route-discovery/v1', 'routes' => array(), 'namespaces' => array()),
            'diagnostics' => array(runtime_discovery_diagnostic('rest', 'rest-api-unavailable', 'The WordPress REST API server is unavailable.')),
        );
    }

    $routes = rest_get_server()->get_routes();
    $items = array();
    $namespaces = array();
    foreach ($routes as $route => $handlers) {
        $methods = array();
        $arg_names = array();
        $endpoints = array();
        foreach ((array) $handlers as $handler) {
            if (!is_array($handler)) {
                continue;
            }
            $endpoint_methods = runtime_discovery_rest_methods($handler['methods'] ?? array());
            $endpoint_args = array();
            foreach ((array) ($handler['args'] ?? array()) as $arg_name => $arg_schema) {
                $arg_names[] = (string) $arg_name;
                $endpoint_args[] = runtime_discovery_rest_arg((string) $arg_name, is_array($arg_schema) ? $arg_schema : array());
            }
            $methods = array_merge($methods, $endpoint_methods);
            $endpoints[] = array(
                'methods' => $endpoint_methods,
                'permission' => runtime_discovery_rest_permission($handler),
                'args' => $endpoint_args,
            );
        }
        $namespace = trim(explode('/', trim((string) $route, '/'))[0] ?? '', '/');
        if ($namespace !== '') {
            $namespaces[] = $namespace;
        }
        $route_item = array('route' => (string) $route, 'namespace' => $namespace, 'methods' => array_values(array_unique($methods)), 'argNames' => array_values(array_unique($arg_names)), 'endpoints' => $endpoints);
        $route_schema = runtime_discovery_rest_schema((array) $handlers);
        if (!empty($route_schema)) {
            $route_item['schema'] = $route_schema;
        }
        $items[] = $route_item;
    }

    return array('payload' => array('schema' => 'wp-codebox/wordpress-rest-route-discovery/v1', 'routes' => $items, 'namespaces' => array_values(array_unique($namespaces))), 'diagnostics' => array());
}

function runtime_discovery_rest_methods($methods): array {
    if (is_string($methods)) {
        return array_values(array_filter(array_map('trim', explode(',', strtoupper($methods)))));
    }
    $keys = array_keys((array) $methods);
    $values = array_values((array) $methods);
    $raw = array_merge($keys, $values);
    $normalized = array();
    foreach ($raw as $method) {
        if (is_string($method) && $method !== '' && strtoupper($method) === $method) {
            $normalized[] = $method;
        }
    }
    return array_values(array_unique($normalized));
}

function runtime_discovery_rest_permission(array $handler): array {
    if (!array_key_exists('permission_callback', $handler)) {
        return array('mode' => 'none');
    }
    $callback = $handler['permission_callback'];
    if ($callback === '__return_true') {
        return array('mode' => 'public', 'callbackType' => 'function');
    }
    return array('mode' => 'callback', 'callbackType' => runtime_discovery_callback_type($callback));
}

function runtime_discovery_callback_type($callback): string {
    if (is_string($callback)) {
        return 'function';
    }
    if (is_array($callback)) {
        return 'method';
    }
    if ($callback instanceof Closure) {
        return 'closure';
    }
    if (is_object($callback) && is_callable($callback)) {
        return 'invokable';
    }
    return is_callable($callback) ? 'callable' : 'unknown';
}

function runtime_discovery_rest_arg(string $name, array $schema): array {
    $arg = array('name' => $name, 'required' => !empty($schema['required']));
    foreach (array('type', 'format') as $key) {
        if (isset($schema[$key]) && (is_string($schema[$key]) || is_array($schema[$key]))) {
            $arg[$key] = $schema[$key];
        }
    }
    if (isset($schema['enum']) && is_array($schema['enum'])) {
        $arg['enum'] = array_slice(array_values($schema['enum']), 0, 25);
    }
    if (isset($schema['description']) && is_string($schema['description'])) {
        $arg['description'] = substr(wp_strip_all_tags($schema['description']), 0, 240);
    }
    $arg['defaultPresent'] = array_key_exists('default', $schema);
    $arg['validateCallback'] = array_key_exists('validate_callback', $schema);
    $arg['sanitizeCallback'] = array_key_exists('sanitize_callback', $schema);
    return $arg;
}

function runtime_discovery_rest_schema(array $handlers): array {
    foreach ($handlers as $handler) {
        if (!is_array($handler) || !isset($handler['schema']) || !is_array($handler['schema'])) {
            continue;
        }
        $schema = $handler['schema'];
        $descriptor = array();
        foreach (array('title', 'type') as $key) {
            if (isset($schema[$key]) && (is_string($schema[$key]) || is_array($schema[$key]))) {
                $descriptor[$key] = $schema[$key];
            }
        }
        if (isset($schema['properties']) && is_array($schema['properties'])) {
            $descriptor['properties'] = array_slice(array_values(array_map('strval', array_keys($schema['properties']))), 0, 100);
        }
        return $descriptor;
    }
    return array();
}

function runtime_discovery_admin(): array {
    $pages = array();
    $diagnostics = array();
    if ((!isset($GLOBALS['menu']) || !is_array($GLOBALS['menu'])) && is_user_logged_in()) {
        if (!defined('WP_ADMIN')) {
            define('WP_ADMIN', true);
        }
        if (defined('ABSPATH') && file_exists(ABSPATH . 'wp-admin/includes/admin.php')) {
            require_once ABSPATH . 'wp-admin/includes/admin.php';
        }
        if (defined('ABSPATH') && file_exists(ABSPATH . 'wp-admin/menu.php')) {
            require_once ABSPATH . 'wp-admin/menu.php';
        }
    }
    $menu_loaded = isset($GLOBALS['menu']) && is_array($GLOBALS['menu']);
    if (!$menu_loaded) {
        $diagnostics[] = runtime_discovery_diagnostic('admin', 'admin-menu-not-loaded', 'The admin menu globals are not populated in this request context.');
    }

    $current_user = function_exists('wp_get_current_user') ? wp_get_current_user() : null;
    $user_context = array(
        'isLoggedIn' => function_exists('is_user_logged_in') ? is_user_logged_in() : false,
        'id' => is_object($current_user) && isset($current_user->ID) ? (int) $current_user->ID : 0,
        'roles' => is_object($current_user) && isset($current_user->roles) ? array_values(array_map('strval', (array) $current_user->roles)) : array(),
    );

    foreach ((array) ($GLOBALS['menu'] ?? array()) as $item) {
        if (!is_array($item)) {
            continue;
        }
        $pages[] = runtime_discovery_admin_page((string) ($item[2] ?? ''), (string) ($item[0] ?? ''), (string) ($item[1] ?? ''));
    }
    foreach ((array) ($GLOBALS['submenu'] ?? array()) as $parent_slug => $items) {
        foreach ((array) $items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $pages[] = runtime_discovery_admin_page((string) ($item[2] ?? ''), (string) ($item[0] ?? ''), (string) ($item[1] ?? ''), (string) $parent_slug);
        }
    }

    return array('payload' => array('schema' => 'wp-codebox/wordpress-admin-page-discovery/v1', 'adminUrl' => admin_url(), 'menuLoaded' => $menu_loaded, 'user' => $user_context, 'pages' => $pages), 'diagnostics' => $diagnostics);
}

function runtime_discovery_admin_page(string $menu_slug, string $title, string $capability, string $parent_slug = ''): array {
    $page = array(
        'menuSlug' => $menu_slug,
        'pageTitle' => wp_strip_all_tags($title),
        'menuTitle' => wp_strip_all_tags($title),
        'capability' => $capability,
        'canAccess' => $capability === '' ? null : current_user_can($capability),
        'canonicalUrl' => runtime_discovery_admin_page_url($menu_slug, $parent_slug),
    );
    if ($parent_slug !== '') {
        $page['parentSlug'] = $parent_slug;
    }
    return $page;
}

function runtime_discovery_admin_page_url(string $menu_slug, string $parent_slug = ''): string {
    if ($menu_slug === '') {
        return admin_url();
    }
    if (strpos($menu_slug, '.php') !== false) {
        return admin_url($menu_slug);
    }
    if ($parent_slug !== '' && strpos($parent_slug, '.php') !== false) {
        return admin_url($parent_slug . '?page=' . rawurlencode($menu_slug));
    }
    return admin_url('admin.php?page=' . rawurlencode($menu_slug));
}

function runtime_discovery_database(): array {
    global $wpdb;
    $tables = array();
    $core_tables = array_values(array_unique(array_map('strval', $wpdb->tables('all'))));
    $core_names = array();
    foreach ($core_tables as $base_name) {
        $core_names[$wpdb->prefix . $base_name] = $base_name;
    }
    $table_names = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($wpdb->prefix) . '%'));
    foreach ((array) $table_names as $name) {
        $name = (string) $name;
        $base_name = isset($core_names[$name]) ? $core_names[$name] : (str_starts_with($name, $wpdb->prefix) ? substr($name, strlen($wpdb->prefix)) : $name);
        $columns = array();
        $quoted_name = runtime_discovery_sql_identifier($name);
        $described = $wpdb->get_results('DESCRIBE ' . $quoted_name, ARRAY_A);
        foreach ((array) $described as $column) {
            $columns[] = array('name' => (string) ($column['Field'] ?? ''), 'type' => (string) ($column['Type'] ?? ''), 'nullable' => strtoupper((string) ($column['Null'] ?? '')) === 'YES', 'key' => (string) ($column['Key'] ?? ''), 'default' => array_key_exists('Default', $column) && $column['Default'] !== null ? (string) $column['Default'] : null, 'extra' => (string) ($column['Extra'] ?? ''));
        }
        $indexes = array();
        foreach ((array) $wpdb->get_results('SHOW INDEX FROM ' . $quoted_name, ARRAY_A) as $index) {
            $indexes[] = array('name' => (string) ($index['Key_name'] ?? ''), 'column' => (string) ($index['Column_name'] ?? ''), 'unique' => isset($index['Non_unique']) ? ((int) $index['Non_unique'] === 0) : false, 'sequence' => isset($index['Seq_in_index']) ? (int) $index['Seq_in_index'] : null);
        }
        $status_rows = $wpdb->get_results($wpdb->prepare('SHOW TABLE STATUS LIKE %s', $name), ARRAY_A);
        $status = is_array($status_rows) && isset($status_rows[0]) ? array('engine' => isset($status_rows[0]['Engine']) ? (string) $status_rows[0]['Engine'] : '', 'rows' => isset($status_rows[0]['Rows']) ? (int) $status_rows[0]['Rows'] : null, 'collation' => isset($status_rows[0]['Collation']) ? (string) $status_rows[0]['Collation'] : '', 'dataBytes' => isset($status_rows[0]['Data_length']) ? (int) $status_rows[0]['Data_length'] : 0, 'indexBytes' => isset($status_rows[0]['Index_length']) ? (int) $status_rows[0]['Index_length'] : 0, 'totalBytes' => (isset($status_rows[0]['Data_length']) ? (int) $status_rows[0]['Data_length'] : 0) + (isset($status_rows[0]['Index_length']) ? (int) $status_rows[0]['Index_length'] : 0)) : null;
        $tables[] = array('name' => $name, 'baseName' => $base_name, 'classification' => isset($core_names[$name]) ? 'core' : (str_starts_with($name, $wpdb->prefix) ? 'prefixed' : 'external'), 'columns' => $columns, 'indexes' => $indexes, 'status' => $status);
    }
    return array('payload' => array('schema' => 'wp-codebox/wordpress-db-schema-discovery/v1', 'prefix' => $wpdb->prefix, 'tables' => $tables), 'diagnostics' => array());
}

function runtime_discovery_sql_identifier(string $name): string {
    return chr(96) . str_replace(chr(96), chr(96) . chr(96), $name) . chr(96);
}

function runtime_discovery_frontend(): array {
    global $wp_rewrite, $wp;
    $rules = is_object($wp_rewrite) ? $wp_rewrite->wp_rewrite_rules() : array();
    $items = array();
    foreach ((array) $rules as $pattern => $query) {
        $items[] = array('pattern' => (string) $pattern, 'query' => (string) $query);
    }
    return array('payload' => array('schema' => 'wp-codebox/wordpress-frontend-route-discovery/v1', 'homeUrl' => home_url('/'), 'permalinkStructure' => (string) get_option('permalink_structure', ''), 'rewriteRules' => $items, 'publicQueryVars' => array_values(array_map('strval', (array) ($wp->public_query_vars ?? array())))), 'diagnostics' => array());
}

function runtime_discovery_blocks(): array {
    $blocks = array();
    if (class_exists('WP_Block_Type_Registry')) {
        foreach (WP_Block_Type_Registry::get_instance()->get_all_registered() as $name => $block_type) {
            $supports = is_object($block_type) && is_array($block_type->supports ?? null) ? $block_type->supports : array();
            $attributes = array();
            foreach ((array) ($block_type->attributes ?? array()) as $attribute_name => $attribute_schema) {
                $attribute_schema = is_array($attribute_schema) ? $attribute_schema : array();
                $descriptor = array('name' => (string) $attribute_name);
                if (isset($attribute_schema['type'])) {
                    $descriptor['type'] = is_array($attribute_schema['type']) ? array_values(array_map('strval', $attribute_schema['type'])) : (string) $attribute_schema['type'];
                }
                if (isset($attribute_schema['enum']) && is_array($attribute_schema['enum'])) {
                    $descriptor['enum'] = array_map('runtime_discovery_block_attribute_value', array_slice(array_values($attribute_schema['enum']), 0, 25));
                }
                if (array_key_exists('default', $attribute_schema)) {
                    $descriptor['defaultPresent'] = true;
                    $descriptor['default'] = runtime_discovery_block_attribute_value($attribute_schema['default']);
                }
                $attributes[] = $descriptor;
            }

            $example_attributes = null;
            if (isset($block_type->example) && is_array($block_type->example) && isset($block_type->example['attributes']) && is_array($block_type->example['attributes'])) {
                $example_attributes = $block_type->example['attributes'];
            }

            $descriptor = array('name' => (string) $name, 'title' => (string) ($block_type->title ?? ''), 'category' => (string) ($block_type->category ?? ''), 'supportsInserter' => !isset($supports['inserter']) || $supports['inserter'] !== false, 'attributes' => $attributes);
            if ($example_attributes !== null) {
                $descriptor['exampleAttributes'] = runtime_discovery_block_attribute_value($example_attributes);
            }
            $blocks[] = $descriptor;
        }
    }

    $post_types = array();
    foreach (get_post_types(array('show_ui' => true), 'objects') as $name => $post_type) {
        $rest_base = (string) ($post_type->rest_base ?: $name);
        $post_types[] = array('name' => (string) $name, 'label' => (string) ($post_type->label ?? $name), 'restBase' => $rest_base, 'editorUrl' => admin_url('post-new.php?post_type=' . rawurlencode((string) $name)));
    }

    return array('payload' => array('schema' => 'wp-codebox/wordpress-block-editor-target-discovery/v1', 'blocks' => $blocks, 'editorPostTypes' => $post_types), 'diagnostics' => array());
}

function runtime_discovery_auth(): array {
    return array(
        'payload' => array(
            'schema' => 'wp-codebox/wordpress-auth-discovery/v1',
            'actions' => array(
                array(
                    'command' => 'wordpress.session',
                    'purpose' => 'Resolve a declared fixture user or named user session and produce reviewer-safe session metadata plus optional redaction-required browser storage-state artifacts.',
                    'acceptedSelectors' => array('user', 'session'),
                    'artifactKinds' => array('browser-storage-state', 'browser-storage-state-summary'),
                    'redactionRequired' => true,
                ),
                array(
                    'command' => 'wordpress.nonce',
                    'purpose' => 'Resolve a WordPress nonce for an explicit action in the selected fixture user or session context.',
                    'acceptedSelectors' => array('action', 'user', 'session'),
                    'artifactKinds' => array('wordpress-nonce'),
                    'redactionRequired' => true,
                ),
                array(
                    'command' => 'wordpress.action-auth',
                    'purpose' => 'Resolve a fixture user/session, action nonce, REST nonce, and optional browser storage-state artifact for destructive runtime actions.',
                    'acceptedSelectors' => array('action', 'user', 'session'),
                    'artifactKinds' => array('wordpress-action-auth', 'browser-storage-state', 'browser-storage-state-summary'),
                    'redactionRequired' => true,
                ),
            ),
            'capabilities' => array(
                'fixtureUsers' => true,
                'userSessions' => true,
                'browserStorageStateArtifacts' => true,
                'restNonce' => function_exists('wp_create_nonce'),
                'actionNonce' => function_exists('wp_create_nonce'),
            ),
            'resultRedaction' => array(
                'cookies' => 'artifact-ref-only',
                'nonces' => 'redacted-in-summary',
            ),
        ),
        'diagnostics' => array(),
    );
}

function runtime_discovery_block_attribute_value($value, int $depth = 0) {
    if (is_string($value)) {
        return substr($value, 0, 200);
    }
    if (is_int($value) || is_float($value) || is_bool($value) || $value === null) {
        return $value;
    }
    if (!is_array($value) || $depth >= 2) {
        return null;
    }

    $bounded = array();
    foreach (array_slice($value, 0, 20, true) as $key => $item) {
        $bounded[$key] = runtime_discovery_block_attribute_value($item, $depth + 1);
    }
    return $bounded;
}

$runtime_discovery_result = array(
    'schema' => 'wp-codebox/wordpress-runtime-discovery/v1',
    'command' => 'wordpress.runtime-discovery',
    'status' => 'ok',
    'surfaces' => array_values($runtime_discovery_surfaces),
    'diagnostics' => array(),
);

foreach ($runtime_discovery_surfaces as $runtime_discovery_surface) {
    $collector = 'runtime_discovery_' . $runtime_discovery_surface;
    if (!function_exists($collector)) {
        $runtime_discovery_result['diagnostics'][] = runtime_discovery_diagnostic((string) $runtime_discovery_surface, 'surface-unsupported', 'The requested discovery surface is not implemented.');
        continue;
    }
    $collected = $collector();
    $runtime_discovery_result[$runtime_discovery_surface] = $collected['payload'];
    $runtime_discovery_result['diagnostics'] = array_merge($runtime_discovery_result['diagnostics'], $collected['diagnostics']);
}

echo wp_json_encode($runtime_discovery_result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

export function runtimeInventoryPhpCode(surface: RuntimeInventorySurface, command: string, schema: string): string {
  const payloadKey = surface === "rest" ? "rest" : surface
  return `<?php
${runtimeDiscoveryPhpCode([surface]).replace(/^<\?php\n/, "").replace(/echo wp_json_encode\(\$runtime_discovery_result, JSON_PRETTY_PRINT \| JSON_UNESCAPED_SLASHES\);$/, "")}

$runtime_inventory_payload = $runtime_discovery_result['${payloadKey}'] ?? null;
$runtime_inventory_diagnostics = (array) ($runtime_discovery_result['diagnostics'] ?? array());

if (!is_array($runtime_inventory_payload)) {
    echo wp_json_encode(array(
        'schema' => '${schema}',
        'command' => '${command}',
        'status' => 'unsupported',
        'diagnostics' => array_merge($runtime_inventory_diagnostics, array(runtime_discovery_diagnostic('${surface}', 'inventory-unavailable', 'The requested WordPress inventory is unavailable in this runtime context.'))),
    ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    return;
}

$runtime_inventory_result = array_merge($runtime_inventory_payload, array(
    'schema' => '${schema}',
    'command' => '${command}',
    'status' => empty($runtime_inventory_diagnostics) ? 'ok' : 'unsupported',
    'diagnostics' => $runtime_inventory_diagnostics,
));

if ('${surface}' === 'frontend') {
    $runtime_inventory_urls = array(array('url' => (string) ($runtime_inventory_payload['homeUrl'] ?? home_url('/')), 'source' => 'home'));
    foreach ((array) ($runtime_inventory_payload['rewriteRules'] ?? array()) as $runtime_inventory_rule) {
        $runtime_inventory_urls[] = array(
            'url' => home_url('/' . ltrim((string) ($runtime_inventory_rule['pattern'] ?? ''), '/')),
            'source' => 'rewrite-rule',
            'pattern' => (string) ($runtime_inventory_rule['pattern'] ?? ''),
            'query' => (string) ($runtime_inventory_rule['query'] ?? ''),
        );
    }
    $runtime_inventory_result['urls'] = $runtime_inventory_urls;
}

if ('${surface}' === 'database') {
    $runtime_inventory_tables = array();
    $runtime_inventory_totals = array('tableCount' => 0, 'rowCount' => 0, 'columnCount' => 0, 'indexCount' => 0, 'dataBytes' => 0, 'indexBytes' => 0, 'totalBytes' => 0);
    foreach ((array) ($runtime_inventory_payload['tables'] ?? array()) as $runtime_inventory_table) {
        if (!is_array($runtime_inventory_table)) {
            continue;
        }
        $runtime_inventory_status = is_array($runtime_inventory_table['status'] ?? null) ? $runtime_inventory_table['status'] : array();
        $runtime_inventory_data_bytes = isset($runtime_inventory_status['dataBytes']) ? (int) $runtime_inventory_status['dataBytes'] : 0;
        $runtime_inventory_index_bytes = isset($runtime_inventory_status['indexBytes']) ? (int) $runtime_inventory_status['indexBytes'] : 0;
        $runtime_inventory_row_count = isset($runtime_inventory_status['rows']) ? (int) $runtime_inventory_status['rows'] : 0;
        $runtime_inventory_table['engine'] = (string) ($runtime_inventory_status['engine'] ?? '');
        $runtime_inventory_table['rowCount'] = $runtime_inventory_row_count;
        $runtime_inventory_table['dataBytes'] = $runtime_inventory_data_bytes;
        $runtime_inventory_table['indexBytes'] = $runtime_inventory_index_bytes;
        $runtime_inventory_table['totalBytes'] = isset($runtime_inventory_status['totalBytes']) ? (int) $runtime_inventory_status['totalBytes'] : $runtime_inventory_data_bytes + $runtime_inventory_index_bytes;
        $runtime_inventory_tables[] = $runtime_inventory_table;
        $runtime_inventory_totals['rowCount'] += $runtime_inventory_table['rowCount'];
        $runtime_inventory_totals['columnCount'] += count((array) ($runtime_inventory_table['columns'] ?? array()));
        $runtime_inventory_totals['indexCount'] += count((array) ($runtime_inventory_table['indexes'] ?? array()));
        $runtime_inventory_totals['dataBytes'] += $runtime_inventory_table['dataBytes'];
        $runtime_inventory_totals['indexBytes'] += $runtime_inventory_table['indexBytes'];
        $runtime_inventory_totals['totalBytes'] += $runtime_inventory_table['totalBytes'];
    }
    $runtime_inventory_totals['tableCount'] = count($runtime_inventory_tables);
    $runtime_inventory_result['tables'] = $runtime_inventory_tables;
    $runtime_inventory_result['totals'] = $runtime_inventory_totals;
}

echo wp_json_encode($runtime_inventory_result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}
