<?php

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );

require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-status-taxonomy.php';
require_once dirname( __DIR__ ) . '/packages/wordpress-plugin/src/class-wp-codebox-fanout-aggregation.php';

function assert_same_contract( mixed $expected, mixed $actual, string $label ): void {
	if ( $expected !== $actual ) {
		fwrite( STDERR, $label . " failed.\nExpected: " . json_encode( $expected, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\nActual: " . json_encode( $actual, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\n" );
		exit( 1 );
	}
}

$fixture = json_decode( file_get_contents( dirname( __DIR__ ) . '/tests/fixtures/fanout-aggregation-contract.json' ) ?: '', true );
if ( ! is_array( $fixture ) ) {
	fwrite( STDERR, "Could not read fanout aggregation contract fixture.\n" );
	exit( 1 );
}

$aggregation = new WP_Codebox_Fanout_Aggregation();
$output      = $aggregation->aggregate( $fixture['input'] );
assert_same_contract( $fixture['expectedOutput'], $output, 'PHP fanout aggregation output' );

$duplicate_output = $aggregation->aggregate(
	array(
		'plan'           => array(
			'id'      => 'duplicate-final-path',
			'workers' => array(
				array( 'id' => 'one' ),
				array( 'id' => 'two' ),
			),
		),
		'policy'         => 'partial',
		'worker_results' => array(
			array( 'worker_id' => 'one', 'status' => 'succeeded', 'artifact_refs' => array( array( 'path' => 'one.json', 'final_path' => 'same.json' ) ) ),
			array( 'worker_id' => 'two', 'status' => 'succeeded', 'artifact_refs' => array( array( 'path' => 'two.json', 'final_path' => 'same.json' ) ) ),
		),
	)
);
assert_same_contract( 'partial', $duplicate_output['status'], 'partial policy conflict status' );
assert_same_contract( 'duplicate-final-artifact-path', $duplicate_output['conflicts'][0]['type'], 'duplicate final-path conflict' );
assert_same_contract( array(), $duplicate_output['finalArtifactRefs'], 'conflicted aggregation final refs' );

echo "PHP fanout aggregation contract smoke passed\n";
