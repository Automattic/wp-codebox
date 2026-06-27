import { argValue, booleanArg, jsonObjectArg, nonNegativeIntegerArg, positiveIntegerArg } from "./command-args.js"
import { wordpressQueryRecorderPhp } from "./query-recorder.js"
import { wordpressFixtureUserPhpCode, type WordPressUserSessionResolution } from "./wordpress-user-sessions.js"

export interface RestPerformanceObservationInput {
  method: string
  path: string
  params: Record<string, unknown>
  queryFingerprintLimit: number
  hookSampleLimit: number
  hookLimit: number
  queryLengthLimit: number
  capture: { queries?: boolean }
  userSession?: WordPressUserSessionResolution
}

export function restPerformanceObservationInputFromArgs(args: string[]): RestPerformanceObservationInput {
  const path = argValue(args, "path")?.trim() || argValue(args, "route")?.trim()
  if (!path) {
    throw new Error("wordpress.rest-performance-observation requires path=<rest-route>")
  }

  return {
    method: (argValue(args, "method")?.trim() || "GET").toUpperCase(),
    path,
    params: jsonObjectArg(args, "params-json"),
    queryFingerprintLimit: nonNegativeIntegerArg(args, "query-fingerprint-limit", 50),
    hookSampleLimit: nonNegativeIntegerArg(args, "hook-sample-limit", 50),
    hookLimit: positiveIntegerArg(args, "hook-limit", 500),
    queryLengthLimit: positiveIntegerArg(args, "query-length-limit", 500),
    capture: captureFromArgs(args),
  }
}

export function restPerformanceObservationPhpCode(input: RestPerformanceObservationInput): string {
  const userSessionMetadata = input.userSession?.metadata
  return `define( 'REST_REQUEST', true );
${wordpressQueryRecorderPhp()}
$wp_codebox_observation_started_at = gmdate( 'Y-m-d\\TH:i:s.v\\Z' );
$wp_codebox_observation_start_time = microtime( true );
$wp_codebox_observation_start_memory = memory_get_usage( true );
$wp_codebox_method = ${JSON.stringify(input.method)};
$wp_codebox_path = ${JSON.stringify(input.path)};
$wp_codebox_params = json_decode( ${JSON.stringify(JSON.stringify(input.params))}, true );
$wp_codebox_capture = json_decode( ${JSON.stringify(JSON.stringify(input.capture ?? {}))}, true );
$wp_codebox_query_fingerprint_limit = ${input.queryFingerprintLimit};
$wp_codebox_hook_sample_limit = ${input.hookSampleLimit};
$wp_codebox_hook_limit = ${input.hookLimit};
$wp_codebox_query_length_limit = ${input.queryLengthLimit};
$wp_codebox_user_session = json_decode( ${JSON.stringify(JSON.stringify(userSessionMetadata ?? null))}, true );
$wp_codebox_capture_queries_requested = is_array( $wp_codebox_capture ) && array_key_exists( 'queries', $wp_codebox_capture ) ? (bool) $wp_codebox_capture['queries'] : true;
$wp_codebox_query_recorder_start = $wp_codebox_capture_queries_requested ? wp_codebox_query_recorder_start( 'rest-performance-observation', $wp_codebox_query_fingerprint_limit, $wp_codebox_query_length_limit ) : array( 'status' => 'uncaptured', 'reason' => 'query_capture_not_requested' );

if ( ! class_exists( 'WP_REST_Request' ) || ! function_exists( 'rest_do_request' ) ) {
    throw new RuntimeException( 'The WordPress REST API is not available in this runtime.' );
}

${input.userSession ? wordpressFixtureUserPhpCode(input.userSession.user) : ""}

$wp_codebox_route_path = (string) ( parse_url( $wp_codebox_path, PHP_URL_PATH ) ?: $wp_codebox_path );
$wp_codebox_route = '/' . ltrim( preg_replace( '#^/wp-json#', '', $wp_codebox_route_path ), '/' );
$wp_codebox_request = new WP_REST_Request( $wp_codebox_method, $wp_codebox_route );
foreach ( is_array( $wp_codebox_params ) ? $wp_codebox_params : array() as $wp_codebox_name => $wp_codebox_value ) {
    $wp_codebox_request->set_param( $wp_codebox_name, $wp_codebox_value );
}

$wp_codebox_hook_samples = array();
$wp_codebox_hook_count = 0;
$wp_codebox_hooks_truncated = false;
$wp_codebox_hook_sampler = static function () use ( &$wp_codebox_hook_samples, &$wp_codebox_hook_count, &$wp_codebox_hooks_truncated, $wp_codebox_hook_limit ): void {
    if ( ! function_exists( 'current_filter' ) ) {
        return;
    }
    $wp_codebox_hook = preg_replace( '/[^A-Za-z0-9_\.\-\/]/', '', (string) current_filter() );
    $wp_codebox_hook = substr( (string) $wp_codebox_hook, 0, 120 );
    if ( '' === $wp_codebox_hook ) {
        return;
    }
    ++$wp_codebox_hook_count;
    if ( ! isset( $wp_codebox_hook_samples[ $wp_codebox_hook ] ) && count( $wp_codebox_hook_samples ) >= max( 1, $wp_codebox_hook_limit ) ) {
        $wp_codebox_hooks_truncated = true;
        return;
    }
    $wp_codebox_now = microtime( true );
    if ( ! isset( $wp_codebox_hook_samples[ $wp_codebox_hook ] ) ) {
        global $wp_filter;
        $wp_codebox_callback_count = 0;
        $wp_codebox_wp_hook = is_array( $wp_filter ?? null ) ? ( $wp_filter[ $wp_codebox_hook ] ?? null ) : null;
        $wp_codebox_callbacks = is_object( $wp_codebox_wp_hook ) && isset( $wp_codebox_wp_hook->callbacks ) && is_array( $wp_codebox_wp_hook->callbacks ) ? $wp_codebox_wp_hook->callbacks : ( is_array( $wp_codebox_wp_hook ) ? $wp_codebox_wp_hook : array() );
        foreach ( $wp_codebox_callbacks as $wp_codebox_priority_callbacks ) {
            $wp_codebox_callback_count += is_array( $wp_codebox_priority_callbacks ) ? count( $wp_codebox_priority_callbacks ) : 0;
        }
        $wp_codebox_hook_samples[ $wp_codebox_hook ] = array( 'hook' => $wp_codebox_hook, 'count' => 0, 'first' => $wp_codebox_now, 'last' => $wp_codebox_now, 'callbackCount' => $wp_codebox_callback_count );
    }
    ++$wp_codebox_hook_samples[ $wp_codebox_hook ]['count'];
    $wp_codebox_hook_samples[ $wp_codebox_hook ]['last'] = $wp_codebox_now;
};

if ( function_exists( 'add_filter' ) ) {
    add_filter( 'all', $wp_codebox_hook_sampler, PHP_INT_MIN, 0 );
}
try {
    $wp_codebox_response = rest_do_request( $wp_codebox_request );
} finally {
    if ( function_exists( 'remove_filter' ) ) {
        remove_filter( 'all', $wp_codebox_hook_sampler, PHP_INT_MIN );
    }
}

$wp_codebox_finished_at = microtime( true );
$wp_codebox_observation_finished_at = gmdate( 'Y-m-d\\TH:i:s.v\\Z' );
$wp_codebox_end_memory = memory_get_usage( true );
$wp_codebox_query_report = $wp_codebox_capture_queries_requested && ( $wp_codebox_query_recorder_start['status'] ?? null ) === 'captured' ? wp_codebox_query_recorder_report( 'rest-performance-observation' ) : array( 'status' => (string) ( $wp_codebox_query_recorder_start['status'] ?? 'unavailable' ), 'reason' => $wp_codebox_query_recorder_start['reason'] ?? 'query_recorder_unavailable', 'queryCount' => 0, 'totalTimeMs' => null, 'timingStatus' => 'unavailable', 'timingReason' => $wp_codebox_query_recorder_start['reason'] ?? 'query_recorder_unavailable', 'fingerprints' => array(), 'repeatedQueries' => array() );
$wp_codebox_query_capture_status = (string) ( $wp_codebox_query_report['status'] ?? 'unavailable' );
$wp_codebox_query_capture_reason = $wp_codebox_query_report['reason'] ?? null;
$wp_codebox_query_timing_status = (string) ( $wp_codebox_query_report['timingStatus'] ?? 'unavailable' );
$wp_codebox_query_timing_reason = $wp_codebox_query_report['timingReason'] ?? null;
$wp_codebox_query_count = (int) ( $wp_codebox_query_report['queryCount'] ?? 0 );
$wp_codebox_query_total_ms = isset( $wp_codebox_query_report['totalTimeMs'] ) ? (float) $wp_codebox_query_report['totalTimeMs'] : null;
$wp_codebox_fingerprints = is_array( $wp_codebox_query_report['fingerprints'] ?? null ) ? $wp_codebox_query_report['fingerprints'] : array();
$wp_codebox_repeated_queries = is_array( $wp_codebox_query_report['repeatedQueries'] ?? null ) ? $wp_codebox_query_report['repeatedQueries'] : array();

$wp_codebox_hook_timings = array_values( array_map( static fn( $sample ) => array_filter( array( 'hook' => $sample['hook'], 'count' => (int) $sample['count'], 'totalTimeMs' => round( max( 0, ( (float) $sample['last'] - (float) $sample['first'] ) * 1000 ), 3 ), 'callbackCount' => (int) $sample['callbackCount'] ), static fn( $value ) => 0 !== $value && '' !== $value ), $wp_codebox_hook_samples ) );
usort( $wp_codebox_hook_timings, static fn( $a, $b ) => ( (int) ( $b['count'] ?? 0 ) <=> (int) ( $a['count'] ?? 0 ) ) ?: strcmp( (string) ( $a['hook'] ?? '' ), (string) ( $b['hook'] ?? '' ) ) );
$wp_codebox_hook_timings = array_slice( $wp_codebox_hook_timings, 0, $wp_codebox_hook_sample_limit );

echo wp_json_encode( array(
    'schema' => 'wp-codebox/performance-observation/v1',
    'command' => 'wordpress.rest-performance-observation',
    'target' => $wp_codebox_route,
    'source' => 'in-process',
    'kind' => 'rest-request',
    'timing' => array( 'status' => 'captured', 'startedAt' => $wp_codebox_observation_started_at, 'finishedAt' => $wp_codebox_observation_finished_at, 'durationMs' => round( ( $wp_codebox_finished_at - $wp_codebox_observation_start_time ) * 1000, 3 ) ),
    'memory' => array( 'status' => 'captured', 'startBytes' => $wp_codebox_observation_start_memory, 'endBytes' => $wp_codebox_end_memory, 'deltaBytes' => $wp_codebox_end_memory - $wp_codebox_observation_start_memory, 'peakBytes' => memory_get_peak_usage( true ) ),
    'database' => array( 'status' => $wp_codebox_query_capture_status, 'reason' => $wp_codebox_query_capture_reason, 'queryCount' => $wp_codebox_query_count, 'totalTimeMs' => null === $wp_codebox_query_total_ms ? null : round( $wp_codebox_query_total_ms, 3 ), 'timingStatus' => $wp_codebox_query_timing_status, 'timingReason' => $wp_codebox_query_timing_reason, 'fingerprints' => $wp_codebox_fingerprints, 'repeatedQueries' => $wp_codebox_repeated_queries ),
    'hooks' => array( 'status' => 'captured', 'reason' => $wp_codebox_hooks_truncated ? 'hook_sample_limit_reached' : null, 'timings' => $wp_codebox_hook_timings ),
    'network' => array( 'status' => 'unsupported', 'reason' => 'in_process_rest_request' ),
    'browser' => array( 'status' => 'unsupported', 'reason' => 'not_a_browser_observation' ),
    'capture' => array( 'requested' => array( 'queries' => $wp_codebox_capture_queries_requested ), 'queries' => array( 'requested' => $wp_codebox_capture_queries_requested, 'status' => $wp_codebox_query_capture_status, 'reason' => $wp_codebox_query_capture_reason ) ),
    'metadata' => array( 'runner' => 'wp-codebox/runtime-playground', 'surface' => 'rest', 'method' => $wp_codebox_method, 'status' => (int) $wp_codebox_response->get_status(), 'hookCount' => $wp_codebox_hook_count ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}

function captureFromArgs(args: string[]): RestPerformanceObservationInput["capture"] {
  const capture = jsonObjectArg(args, "capture-json") as RestPerformanceObservationInput["capture"]
  const name = argValue(args, "capture-queries") !== undefined ? "capture-queries" : argValue(args, "enable-query-capture") !== undefined ? "enable-query-capture" : undefined
  if (name) {
    capture.queries = booleanArg(args, name)
  }
  return capture
}
