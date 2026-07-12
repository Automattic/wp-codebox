<?php

define( 'ABSPATH', __DIR__ );

require_once __DIR__ . '/../packages/wordpress-plugin/src/trait-wp-codebox-abilities-browser-blueprint.php';

final class WP_Codebox_Post_Runtime_Blueprint_Smoke {
	use WP_Codebox_Abilities_Browser_Blueprint;

	/** @param array<string,mixed> $blueprint @param array<string,mixed> $post_runtime @return array<string,mixed> */
	public static function merge( array $blueprint, array $post_runtime ): array {
		$method = new ReflectionMethod( self::class, 'browser_blueprint_with_post_runtime' );
		return $method->invoke( null, $blueprint, $post_runtime );
	}
}

$runtime_blueprint = array(
	'preferredVersions' => array( 'php' => '8.3' ),
	'features'          => array( 'networking' => false ),
	'steps'             => array(
		array( 'step' => 'login' ),
		array( 'step' => 'installPlugin', 'pluginData' => array( 'url' => 'runtime.zip' ) ),
	),
);
$post_runtime = array(
	'features' => array( 'networking' => true ),
	'steps'    => array( array( 'step' => 'runPHP', 'code' => '<?php import_site();' ) ),
);

$merged = WP_Codebox_Post_Runtime_Blueprint_Smoke::merge( $runtime_blueprint, $post_runtime );
$steps  = array_column( $merged['steps'] ?? array(), 'step' );

if ( array( 'login', 'installPlugin', 'runPHP' ) !== $steps ) {
	fwrite( STDERR, 'Post-runtime blueprint steps were not appended after runtime materialization.' . PHP_EOL );
	exit( 1 );
}
if ( true !== ( $merged['features']['networking'] ?? null ) ) {
	fwrite( STDERR, 'Post-runtime blueprint features did not override the base feature.' . PHP_EOL );
	exit( 1 );
}
if ( $runtime_blueprint !== WP_Codebox_Post_Runtime_Blueprint_Smoke::merge( $runtime_blueprint, array() ) ) {
	fwrite( STDERR, 'Empty post-runtime blueprint should preserve the runtime blueprint.' . PHP_EOL );
	exit( 1 );
}

fwrite( STDOUT, 'OK: post-runtime blueprint ordering smoke passed.' . PHP_EOL );
