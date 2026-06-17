<?php

define( 'ABSPATH', __DIR__ );

final class WP_Error {
    private string $code;
    private string $message;
    /** @var mixed */
    private mixed $data;

    /** @param mixed $data */
    public function __construct( string $code = '', string $message = '', mixed $data = null ) {
        $this->code    = $code;
        $this->message = $message;
        $this->data    = $data;
    }

    /** @param mixed $data */
    public function add_data( mixed $data ): void {
        $this->data = $data;
    }

    public function get_error_code(): string {
        return $this->code;
    }

    public function get_error_message(): string {
        return $this->message;
    }

    public function get_error_data(): mixed {
        return $this->data;
    }
}

function is_wp_error( mixed $value ): bool {
    return $value instanceof WP_Error;
}

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-run-plan.php';

function assert_same_contract( mixed $expected, mixed $actual, string $label ): void {
    if ( $expected !== $actual ) {
        fwrite( STDERR, $label . " failed.\nExpected: " . json_encode( $expected, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\nActual: " . json_encode( $actual, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\n" );
        exit( 1 );
    }
}

$run_plan = new WP_Codebox_Run_Plan();

$descriptors = $run_plan->normalize_worker_descriptors(
    array(
        array( 'id' => 'design', 'goal' => 'Draft design direction.', 'agent' => 'planner', 'timeout_seconds' => 30 ),
        array( 'id' => 'copy', 'goal' => 'Draft page copy.', 'artifactNamespace' => 'copy/final', 'required' => false, 'cancel_requested' => true, 'cancel_reason' => 'caller stopped' ),
    ),
    array( 'default_agent' => 'default-agent', 'require_goal' => true )
);

if ( is_wp_error( $descriptors ) ) {
    fwrite( STDERR, 'Unexpected run-plan descriptor error: ' . $descriptors->get_error_message() . "\n" );
    exit( 1 );
}

assert_same_contract( 2, $run_plan->normalize_concurrency( 99, array( 'max_concurrency' => 2 ) ), 'clamped concurrency' );
assert_same_contract( 'wp_codebox_run_plan_concurrency_invalid', $run_plan->normalize_concurrency( 9, array( 'max_concurrency' => 8, 'concurrency_mode' => 'validate' ) )->get_error_code(), 'validated concurrency error' );
assert_same_contract( 30, $descriptors[0]['timeout_seconds'], 'descriptor timeout' );
assert_same_contract( array( 'cancel_requested' => false, 'timeout_seconds' => 30 ), $descriptors[0]['cancellation'], 'timeout cancellation metadata' );
assert_same_contract( 'copy/final', $descriptors[1]['artifact_namespace'], 'artifact namespace' );
assert_same_contract( false, $descriptors[1]['required'], 'required flag' );
assert_same_contract( array( 'cancel_requested' => true, 'reason' => 'caller stopped' ), $descriptors[1]['cancellation'], 'cancel requested metadata' );
assert_same_contract( array( 'total' => 3, 'completed' => 1, 'failed' => 1, 'cancelled' => 1 ), $run_plan->result_counts( array( array( 'success' => true, 'status' => 'completed' ), array( 'success' => false, 'status' => 'failed' ), array( 'success' => false, 'status' => 'cancelled' ) ) ), 'result counts' );
assert_same_contract( false, $run_plan->succeeded( array( 'failed' => 1, 'cancelled' => 0 ) ), 'run-plan success' );

$event = $run_plan->event( 'wp-codebox/agent-fanout-event/v1', array( 'event' => 'worker.completed', 'worker_id' => 'design', 'status' => 'completed' ) );
unset( $event['time'] );
assert_same_contract( array( 'schema' => 'wp-codebox/agent-fanout-event/v1', 'event' => 'worker.completed', 'worker_id' => 'design', 'status' => 'completed' ), $event, 'event envelope' );

fwrite( STDOUT, "PHP run-plan contract smoke passed\n" );
