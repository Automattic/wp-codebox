<?php
/**
 * WP_Codebox_Abilities_Utils implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Utils {
private static function generate_id(): string {
	if ( function_exists( 'wp_generate_uuid4' ) ) {
		return wp_generate_uuid4();
	}

	return bin2hex( random_bytes( 16 ) );
}
}
