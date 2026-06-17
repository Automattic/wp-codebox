<?php
/**
 * Status vocabulary bridges for host-side response contracts.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Status_Taxonomy {

	/**
	 * @param array<string,mixed> $input Status conversion input.
	 */
	public static function command_envelope_status( array $input ): string {
		$status = self::status_string( $input['status'] ?? '' );
		if ( in_array( $status, array( 'completed', 'failed', 'timed_out', 'cancelled', 'running', 'queued' ), true ) ) {
			return $status;
		}
		if ( in_array( $status, array( 'succeeded', 'no_op', 'passed' ), true ) ) {
			return 'completed';
		}
		if ( 'timeout' === $status ) {
			return 'timed_out';
		}
		if ( in_array( $status, array( 'provider_error', 'unable_to_remediate', 'blocked' ), true ) ) {
			return 'failed';
		}
		if ( '' !== $status ) {
			return $status;
		}

		return true === ( $input['success'] ?? false ) && 0 === (int) ( $input['exit_status'] ?? 0 ) ? 'completed' : 'failed';
	}

	/**
	 * @param array<string,mixed> $input Status conversion input.
	 */
	public static function phase_recipe_status( array $input ): string {
		$status = self::status_string( $input['status'] ?? '' );
		if ( in_array( $status, array( 'succeeded', 'failed', 'partial', 'blocked', 'skipped', 'running' ), true ) ) {
			return $status;
		}
		if ( in_array( $status, array( 'completed', 'passed', 'no_op' ), true ) ) {
			return 'succeeded';
		}
		if ( in_array( $status, array( 'timeout', 'provider_error', 'unable_to_remediate', 'timed_out' ), true ) ) {
			return 'failed';
		}
		if ( '' !== $status ) {
			return $status;
		}

		return true === ( $input['success'] ?? false ) && 0 === (int) ( $input['exit_status'] ?? 0 ) ? 'succeeded' : 'failed';
	}

	/**
	 * @param array<string,mixed> $input Status conversion input.
	 */
	public static function agent_task_status( array $input ): string {
		$status = self::status_string( $input['status'] ?? '' );
		if ( in_array( $status, array( 'succeeded', 'failed', 'no_op', 'timeout', 'provider_error', 'unable_to_remediate' ), true ) ) {
			return $status;
		}
		if ( in_array( $status, array( 'completed', 'passed' ), true ) ) {
			return false === ( $input['success'] ?? true ) || 0 !== (int) ( $input['exit_status'] ?? 0 ) ? 'failed' : 'succeeded';
		}
		if ( 'timed_out' === $status ) {
			return 'timeout';
		}
		if ( 'blocked' === $status ) {
			return 'unable_to_remediate';
		}
		if ( true === ( $input['no_op'] ?? false ) ) {
			return 'no_op';
		}
		if ( true === ( $input['unable_to_remediate'] ?? false ) ) {
			return 'unable_to_remediate';
		}
		if ( true === ( $input['timeout'] ?? false ) ) {
			return 'timeout';
		}
		if ( ! empty( $input['provider_error'] ) ) {
			return 'provider_error';
		}

		return true === ( $input['success'] ?? false ) && 0 === (int) ( $input['exit_status'] ?? 0 ) ? 'succeeded' : 'failed';
	}

	/**
	 * @param array<string,mixed> $input Status conversion input.
	 */
	public static function check_status( array $input ): string {
		$status = self::status_string( $input['status'] ?? '' );
		if ( in_array( $status, array( 'passed', 'failed', 'warning', 'skipped', 'unknown' ), true ) ) {
			return $status;
		}
		if ( in_array( $status, array( 'succeeded', 'completed', 'no_op' ), true ) ) {
			return 'passed';
		}
		if ( in_array( $status, array( 'partial', 'blocked' ), true ) ) {
			return 'warning';
		}
		if ( in_array( $status, array( 'timeout', 'provider_error', 'unable_to_remediate', 'timed_out' ), true ) ) {
			return 'failed';
		}
		if ( '' !== $status ) {
			return $status;
		}

		return true === ( $input['success'] ?? false ) && 0 === (int) ( $input['exit_status'] ?? 0 ) ? 'passed' : 'failed';
	}

	private static function status_string( mixed $status ): string {
		return is_string( $status ) ? trim( $status ) : '';
	}
}
