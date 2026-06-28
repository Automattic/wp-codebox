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

$vectors = $fixture['vectors'] ?? null;
if ( ! is_array( $vectors ) ) {
	fwrite( STDERR, "Fanout aggregation contract fixture must include generated vectors.\n" );
	exit( 1 );
}

$aggregation = new WP_Codebox_Fanout_Aggregation();
foreach ( $vectors as $vector ) {
	if ( ! is_array( $vector ) ) {
		fwrite( STDERR, "Fanout aggregation contract vector must be an object.\n" );
		exit( 1 );
	}
	$output = $aggregation->aggregate( is_array( $vector['input'] ?? null ) ? $vector['input'] : array() );
	assert_same_contract( $vector['expectedOutput'] ?? null, $output, 'PHP fanout aggregation output vector ' . (string) ( $vector['name'] ?? '' ) );
}

echo "PHP fanout aggregation contract smoke passed\n";
