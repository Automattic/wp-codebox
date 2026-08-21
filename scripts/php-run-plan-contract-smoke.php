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

require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-run-plan.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-status-taxonomy.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-fanout-aggregation.php';
require_once __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-run-result-builder.php';

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
assert_same_contract( array( 'total' => 5, 'completed' => 1, 'failed' => 1, 'skipped' => 1, 'cancelled' => 1, 'timed_out' => 1 ), $run_plan->result_counts( array( array( 'success' => true, 'status' => 'completed' ), array( 'success' => false, 'status' => 'failed' ), array( 'success' => false, 'status' => 'skipped' ), array( 'success' => false, 'status' => 'cancelled' ), array( 'success' => false, 'status' => 'timed_out' ) ) ), 'result counts' );
assert_same_contract( false, $run_plan->succeeded( array( 'failed' => 1, 'skipped' => 0, 'cancelled' => 0, 'timed_out' => 0 ) ), 'run-plan success' );

$event = $run_plan->event( 'wp-codebox/agent-fanout-event/v1', array( 'event' => 'worker.completed', 'worker_id' => 'design', 'status' => 'completed' ) );
unset( $event['time'] );
assert_same_contract( array( 'schema' => 'wp-codebox/agent-fanout-event/v1', 'event' => 'worker.completed', 'worker_id' => 'design', 'status' => 'completed' ), $event, 'event envelope' );

$builder = new WP_Codebox_Agent_Run_Result_Builder( $run_plan );
$worker_result = $builder->fanout_worker_success_result(
    array(
        'id'       => 'design',
        'index'    => 0,
        'prepared' => array( 'input' => array( 'agent' => 'planner' ) ),
    ),
    array(
        'exit_code' => 0,
        'session'   => array(
            'id'        => 'child-1',
            'artifacts' => array( 'path' => '/tmp/artifacts', 'bundle_id' => 'bundle-1' ),
        ),
        'diagnostics'        => array( 'schema' => 'wp-codebox/agent-task-diagnostics/v1' ),
        'evidence_refs'      => array( 'schema' => 'wp-codebox/agent-task-evidence-refs/v1' ),
        'completion_outcome' => array( 'schema' => 'wp-codebox/sandbox-completion-outcome/v1' ),
    ),
    1000.0,
    1001.25
);
assert_same_contract( 'completed', $worker_result['status'], 'fanout worker success status' );
assert_same_contract( array( 'path' => '/tmp/artifacts', 'bundle_id' => 'bundle-1', 'namespace' => 'design', 'result' => 'result.json' ), $worker_result['artifacts'], 'fanout artifact result shaping' );

$failed_worker_result = $builder->fanout_worker_success_result(
    array(
        'id'       => 'failed-worker',
        'index'    => 0,
        'prepared' => array( 'input' => array( 'agent' => '' ) ),
    ),
    array(
        'success'   => false,
        'status'    => 'failed',
        'exit_code' => 127,
        'session'   => array( 'id' => 'child-failed', 'status' => 'failed' ),
        'error'     => array( 'code' => 'wp_codebox_run_failed', 'message' => 'Worker process failed.' ),
    ),
    1000.0,
    1001.25
);
assert_same_contract( false, $failed_worker_result['success'], 'nonzero fanout worker success' );
assert_same_contract( 'failed', $failed_worker_result['status'], 'nonzero fanout worker status' );
assert_same_contract( 127, $failed_worker_result['exit_code'], 'nonzero fanout worker exit code' );
assert_same_contract( 'wp_codebox_run_failed', $failed_worker_result['error']['code'], 'nonzero fanout worker error' );

$nested_failed_worker_result = $builder->fanout_worker_success_result(
    array(
        'id'       => 'nested-failed-worker',
        'index'    => 1,
        'prepared' => array( 'input' => array( 'agent' => 'planner' ) ),
    ),
    array(
        'success'   => true,
        'status'    => 'completed',
        'exit_code' => 0,
        'session'   => array( 'id' => 'child-nested-failed', 'status' => 'failed' ),
    ),
    1000.0,
    1001.25
);
assert_same_contract( false, $nested_failed_worker_result['success'], 'nested failed fanout worker success' );
assert_same_contract( 'failed', $nested_failed_worker_result['status'], 'nested failed fanout worker status' );

$failed_counts = $builder->status_counts( array( $failed_worker_result, $nested_failed_worker_result ) );
assert_same_contract( array( 'total' => 2, 'completed' => 0, 'failed' => 2, 'skipped' => 0, 'cancelled' => 0, 'timed_out' => 0 ), $failed_counts, 'failed fanout counts' );

$aggregation = new WP_Codebox_Fanout_Aggregation();
$failed_aggregate = $aggregation->aggregate(
    $aggregation->input_from_worker_artifacts(
        array(
            'plan' => array(
                'id'      => 'failed-fanout',
                'workers' => array(
                    array( 'id' => 'failed-worker', 'required' => true ),
                    array( 'id' => 'nested-failed-worker', 'required' => true ),
                ),
            ),
            'workerResultRefs' => array_map(
                static fn( array $run ): array => array(
                    'workerId' => $run['worker_id'],
                    'status'   => $run['status'],
                    'success'  => $run['success'],
                    'required' => true,
                    'error'    => $run['error'] ?? null,
                ),
                array( $failed_worker_result, $nested_failed_worker_result )
            ),
        )
    )
);
assert_same_contract( 'failed', $failed_aggregate['status'], 'failed fanout aggregate status' );
assert_same_contract( array( 'failed', 'failed' ), array_column( $failed_aggregate['workerResultRefs'], 'status' ), 'failed aggregate worker ref statuses' );

$paths = $run_plan->paths( '/tmp/root', 'fanout' );
$fanout_result = $builder->fanout_result(
    'wp-codebox/agent-fanout-result/v1',
    'wp-codebox/agent-fanout-artifacts/v1',
    'bounded-concurrent-isolated-sandboxes',
    'parent-1',
    'completed',
    array( 'session_id' => 'agent-session-1' ),
    $paths,
    $builder->status_counts( array( $worker_result ) ),
    1000.0,
    1001.25,
    $run_plan->plan( 'wp-codebox/agent-fanout-plan/v1', 'parent-1', 2, array(), $descriptors ),
    array( $worker_result )
);
assert_same_contract( true, $fanout_result['success'], 'fanout result success' );
assert_same_contract( 'wp-codebox/agent-fanout-artifacts/v1', $fanout_result['artifacts']['schema'], 'fanout artifacts schema' );
assert_same_contract( 'child-1', $fanout_result['session']['children'][0]['session_id'], 'fanout child session ref' );

$failed_fanout_result = $builder->fanout_result(
    'wp-codebox/agent-fanout-result/v1',
    'wp-codebox/agent-fanout-artifacts/v1',
    'bounded-concurrent-isolated-sandboxes',
    'parent-failed',
    'failed',
    array( 'session_id' => 'agent-session-failed' ),
    $paths,
    $failed_counts,
    1000.0,
    1001.25,
    $run_plan->plan( 'wp-codebox/agent-fanout-plan/v1', 'parent-failed', 2, array(), $descriptors ),
    array( $failed_worker_result, $nested_failed_worker_result )
);
assert_same_contract( false, $failed_fanout_result['success'], 'failed fanout result success' );
assert_same_contract( 2, $failed_fanout_result['failed'], 'failed fanout result failed count' );
assert_same_contract( 2, count( $failed_fanout_result['failures'] ), 'failed fanout failures' );

$batch_result = $builder->batch_result(
    'wp-codebox/agent-task-batch/v1',
    WP_Codebox_Agent_Task::session( 'batch-1', 'completed', array(), array( 'path' => '/tmp/batch' ) ),
    array( 'Draft design direction.' ),
    array( array( 'goal' => 'Draft design direction.' ) ),
    'sequential-isolated-sandboxes',
    'latest',
    array(),
    '/tmp/batch',
    array(
        $builder->batch_success_run(
            0,
            array( 'goal' => 'Draft design direction.' ),
            array( 'exit_code' => 0, 'session' => array( 'artifacts' => array( 'bundle_id' => 'batch-bundle' ) ) )
        ),
    )
);
assert_same_contract( 1, $batch_result['completed'], 'batch completed count' );
assert_same_contract( 'batch-bundle', $batch_result['runs'][0]['artifact_id'], 'batch artifact id shaping' );

fwrite( STDOUT, "PHP run-plan contract smoke passed\n" );
