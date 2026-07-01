import { argValue, jsonObjectArg, positiveIntegerArg } from "./command-args.js"
import { wordpressFixtureUserPhpCode, type WordPressUserSessionResolution } from "./wordpress-user-sessions.js"

export interface CacheChurnObservationInput {
  method: string
  path: string
  params: Record<string, unknown>
  sampleLimit: number
  correlation: {
    caseId?: string
    actionId?: string
    correlationId?: string
  }
  userSession?: WordPressUserSessionResolution
}

export function cacheChurnObservationInputFromArgs(args: string[]): CacheChurnObservationInput {
  const path = argValue(args, "path")?.trim() || argValue(args, "route")?.trim()
  if (!path) {
    throw new Error("wordpress.cache-churn-observation requires path=<rest-route>")
  }

  return {
    method: (argValue(args, "method")?.trim() || "GET").toUpperCase(),
    path,
    params: jsonObjectArg(args, "params-json"),
    sampleLimit: positiveIntegerArg(args, "sample-limit", 100),
    correlation: {
      caseId: argValue(args, "case-id")?.trim() || undefined,
      actionId: argValue(args, "action-id")?.trim() || undefined,
      correlationId: argValue(args, "correlation-id")?.trim() || undefined,
    },
  }
}

export function cacheChurnObservationPhpCode(input: CacheChurnObservationInput): string {
  const userSessionMetadata = input.userSession?.metadata
  return `define( 'REST_REQUEST', true );
$wp_codebox_cache_churn_started_at = gmdate( 'Y-m-d\\TH:i:s.v\\Z' );
$wp_codebox_cache_churn_method = ${JSON.stringify(input.method)};
$wp_codebox_cache_churn_path = ${JSON.stringify(input.path)};
$wp_codebox_cache_churn_params = json_decode( ${JSON.stringify(JSON.stringify(input.params))}, true );
$wp_codebox_cache_churn_sample_limit = ${input.sampleLimit};
$wp_codebox_cache_churn_correlation = json_decode( ${JSON.stringify(JSON.stringify(input.correlation))}, true );
$wp_codebox_cache_churn_user_session = json_decode( ${JSON.stringify(JSON.stringify(userSessionMetadata ?? null))}, true );

if ( ! class_exists( 'WP_REST_Request' ) || ! function_exists( 'rest_do_request' ) ) {
    throw new RuntimeException( 'The WordPress REST API is not available in this runtime.' );
}

${input.userSession ? wordpressFixtureUserPhpCode(input.userSession.user) : ""}

$wp_codebox_cache_churn_empty_counts = static function () {
    return array( 'get' => 0, 'set' => 0, 'delete' => 0 );
};
$wp_codebox_cache_churn_transients = array();
$wp_codebox_cache_churn_site_transients = array();
$wp_codebox_cache_churn_options = array();
$wp_codebox_cache_churn_truncated = array( 'transients' => false, 'siteTransients' => false, 'options' => false, 'autoload' => false );
$wp_codebox_cache_churn_autoload_before = function_exists( 'wp_load_alloptions' ) ? array_keys( (array) wp_load_alloptions() ) : array();

$wp_codebox_cache_churn_record_name = static function ( &$bucket, $name, $operation ) use ( $wp_codebox_cache_churn_empty_counts, &$wp_codebox_cache_churn_truncated, $wp_codebox_cache_churn_sample_limit ) {
    $name = substr( preg_replace( '#[^A-Za-z0-9_\.\-:/]#', '', (string) $name ), 0, 191 );
    if ( '' === $name ) {
        return;
    }
    if ( ! isset( $bucket['__wp_codebox_totals__'] ) ) {
        $bucket['__wp_codebox_totals__'] = $wp_codebox_cache_churn_empty_counts();
    }
    $bucket['__wp_codebox_totals__'][ $operation ] = (int) ( $bucket['__wp_codebox_totals__'][ $operation ] ?? 0 ) + 1;
    if ( ! isset( $bucket[ $name ] ) ) {
        if ( count( $bucket ) - 1 >= max( 1, $wp_codebox_cache_churn_sample_limit ) ) {
            return;
        }
        $bucket[ $name ] = $wp_codebox_cache_churn_empty_counts();
    }
    if ( isset( $bucket[ $name ][ $operation ] ) ) {
        ++$bucket[ $name ][ $operation ];
    }
};
$wp_codebox_cache_churn_record_option = static function ( $name, $operation ) use ( &$wp_codebox_cache_churn_options, $wp_codebox_cache_churn_record_name ) {
    $wp_codebox_cache_churn_record_name( $wp_codebox_cache_churn_options, $name, 'add' === $operation || 'update' === $operation ? 'set' : $operation );
    if ( ( 'add' === $operation || 'update' === $operation ) && isset( $wp_codebox_cache_churn_options[ $name ] ) ) {
        $wp_codebox_cache_churn_options[ $name ][ $operation ] = (int) ( $wp_codebox_cache_churn_options[ $name ][ $operation ] ?? 0 ) + 1;
        $wp_codebox_cache_churn_options['__wp_codebox_totals__'][ $operation ] = (int) ( $wp_codebox_cache_churn_options['__wp_codebox_totals__'][ $operation ] ?? 0 ) + 1;
    }
};
$wp_codebox_cache_churn_all_hook = static function () use ( &$wp_codebox_cache_churn_transients, &$wp_codebox_cache_churn_site_transients, $wp_codebox_cache_churn_record_name ) {
    if ( ! function_exists( 'current_filter' ) ) {
        return;
    }
    $hook = (string) current_filter();
    $map = array(
        'pre_transient_' => array( &$wp_codebox_cache_churn_transients, 'get' ),
        'transient_' => array( &$wp_codebox_cache_churn_transients, 'get' ),
        'set_transient_' => array( &$wp_codebox_cache_churn_transients, 'set' ),
        'delete_transient_' => array( &$wp_codebox_cache_churn_transients, 'delete' ),
        'pre_site_transient_' => array( &$wp_codebox_cache_churn_site_transients, 'get' ),
        'site_transient_' => array( &$wp_codebox_cache_churn_site_transients, 'get' ),
        'set_site_transient_' => array( &$wp_codebox_cache_churn_site_transients, 'set' ),
        'delete_site_transient_' => array( &$wp_codebox_cache_churn_site_transients, 'delete' ),
    );
    foreach ( $map as $prefix => &$target ) {
        if ( 0 === strpos( $hook, $prefix ) ) {
            $wp_codebox_cache_churn_record_name( $target[0], substr( $hook, strlen( $prefix ) ), $target[1] );
            return;
        }
    }
    if ( 0 === strpos( $hook, 'option_' ) ) {
        $GLOBALS['wp_codebox_cache_churn_record_option']( substr( $hook, strlen( 'option_' ) ), 'get' );
    }
};
$GLOBALS['wp_codebox_cache_churn_record_option'] = $wp_codebox_cache_churn_record_option;

if ( function_exists( 'add_filter' ) ) {
    add_filter( 'all', $wp_codebox_cache_churn_all_hook, PHP_INT_MIN, 99 );
}
if ( function_exists( 'add_action' ) ) {
    add_action( 'added_option', static function ( $option ) use ( $wp_codebox_cache_churn_record_option ) { $wp_codebox_cache_churn_record_option( $option, 'add' ); }, PHP_INT_MIN, 1 );
    add_action( 'updated_option', static function ( $option ) use ( $wp_codebox_cache_churn_record_option ) { $wp_codebox_cache_churn_record_option( $option, 'update' ); }, PHP_INT_MIN, 1 );
    add_action( 'deleted_option', static function ( $option ) use ( $wp_codebox_cache_churn_record_option ) { $wp_codebox_cache_churn_record_option( $option, 'delete' ); }, PHP_INT_MIN, 1 );
}

$wp_codebox_cache_churn_route_path = (string) ( parse_url( $wp_codebox_cache_churn_path, PHP_URL_PATH ) ?: $wp_codebox_cache_churn_path );
$wp_codebox_cache_churn_route = '/' . ltrim( preg_replace( '#^/wp-json#', '', $wp_codebox_cache_churn_route_path ), '/' );
$wp_codebox_cache_churn_request = new WP_REST_Request( $wp_codebox_cache_churn_method, $wp_codebox_cache_churn_route );
foreach ( is_array( $wp_codebox_cache_churn_params ) ? $wp_codebox_cache_churn_params : array() as $wp_codebox_cache_churn_name => $wp_codebox_cache_churn_value ) {
    $wp_codebox_cache_churn_request->set_param( $wp_codebox_cache_churn_name, $wp_codebox_cache_churn_value );
}

$wp_codebox_cache_churn_response = rest_do_request( $wp_codebox_cache_churn_request );
$wp_codebox_cache_churn_autoload_after = function_exists( 'wp_load_alloptions' ) ? array_keys( (array) wp_load_alloptions() ) : array();

$wp_codebox_cache_churn_names = static function ( $bucket ) {
    unset( $bucket['__wp_codebox_totals__'] );
    ksort( $bucket );
    return array_values( array_map( static function ( $name, $counts ) {
        return array( 'name' => (string) $name, 'operations' => array_filter( $counts, static fn ( $value ) => 0 !== $value ) );
    }, array_keys( $bucket ), array_values( $bucket ) ) );
};
$wp_codebox_cache_churn_counts = static function ( $bucket ) {
    $counts = array( 'get' => 0, 'set' => 0, 'delete' => 0, 'add' => 0, 'update' => 0 );
    if ( isset( $bucket['__wp_codebox_totals__'] ) && is_array( $bucket['__wp_codebox_totals__'] ) ) {
        foreach ( $counts as $operation => $count ) {
            $counts[ $operation ] = (int) ( $bucket['__wp_codebox_totals__'][ $operation ] ?? 0 );
        }
        return array_filter( $counts, static fn ( $value ) => 0 !== $value );
    }
    foreach ( $bucket as $row ) {
        foreach ( $counts as $operation => $count ) {
            $counts[ $operation ] += (int) ( $row[ $operation ] ?? 0 );
        }
    }
    return array_filter( $counts, static fn ( $value ) => 0 !== $value );
};
$wp_codebox_cache_churn_autoload_added = array_values( array_diff( $wp_codebox_cache_churn_autoload_after, $wp_codebox_cache_churn_autoload_before ) );
$wp_codebox_cache_churn_autoload_removed = array_values( array_diff( $wp_codebox_cache_churn_autoload_before, $wp_codebox_cache_churn_autoload_after ) );
$wp_codebox_cache_churn_autoload_limit = max( 1, $wp_codebox_cache_churn_sample_limit );
$wp_codebox_cache_churn_autoload_truncated = count( $wp_codebox_cache_churn_autoload_added ) > $wp_codebox_cache_churn_autoload_limit || count( $wp_codebox_cache_churn_autoload_removed ) > $wp_codebox_cache_churn_autoload_limit;

echo wp_json_encode( array(
    'schema' => 'wp-codebox/cache-churn-observation/v1',
    'artifactKind' => 'cache-churn-observation',
    'command' => 'wordpress.cache-churn-observation',
    'target' => $wp_codebox_cache_churn_route,
    'source' => 'in-process',
    'kind' => 'rest-request',
    'generatedAt' => gmdate( 'Y-m-d\\TH:i:s.v\\Z' ),
    'correlation' => array_filter( is_array( $wp_codebox_cache_churn_correlation ) ? $wp_codebox_cache_churn_correlation : array(), static fn ( $value ) => null !== $value && '' !== $value ),
    'transients' => array( 'status' => function_exists( 'add_filter' ) && function_exists( 'current_filter' ) ? 'captured' : 'unsupported', 'reason' => function_exists( 'add_filter' ) && function_exists( 'current_filter' ) ? null : 'wordpress_filter_api_unavailable', 'operations' => $wp_codebox_cache_churn_counts( $wp_codebox_cache_churn_transients ), 'names' => $wp_codebox_cache_churn_names( $wp_codebox_cache_churn_transients ) ),
    'siteTransients' => array( 'status' => function_exists( 'add_filter' ) && function_exists( 'current_filter' ) ? 'captured' : 'unsupported', 'reason' => function_exists( 'add_filter' ) && function_exists( 'current_filter' ) ? null : 'wordpress_filter_api_unavailable', 'operations' => $wp_codebox_cache_churn_counts( $wp_codebox_cache_churn_site_transients ), 'names' => $wp_codebox_cache_churn_names( $wp_codebox_cache_churn_site_transients ) ),
    'options' => array( 'status' => function_exists( 'add_filter' ) || function_exists( 'add_action' ) ? 'captured' : 'unsupported', 'reason' => function_exists( 'add_filter' ) || function_exists( 'add_action' ) ? null : 'wordpress_hook_api_unavailable', 'operations' => $wp_codebox_cache_churn_counts( $wp_codebox_cache_churn_options ), 'names' => $wp_codebox_cache_churn_names( $wp_codebox_cache_churn_options ), 'autoload' => array( 'beforeCount' => count( $wp_codebox_cache_churn_autoload_before ), 'afterCount' => count( $wp_codebox_cache_churn_autoload_after ), 'added' => array_slice( $wp_codebox_cache_churn_autoload_added, 0, $wp_codebox_cache_churn_autoload_limit ), 'removed' => array_slice( $wp_codebox_cache_churn_autoload_removed, 0, $wp_codebox_cache_churn_autoload_limit ), 'changed' => array(), 'truncated' => $wp_codebox_cache_churn_autoload_truncated ) ),
    'objectCache' => array( 'status' => 'unsupported', 'reason' => 'wp_cache_functions_do_not_emit_operation_hooks' ),
    'metadata' => array( 'runner' => 'wp-codebox/runtime-playground', 'surface' => 'rest', 'method' => $wp_codebox_cache_churn_method, 'status' => method_exists( $wp_codebox_cache_churn_response, 'get_status' ) ? (int) $wp_codebox_cache_churn_response->get_status() : null, 'startedAt' => $wp_codebox_cache_churn_started_at ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}
