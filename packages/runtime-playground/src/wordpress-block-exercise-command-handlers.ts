import { normalizeWordPressBlockExerciseInput, type WordPressBlockExerciseCommand, type WordPressBlockExerciseInput } from "@automattic/wp-codebox-core"
import { argValue, jsonObjectArg } from "./command-args.js"

export function wordpressBlockExerciseInputFromArgs(args: string[], command: WordPressBlockExerciseCommand): WordPressBlockExerciseInput {
  const inputJson = argValue(args, "exercise-json")
  if (inputJson) {
    return normalizeWordPressBlockExerciseInput(JSON.parse(inputJson))
  }

  return normalizeWordPressBlockExerciseInput({
    blockName: argValue(args, "block-name") ?? argValue(args, "name"),
    attrs: jsonObjectArg(args, "attrs-json"),
    content: argValue(args, "content"),
    markup: argValue(args, "markup"),
    mode: command === "wordpress.block-render" ? "render" : argValue(args, "mode"),
    source: argValue(args, "source"),
  })
}

export function wordpressBlockExercisePhpCode(input: WordPressBlockExerciseInput, command: WordPressBlockExerciseCommand): string {
  return `$wp_codebox_block_input = json_decode( ${JSON.stringify(JSON.stringify(input))}, true );
$wp_codebox_block_command = ${JSON.stringify(command)};
wp_codebox_emit_block_exercise_result( $wp_codebox_block_input, $wp_codebox_block_command );

function wp_codebox_block_issue( $code, $message, $severity = 'error' ) {
    return array( 'code' => (string) $code, 'message' => (string) $message, 'severity' => (string) $severity );
}

function wp_codebox_block_output_summary( $output ) {
    $output = (string) $output;
    return array(
        'bytes' => strlen( $output ),
        'excerpt' => substr( wp_strip_all_tags( $output ), 0, 500 ),
        'hash' => hash( 'sha256', $output ),
    );
}

function wp_codebox_block_serialize_markup( $block_name, $attrs, $content ) {
    $attrs = is_array( $attrs ) ? $attrs : array();
    $content = (string) $content;
    $attrs_json = empty( $attrs ) ? '' : ' ' . wp_json_encode( $attrs, JSON_UNESCAPED_SLASHES );
    if ( $content === '' ) {
        return '<!-- wp:' . $block_name . $attrs_json . ' /-->';
    }
    return '<!-- wp:' . $block_name . $attrs_json . ' -->' . $content . '<!-- /wp:' . $block_name . ' -->';
}

function wp_codebox_block_base_result( $input, $command, $status, $extra = array() ) {
    $block_name = (string) ( $input['blockName'] ?? '' );
    $mode = (string) ( $input['mode'] ?? 'render' );
    $attrs = isset( $input['attrs'] ) && is_array( $input['attrs'] ) ? $input['attrs'] : array();
    return array_merge( array(
        'schema' => 'wp-codebox/wordpress-block-exercise-result/v1',
        'command' => $command,
        'status' => $status,
        'blockName' => $block_name,
        'attrs' => $attrs,
        'input' => $input,
        'mode' => $mode,
        'source' => (string) ( $input['source'] ?? 'runtime-playground' ),
        'notices' => array(),
        'errors' => array(),
        'diagnostics' => array(),
        'artifacts' => (object) array(),
        'artifactRefs' => array(),
    ), $extra );
}

function wp_codebox_block_performance( $command, $block_name, $mode, $started_at_iso, $finished_at_iso, $started_at, $start_memory ) {
    return array(
        'schema' => 'wp-codebox/performance-observation/v1',
        'command' => $command,
        'target' => $block_name,
        'source' => 'in-process',
        'kind' => 'block-exercise',
        'timing' => array(
            'status' => 'captured',
            'startedAt' => $started_at_iso,
            'finishedAt' => $finished_at_iso,
            'durationMs' => round( ( microtime( true ) - $started_at ) * 1000, 3 ),
        ),
        'memory' => array(
            'status' => 'captured',
            'startBytes' => $start_memory,
            'endBytes' => memory_get_usage( true ),
            'deltaBytes' => memory_get_usage( true ) - $start_memory,
            'peakBytes' => memory_get_peak_usage( true ),
        ),
        'database' => array( 'status' => 'uncaptured', 'reason' => 'query_capture_not_requested' ),
        'hooks' => array( 'status' => 'unsupported', 'reason' => 'hook_timing_not_instrumented', 'timings' => array() ),
        'network' => array( 'status' => 'unsupported', 'reason' => 'in_process_block_exercise' ),
        'browser' => array( 'status' => 'unsupported', 'reason' => 'not_a_browser_observation' ),
        'metadata' => array( 'runner' => 'wp-codebox/runtime-playground', 'surface' => 'blocks', 'mode' => $mode ),
    );
}

function wp_codebox_emit_block_exercise_result( $input, $command ) {
    $started_at = microtime( true );
    $started_at_iso = gmdate( 'Y-m-d\TH:i:s.v\Z' );
    $start_memory = memory_get_usage( true );
    $block_name = (string) ( $input['blockName'] ?? '' );
    $attrs = isset( $input['attrs'] ) && is_array( $input['attrs'] ) ? $input['attrs'] : array();
    $mode = (string) ( $input['mode'] ?? 'render' );
    $content = (string) ( $input['content'] ?? '' );
    $markup = isset( $input['markup'] ) && is_string( $input['markup'] ) ? $input['markup'] : wp_codebox_block_serialize_markup( $block_name, $attrs, $content );

    try {
        if ( $mode === 'editor-insert-save' ) {
            $finished_at_iso = gmdate( 'Y-m-d\TH:i:s.v\Z' );
            echo wp_json_encode( wp_codebox_block_base_result( $input, $command, 'unsupported', array(
                'diagnostics' => array( wp_codebox_block_issue( 'editor-runtime-required', 'Block editor insert/save exercise requires a browser/editor runtime capability. Use wordpress.editor-actions in capable runtimes or mode=render for server-side coverage.', 'warning' ) ),
                'performance' => wp_codebox_block_performance( $command, $block_name, $mode, $started_at_iso, $finished_at_iso, $started_at, $start_memory ),
            ) ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
            return;
        }

        if ( ! function_exists( 'parse_blocks' ) || ! function_exists( 'serialize_block' ) ) {
            throw new RuntimeException( 'WordPress block parser APIs are unavailable in this runtime.' );
        }

        if ( ! class_exists( 'WP_Block_Type_Registry' ) || ! WP_Block_Type_Registry::get_instance()->is_registered( $block_name ) ) {
            $finished_at_iso = gmdate( 'Y-m-d\TH:i:s.v\Z' );
            echo wp_json_encode( wp_codebox_block_base_result( $input, $command, 'error', array(
                'errors' => array( wp_codebox_block_issue( 'block-not-registered', 'Block is not registered: ' . $block_name ) ),
                'performance' => wp_codebox_block_performance( $command, $block_name, $mode, $started_at_iso, $finished_at_iso, $started_at, $start_memory ),
            ) ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
            return;
        }

        $parsed_blocks = parse_blocks( $markup );
        $parsed = isset( $parsed_blocks[0] ) && is_array( $parsed_blocks[0] ) ? $parsed_blocks[0] : array();
        if ( empty( $parsed ) || (string) ( $parsed['blockName'] ?? '' ) !== $block_name ) {
            throw new RuntimeException( 'Serialized block markup did not parse into the requested block.' );
        }

        $serialized = serialize_block( $parsed );
        $result_extra = array(
            'serialized' => wp_codebox_block_output_summary( $serialized ),
            'parsed' => array(
                'blockName' => (string) ( $parsed['blockName'] ?? '' ),
                'attrs' => isset( $parsed['attrs'] ) && is_array( $parsed['attrs'] ) ? $parsed['attrs'] : array(),
                'innerHTMLBytes' => strlen( (string) ( $parsed['innerHTML'] ?? '' ) ),
            ),
        );

        if ( $mode === 'serialize-parse' ) {
            $result_extra['validation'] = array( 'status' => 'ok', 'roundTripStable' => $serialized === serialize_block( parse_blocks( $serialized )[0] ?? array() ) );
        } else {
            if ( ! function_exists( 'render_block' ) ) {
                throw new RuntimeException( 'WordPress render_block API is unavailable in this runtime.' );
            }
            $rendered = render_block( $parsed );
            $result_extra['render'] = wp_codebox_block_output_summary( $rendered );
            $result_extra['validation'] = array( 'status' => 'ok' );
        }

        $finished_at_iso = gmdate( 'Y-m-d\TH:i:s.v\Z' );
        $result_extra['performance'] = wp_codebox_block_performance( $command, $block_name, $mode, $started_at_iso, $finished_at_iso, $started_at, $start_memory );
        echo wp_json_encode( wp_codebox_block_base_result( $input, $command, 'ok', $result_extra ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
    } catch ( Throwable $error ) {
        $finished_at_iso = gmdate( 'Y-m-d\TH:i:s.v\Z' );
        echo wp_json_encode( wp_codebox_block_base_result( $input, $command, 'error', array(
            'errors' => array( wp_codebox_block_issue( 'block-exercise-failed', $error->getMessage() ) ),
            'performance' => wp_codebox_block_performance( $command, $block_name, $mode, $started_at_iso, $finished_at_iso, $started_at, $start_memory ),
        ) ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
    }
}`
}
