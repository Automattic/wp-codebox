import { commaListArg } from "./command-args.js"

export type RuntimeDiscoverySurface = "rest" | "admin" | "database" | "frontend" | "blocks"

const runtimeDiscoverySurfaces = ["rest", "admin", "database", "frontend", "blocks"] as const satisfies readonly RuntimeDiscoverySurface[]

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
$wp_codebox_runtime_discovery_surfaces = json_decode(base64_decode('${Buffer.from(JSON.stringify(surfaces), "utf8").toString("base64")}'), true);
if (!is_array($wp_codebox_runtime_discovery_surfaces)) {
    throw new RuntimeException('wordpress.runtime-discovery received invalid surfaces.');
}

function wp_codebox_runtime_discovery_diagnostic(string $surface, string $code, string $message, $data = null): array {
    $diagnostic = array('surface' => $surface, 'code' => $code, 'message' => $message);
    if ($data !== null) {
        $diagnostic['data'] = $data;
    }
    return $diagnostic;
}

function wp_codebox_runtime_discovery_rest(): array {
    if (!function_exists('rest_get_server')) {
        return array(
            'payload' => array('schema' => 'wp-codebox/wordpress-rest-route-discovery/v1', 'routes' => array(), 'namespaces' => array()),
            'diagnostics' => array(wp_codebox_runtime_discovery_diagnostic('rest', 'rest-api-unavailable', 'The WordPress REST API server is unavailable.')),
        );
    }

    $routes = rest_get_server()->get_routes();
    $items = array();
    $namespaces = array();
    foreach ($routes as $route => $handlers) {
        $methods = array();
        $arg_names = array();
        foreach ((array) $handlers as $handler) {
            if (!is_array($handler)) {
                continue;
            }
            foreach (array_keys((array) ($handler['methods'] ?? array())) as $method) {
                $methods[] = strtoupper((string) $method);
            }
            foreach (array_keys((array) ($handler['args'] ?? array())) as $arg_name) {
                $arg_names[] = (string) $arg_name;
            }
        }
        $namespace = trim(explode('/', trim((string) $route, '/'))[0] ?? '', '/');
        if ($namespace !== '') {
            $namespaces[] = $namespace;
        }
        $items[] = array('route' => (string) $route, 'namespace' => $namespace, 'methods' => array_values(array_unique($methods)), 'argNames' => array_values(array_unique($arg_names)));
    }

    return array('payload' => array('schema' => 'wp-codebox/wordpress-rest-route-discovery/v1', 'routes' => $items, 'namespaces' => array_values(array_unique($namespaces))), 'diagnostics' => array());
}

function wp_codebox_runtime_discovery_admin(): array {
    $pages = array();
    $diagnostics = array();
    $menu_loaded = isset($GLOBALS['menu']) && is_array($GLOBALS['menu']);
    if (!$menu_loaded) {
        $diagnostics[] = wp_codebox_runtime_discovery_diagnostic('admin', 'admin-menu-not-loaded', 'The admin menu globals are not populated in this request context.');
    }

    foreach ((array) ($GLOBALS['menu'] ?? array()) as $item) {
        if (!is_array($item)) {
            continue;
        }
        $pages[] = array('menuSlug' => (string) ($item[2] ?? ''), 'pageTitle' => wp_strip_all_tags((string) ($item[0] ?? '')), 'menuTitle' => wp_strip_all_tags((string) ($item[0] ?? '')), 'capability' => (string) ($item[1] ?? ''));
    }
    foreach ((array) ($GLOBALS['submenu'] ?? array()) as $parent_slug => $items) {
        foreach ((array) $items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $pages[] = array('menuSlug' => (string) ($item[2] ?? ''), 'pageTitle' => wp_strip_all_tags((string) ($item[0] ?? '')), 'menuTitle' => wp_strip_all_tags((string) ($item[0] ?? '')), 'capability' => (string) ($item[1] ?? ''), 'parentSlug' => (string) $parent_slug);
        }
    }

    return array('payload' => array('schema' => 'wp-codebox/wordpress-admin-page-discovery/v1', 'adminUrl' => admin_url(), 'menuLoaded' => $menu_loaded, 'pages' => $pages), 'diagnostics' => $diagnostics);
}

function wp_codebox_runtime_discovery_database(): array {
    global $wpdb;
    $tables = array();
    $candidates = array_values(array_unique(array_map('strval', $wpdb->tables('all'))));
    foreach ($candidates as $base_name) {
        $name = $wpdb->prefix . $base_name;
        $columns = array();
        $described = $wpdb->get_results('DESCRIBE ' . $name, ARRAY_A);
        foreach ((array) $described as $column) {
            $columns[] = array('name' => (string) ($column['Field'] ?? ''), 'type' => (string) ($column['Type'] ?? ''), 'nullable' => strtoupper((string) ($column['Null'] ?? '')) === 'YES', 'key' => (string) ($column['Key'] ?? ''), 'default' => array_key_exists('Default', $column) && $column['Default'] !== null ? (string) $column['Default'] : null, 'extra' => (string) ($column['Extra'] ?? ''));
        }
        $tables[] = array('name' => $name, 'baseName' => $base_name, 'columns' => $columns);
    }
    return array('payload' => array('schema' => 'wp-codebox/wordpress-db-schema-discovery/v1', 'prefix' => $wpdb->prefix, 'tables' => $tables), 'diagnostics' => array());
}

function wp_codebox_runtime_discovery_frontend(): array {
    global $wp_rewrite, $wp;
    $rules = is_object($wp_rewrite) ? $wp_rewrite->wp_rewrite_rules() : array();
    $items = array();
    foreach ((array) $rules as $pattern => $query) {
        $items[] = array('pattern' => (string) $pattern, 'query' => (string) $query);
    }
    return array('payload' => array('schema' => 'wp-codebox/wordpress-frontend-route-discovery/v1', 'homeUrl' => home_url('/'), 'permalinkStructure' => (string) get_option('permalink_structure', ''), 'rewriteRules' => $items, 'publicQueryVars' => array_values(array_map('strval', (array) ($wp->public_query_vars ?? array())))), 'diagnostics' => array());
}

function wp_codebox_runtime_discovery_blocks(): array {
    $blocks = array();
    if (class_exists('WP_Block_Type_Registry')) {
        foreach (WP_Block_Type_Registry::get_instance()->get_all_registered() as $name => $block_type) {
            $supports = is_object($block_type) && is_array($block_type->supports ?? null) ? $block_type->supports : array();
            $blocks[] = array('name' => (string) $name, 'title' => (string) ($block_type->title ?? ''), 'category' => (string) ($block_type->category ?? ''), 'supportsInserter' => !isset($supports['inserter']) || $supports['inserter'] !== false, 'attributes' => array_values(array_map('strval', array_keys((array) ($block_type->attributes ?? array())))));
        }
    }

    $post_types = array();
    foreach (get_post_types(array('show_ui' => true), 'objects') as $name => $post_type) {
        $rest_base = (string) ($post_type->rest_base ?: $name);
        $post_types[] = array('name' => (string) $name, 'label' => (string) ($post_type->label ?? $name), 'restBase' => $rest_base, 'editorUrl' => admin_url('post-new.php?post_type=' . rawurlencode((string) $name)));
    }

    return array('payload' => array('schema' => 'wp-codebox/wordpress-block-editor-target-discovery/v1', 'blocks' => $blocks, 'editorPostTypes' => $post_types), 'diagnostics' => array());
}

$wp_codebox_runtime_discovery_result = array(
    'schema' => 'wp-codebox/wordpress-runtime-discovery/v1',
    'command' => 'wordpress.runtime-discovery',
    'status' => 'ok',
    'surfaces' => array_values($wp_codebox_runtime_discovery_surfaces),
    'diagnostics' => array(),
);

foreach ($wp_codebox_runtime_discovery_surfaces as $wp_codebox_runtime_discovery_surface) {
    $collector = 'wp_codebox_runtime_discovery_' . $wp_codebox_runtime_discovery_surface;
    if (!function_exists($collector)) {
        $wp_codebox_runtime_discovery_result['diagnostics'][] = wp_codebox_runtime_discovery_diagnostic((string) $wp_codebox_runtime_discovery_surface, 'surface-unsupported', 'The requested discovery surface is not implemented.');
        continue;
    }
    $collected = $collector();
    $wp_codebox_runtime_discovery_result[$wp_codebox_runtime_discovery_surface] = $collected['payload'];
    $wp_codebox_runtime_discovery_result['diagnostics'] = array_merge($wp_codebox_runtime_discovery_result['diagnostics'], $collected['diagnostics']);
}

echo wp_json_encode($wp_codebox_runtime_discovery_result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}
