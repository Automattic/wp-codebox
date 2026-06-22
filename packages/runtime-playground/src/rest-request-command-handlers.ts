import { argValue, jsonObjectArg } from "./command-args.js"
import { wordpressFixtureUserPhpCode, type WordPressUserSessionResolution } from "./wordpress-user-sessions.js"

export interface RestRequestCommandInput {
  method: string
  path: string
  headers: Record<string, unknown>
  params: Record<string, unknown>
  body: string
  userSession?: WordPressUserSessionResolution
}

export function restRequestInputFromArgs(args: string[]): RestRequestCommandInput {
  const path = argValue(args, "path")?.trim() || argValue(args, "route")?.trim()
  if (!path) {
    throw new Error("wordpress.rest-request requires path=<rest-route>")
  }

  const bodyJson = argValue(args, "body-json")
  const body = bodyJson !== undefined ? bodyJson : (argValue(args, "body") ?? "")

  return {
    method: (argValue(args, "method")?.trim() || "GET").toUpperCase(),
    path,
    headers: jsonObjectArg(args, "headers-json"),
    params: jsonObjectArg(args, "params-json"),
    body,
  }
}

export function restRequestPhpCode(input: RestRequestCommandInput): string {
  const userSessionMetadata = input.userSession?.metadata
  return `define( 'REST_REQUEST', true );
$wp_codebox_started_at = microtime( true );
$wp_codebox_observation_started_at = gmdate( 'Y-m-d\\TH:i:s.v\\Z' );
$wp_codebox_start_memory = memory_get_usage( true );
$wp_codebox_query_start = isset( $GLOBALS['wpdb']->queries ) && is_array( $GLOBALS['wpdb']->queries ) ? count( $GLOBALS['wpdb']->queries ) : 0;
$wp_codebox_method = ${JSON.stringify(input.method)};
$wp_codebox_path = ${JSON.stringify(input.path)};
$wp_codebox_headers = json_decode( ${JSON.stringify(JSON.stringify(input.headers))}, true );
$wp_codebox_params = json_decode( ${JSON.stringify(JSON.stringify(input.params))}, true );
$wp_codebox_body = ${JSON.stringify(input.body)};
$wp_codebox_user_session = json_decode( ${JSON.stringify(JSON.stringify(userSessionMetadata ?? null))}, true );

if ( ! class_exists( 'WP_REST_Request' ) || ! function_exists( 'rest_do_request' ) ) {
    throw new RuntimeException( 'The WordPress REST API is not available in this runtime.' );
}

${input.userSession ? wordpressFixtureUserPhpCode(input.userSession.user) : ""}

$wp_codebox_path_parts = parse_url( $wp_codebox_path );
if ( ! is_array( $wp_codebox_path_parts ) ) {
    throw new RuntimeException( 'wordpress.rest-request received an invalid REST path.' );
}

$wp_codebox_route_path = (string) ( $wp_codebox_path_parts['path'] ?? $wp_codebox_path );
$wp_codebox_route = '/' . ltrim( preg_replace( '#^/wp-json#', '', $wp_codebox_route_path ), '/' );
$wp_codebox_request = new WP_REST_Request( $wp_codebox_method, $wp_codebox_route );

foreach ( $wp_codebox_headers as $wp_codebox_name => $wp_codebox_value ) {
    $wp_codebox_request->set_header( $wp_codebox_name, $wp_codebox_value );
}

foreach ( $wp_codebox_params as $wp_codebox_name => $wp_codebox_value ) {
    $wp_codebox_request->set_param( $wp_codebox_name, $wp_codebox_value );
}

if ( isset( $wp_codebox_path_parts['query'] ) ) {
    parse_str( (string) $wp_codebox_path_parts['query'], $wp_codebox_query_params );
    foreach ( $wp_codebox_query_params as $wp_codebox_name => $wp_codebox_value ) {
        if ( ! $wp_codebox_request->has_param( $wp_codebox_name ) ) {
            $wp_codebox_request->set_param( $wp_codebox_name, $wp_codebox_value );
        }
    }
}

if ( $wp_codebox_body !== '' ) {
    $wp_codebox_request->set_body( $wp_codebox_body );
}

$wp_codebox_response = rest_do_request( $wp_codebox_request );
$wp_codebox_server = rest_get_server();
$wp_codebox_data = $wp_codebox_server->response_to_data( $wp_codebox_response, false );
$wp_codebox_finished_at = microtime( true );
$wp_codebox_observation_finished_at = gmdate( 'Y-m-d\\TH:i:s.v\\Z' );
$wp_codebox_end_memory = memory_get_usage( true );
$wp_codebox_queries = array();
$wp_codebox_query_count = 0;
$wp_codebox_query_total_ms = 0.0;
if ( isset( $GLOBALS['wpdb']->queries ) && is_array( $GLOBALS['wpdb']->queries ) ) {
    foreach ( array_slice( $GLOBALS['wpdb']->queries, $wp_codebox_query_start ) as $wp_codebox_query ) {
        $wp_codebox_sql = is_array( $wp_codebox_query ) && isset( $wp_codebox_query[0] ) ? (string) $wp_codebox_query[0] : '';
        if ( '' === $wp_codebox_sql ) {
            continue;
        }
        $wp_codebox_query_count++;
        $wp_codebox_elapsed_ms = is_array( $wp_codebox_query ) && isset( $wp_codebox_query[1] ) ? round( ( (float) $wp_codebox_query[1] ) * 1000, 3 ) : null;
        if ( null !== $wp_codebox_elapsed_ms ) {
            $wp_codebox_query_total_ms += $wp_codebox_elapsed_ms;
        }
        $wp_codebox_fingerprint = preg_replace( '/\\s+/', ' ', trim( $wp_codebox_sql ) );
        $wp_codebox_fingerprint = preg_replace( "/'(?:''|[^'])*'/", "'?'", $wp_codebox_fingerprint );
        $wp_codebox_fingerprint = preg_replace( '/\\b\\d+(?:\\.\\d+)?\\b/', '?', $wp_codebox_fingerprint );
        $wp_codebox_key = hash( 'sha256', $wp_codebox_fingerprint );
        if ( ! isset( $wp_codebox_queries[ $wp_codebox_key ] ) ) {
            $wp_codebox_queries[ $wp_codebox_key ] = array(
                'fingerprint' => $wp_codebox_fingerprint,
                'count' => 0,
                'sampleMs' => $wp_codebox_elapsed_ms,
                'totalTimeMs' => 0,
                'caller' => is_array( $wp_codebox_query ) && isset( $wp_codebox_query[2] ) ? substr( (string) $wp_codebox_query[2], 0, 240 ) : null,
            );
        }
        $wp_codebox_queries[ $wp_codebox_key ]['count']++;
        if ( null !== $wp_codebox_elapsed_ms ) {
            $wp_codebox_queries[ $wp_codebox_key ]['totalTimeMs'] = round( $wp_codebox_queries[ $wp_codebox_key ]['totalTimeMs'] + $wp_codebox_elapsed_ms, 3 );
        }
    }
}
$wp_codebox_fingerprints = array_values( $wp_codebox_queries );
$wp_codebox_repeated_queries = array_values( array_filter( $wp_codebox_fingerprints, static function ( $wp_codebox_query ) {
    return isset( $wp_codebox_query['count'] ) && $wp_codebox_query['count'] > 1;
} ) );
$wp_codebox_performance = array(
    'schema' => 'wp-codebox/performance-observation/v1',
    'command' => 'wordpress.rest-request',
    'target' => $wp_codebox_route,
    'timing' => array(
        'startedAt' => $wp_codebox_observation_started_at,
        'finishedAt' => $wp_codebox_observation_finished_at,
        'durationMs' => round( ( $wp_codebox_finished_at - $wp_codebox_started_at ) * 1000, 3 ),
    ),
    'memory' => array(
        'startBytes' => $wp_codebox_start_memory,
        'endBytes' => $wp_codebox_end_memory,
        'deltaBytes' => $wp_codebox_end_memory - $wp_codebox_start_memory,
        'peakBytes' => memory_get_peak_usage( true ),
    ),
    'database' => array(
        'queryCount' => $wp_codebox_query_count,
        'totalTimeMs' => round( $wp_codebox_query_total_ms, 3 ),
        'fingerprints' => $wp_codebox_fingerprints,
        'repeatedQueries' => $wp_codebox_repeated_queries,
    ),
);

echo wp_json_encode( array(
    'command' => 'wordpress.rest-request',
    'method' => $wp_codebox_method,
    'path' => $wp_codebox_path,
    'route' => $wp_codebox_route,
    'status' => $wp_codebox_response->get_status(),
    'headers' => $wp_codebox_response->get_headers(),
    'body' => $wp_codebox_data,
    'data' => $wp_codebox_data,
    'userSession' => is_array( $wp_codebox_user_session ) ? $wp_codebox_user_session : null,
    'timing' => array(
        'duration_ms' => (int) round( ( $wp_codebox_finished_at - $wp_codebox_started_at ) * 1000 ),
    ),
    'performance' => $wp_codebox_performance,
    'diagnostics' => (object) array(),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}
