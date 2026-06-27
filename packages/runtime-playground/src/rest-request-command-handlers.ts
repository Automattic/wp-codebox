import { argValue, booleanArg, jsonObjectArg } from "./command-args.js"
import { wordpressQueryRecorderPhp } from "./query-recorder.js"
import { wordpressFixtureUserPhpCode, type WordPressUserSessionResolution } from "./wordpress-user-sessions.js"

export interface RestRequestCommandInput {
  method: string
  path: string
  headers: Record<string, unknown>
  params: Record<string, unknown>
  body: string
  capture: { queries?: boolean }
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
    capture: captureFromArgs(args),
  }
}

export function restRequestPhpCode(input: RestRequestCommandInput): string {
  const userSessionMetadata = input.userSession?.metadata
  return `define( 'REST_REQUEST', true );
${wordpressQueryRecorderPhp()}
$wp_codebox_started_at = microtime( true );
$wp_codebox_observation_started_at = gmdate( 'Y-m-d\\TH:i:s.v\\Z' );
$wp_codebox_start_memory = memory_get_usage( true );
$wp_codebox_method = ${JSON.stringify(input.method)};
$wp_codebox_path = ${JSON.stringify(input.path)};
$wp_codebox_headers = json_decode( ${JSON.stringify(JSON.stringify(input.headers))}, true );
$wp_codebox_params = json_decode( ${JSON.stringify(JSON.stringify(input.params))}, true );
$wp_codebox_body = ${JSON.stringify(input.body)};
$wp_codebox_capture = json_decode( ${JSON.stringify(JSON.stringify(input.capture ?? {}))}, true );
$wp_codebox_user_session = json_decode( ${JSON.stringify(JSON.stringify(userSessionMetadata ?? null))}, true );
$wp_codebox_capture_queries_requested = is_array( $wp_codebox_capture ) && array_key_exists( 'queries', $wp_codebox_capture ) ? (bool) $wp_codebox_capture['queries'] : false;
$wp_codebox_query_recorder_start = $wp_codebox_capture_queries_requested ? wp_codebox_query_recorder_start( 'rest-request', 50, 500 ) : array( 'status' => 'uncaptured', 'reason' => 'query_capture_not_requested' );

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
$wp_codebox_query_report = $wp_codebox_capture_queries_requested && ( $wp_codebox_query_recorder_start['status'] ?? null ) === 'captured' ? wp_codebox_query_recorder_report( 'rest-request' ) : array( 'status' => (string) ( $wp_codebox_query_recorder_start['status'] ?? 'unavailable' ), 'reason' => $wp_codebox_query_recorder_start['reason'] ?? 'query_recorder_unavailable', 'queryCount' => 0, 'totalTimeMs' => null, 'timingStatus' => 'unavailable', 'timingReason' => $wp_codebox_query_recorder_start['reason'] ?? 'query_recorder_unavailable', 'fingerprints' => array(), 'repeatedQueries' => array() );
$wp_codebox_query_capture_status = (string) ( $wp_codebox_query_report['status'] ?? 'unavailable' );
$wp_codebox_query_capture_reason = $wp_codebox_query_report['reason'] ?? null;
$wp_codebox_query_timing_status = (string) ( $wp_codebox_query_report['timingStatus'] ?? 'unavailable' );
$wp_codebox_query_timing_reason = $wp_codebox_query_report['timingReason'] ?? null;
$wp_codebox_query_count = (int) ( $wp_codebox_query_report['queryCount'] ?? 0 );
$wp_codebox_query_total_ms = isset( $wp_codebox_query_report['totalTimeMs'] ) ? (float) $wp_codebox_query_report['totalTimeMs'] : null;
$wp_codebox_fingerprints = is_array( $wp_codebox_query_report['fingerprints'] ?? null ) ? $wp_codebox_query_report['fingerprints'] : array();
$wp_codebox_repeated_queries = is_array( $wp_codebox_query_report['repeatedQueries'] ?? null ) ? $wp_codebox_query_report['repeatedQueries'] : array();
$wp_codebox_performance = array(
    'schema' => 'wp-codebox/performance-observation/v1',
    'command' => 'wordpress.rest-request',
    'target' => $wp_codebox_route,
    'source' => 'in-process',
    'kind' => 'rest-request',
    'timing' => array(
        'status' => 'captured',
        'startedAt' => $wp_codebox_observation_started_at,
        'finishedAt' => $wp_codebox_observation_finished_at,
        'durationMs' => round( ( $wp_codebox_finished_at - $wp_codebox_started_at ) * 1000, 3 ),
    ),
    'memory' => array(
        'status' => 'captured',
        'startBytes' => $wp_codebox_start_memory,
        'endBytes' => $wp_codebox_end_memory,
        'deltaBytes' => $wp_codebox_end_memory - $wp_codebox_start_memory,
        'peakBytes' => memory_get_peak_usage( true ),
    ),
    'database' => array(
        'status' => $wp_codebox_query_capture_status,
        'reason' => $wp_codebox_query_capture_reason,
        'queryCount' => $wp_codebox_query_count,
        'totalTimeMs' => null === $wp_codebox_query_total_ms ? null : round( $wp_codebox_query_total_ms, 3 ),
        'timingStatus' => $wp_codebox_query_timing_status,
        'timingReason' => $wp_codebox_query_timing_reason,
        'fingerprints' => $wp_codebox_fingerprints,
        'repeatedQueries' => $wp_codebox_repeated_queries,
    ),
    'hooks' => array( 'status' => 'unsupported', 'reason' => 'hook_timing_not_instrumented', 'timings' => array() ),
    'network' => array( 'status' => 'unsupported', 'reason' => 'in_process_rest_request' ),
    'browser' => array( 'status' => 'unsupported', 'reason' => 'not_a_browser_observation' ),
    'capture' => array(
        'requested' => array( 'queries' => $wp_codebox_capture_queries_requested ),
        'queries' => array( 'requested' => $wp_codebox_capture_queries_requested, 'status' => $wp_codebox_query_capture_status, 'reason' => $wp_codebox_query_capture_reason ),
    ),
    'metadata' => array( 'runner' => 'wp-codebox/runtime-playground', 'surface' => 'rest' ),
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

function captureFromArgs(args: string[]): RestRequestCommandInput["capture"] {
  const capture = jsonObjectArg(args, "capture-json") as RestRequestCommandInput["capture"]
  const explicitQueries = argValue(args, "capture-queries") ?? argValue(args, "enable-query-capture")
  if (explicitQueries !== undefined) {
    capture.queries = booleanArg(args, argValue(args, "capture-queries") !== undefined ? "capture-queries" : "enable-query-capture")
  }
  return capture
}
