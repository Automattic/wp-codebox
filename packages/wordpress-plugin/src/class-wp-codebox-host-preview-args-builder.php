<?php
/**
 * Host-side preview CLI argument construction.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Preview_Args_Builder {

	/** @param array<string,mixed> $input Ability input. */
	public function build( array $input ): string|WP_Error {
		$options = WP_Codebox_Preview_Options::normalize( $input );
		if ( is_wp_error( $options ) ) {
			return $options;
		}

		$args   = $options['preview_hold_seconds'] > 0 ? ' --preview-hold-seconds ' . escapeshellarg( (string) $options['preview_hold_seconds'] ) : '';
		$port   = $options['preview_port'];
		$bind   = $options['preview_bind'];
		$public = $options['preview_public_url'];
		$lease  = $options['preview_lease'];

		if ( null !== $port ) {
			$args .= ' --preview-port ' . escapeshellarg( (string) $port );
		}
		if ( null !== $bind ) {
			$args .= ' --preview-bind ' . escapeshellarg( $bind );
		}
		if ( null !== $public ) {
			$args .= ' --preview-public-url ' . escapeshellarg( $public );
		}
		if ( null !== $lease ) {
			$args .= ' --preview-lease-json ' . escapeshellarg( wp_json_encode( $lease ) );
		}

		return $args;
	}
}
