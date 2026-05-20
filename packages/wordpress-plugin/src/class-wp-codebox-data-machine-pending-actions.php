<?php
/**
 * Optional Data Machine pending-action integration for artifact apply-back.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Data_Machine_Pending_Actions {

	public const KIND = 'wp_codebox_apply_back';

	public function __construct() {
		add_filter( 'datamachine_pending_action_handlers', array( self::class, 'register_handler' ) );
	}

	/** @param array<string,mixed> $handlers Current Data Machine pending-action handlers. */
	public static function register_handler( array $handlers ): array {
		$handlers[ self::KIND ] = array(
			'apply'       => array( self::class, 'apply' ),
			'can_resolve' => array( self::class, 'can_resolve' ),
		);

		return $handlers;
	}

	/**
	 * Stage an artifact apply request through Data Machine pending actions.
	 *
	 * @param array<string,mixed> $input Ability/helper input.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function stage_apply_artifact( array $input ): array|WP_Error {
		$bundle_result = ( new WP_Codebox_Artifacts() )->get( $input );
		if ( is_wp_error( $bundle_result ) ) {
			return $bundle_result;
		}

		$apply_input = self::apply_input( $input );
		if ( is_wp_error( $apply_input ) ) {
			return $apply_input;
		}

		$bundle  = is_array( $bundle_result['artifact'] ?? null ) ? $bundle_result['artifact'] : array();
		$summary = trim( (string) ( $input['summary'] ?? '' ) );
		if ( '' === $summary ) {
			$review_summary = is_array( $bundle['review'] ?? null ) ? trim( (string) ( $bundle['review']['summary'] ?? '' ) ) : '';
			$summary        = '' !== $review_summary ? $review_summary : 'Review and approve WP Codebox artifact apply-back.';
		}

		$stage_args = array(
			'kind'         => self::KIND,
			'summary'      => $summary,
			'apply_input'  => $apply_input,
			'preview_data' => self::preview_data( $bundle, $apply_input ),
			'agent_id'     => isset( $input['agent_id'] ) ? (int) $input['agent_id'] : 0,
			'user_id'      => isset( $input['user_id'] ) ? (int) $input['user_id'] : 0,
			'context'      => isset( $input['context'] ) && is_array( $input['context'] ) ? $input['context'] : array(),
		);

		$filtered = apply_filters( 'wp_codebox_stage_pending_apply_artifact', null, $stage_args, $bundle );
		if ( null !== $filtered ) {
			return $filtered;
		}

		if ( ! class_exists( '\\DataMachine\\Engine\\AI\\Actions\\PendingActionHelper' ) ) {
			return new WP_Error( 'wp_codebox_datamachine_pending_actions_missing', 'Data Machine pending actions are not available.', array( 'status' => 501 ) );
		}

		return \DataMachine\Engine\AI\Actions\PendingActionHelper::stage( $stage_args );
	}

	/** @param array<string,mixed> $apply_input Stored Data Machine apply input. */
	public static function apply( array $apply_input ): array|WP_Error {
		return ( new WP_Codebox_Artifacts() )->apply_approved( $apply_input );
	}

	/** @param array<string,mixed> $payload Stored Data Machine pending-action payload. */
	public static function can_resolve( array $payload, string $decision, int $user_id ): bool|WP_Error {
		$allowed = function_exists( 'current_user_can' ) ? current_user_can( 'manage_options' ) : true;

		return (bool) apply_filters( 'wp_codebox_can_resolve_pending_apply_artifact', $allowed, $payload, $decision, $user_id );
	}

	/**
	 * @param array<string,mixed> $input Ability/helper input.
	 * @return array<string,mixed>|WP_Error
	 */
	private static function apply_input( array $input ): array|WP_Error {
		$artifact_id = trim( (string) ( $input['artifact_id'] ?? '' ) );
		if ( '' === $artifact_id ) {
			return new WP_Error( 'wp_codebox_artifact_id_missing', 'artifact_id is required.', array( 'status' => 400 ) );
		}

		$approved_files = self::approved_files( $input );
		if ( empty( $approved_files ) ) {
			return new WP_Error( 'wp_codebox_approved_files_missing', 'approved_files must include at least one sandbox path.', array( 'status' => 400 ) );
		}

		$apply_input = array(
			'artifact_id'    => $artifact_id,
			'approved_files' => $approved_files,
		);

		foreach ( array( 'artifacts_path', 'approver', 'apply_target' ) as $key ) {
			if ( array_key_exists( $key, $input ) ) {
				$apply_input[ $key ] = $input[ $key ];
			}
		}

		return $apply_input;
	}

	/** @param array<string,mixed> $input Ability/helper input. @return string[] */
	private static function approved_files( array $input ): array {
		$files = is_array( $input['approved_files'] ?? null ) ? $input['approved_files'] : array();

		return array_values(
			array_unique(
				array_filter(
					array_map( static fn( $path ): string => trim( (string) $path ), $files ),
					static fn( string $path ): bool => '' !== $path
				)
			)
		);
	}

	/** @param array<string,mixed> $bundle Artifact bundle. @param array<string,mixed> $apply_input Stored apply input. */
	private static function preview_data( array $bundle, array $apply_input ): array {
		return array(
			'schema'         => 'wp-codebox/pending-apply-preview/v1',
			'artifact_id'    => (string) ( $bundle['id'] ?? $apply_input['artifact_id'] ?? '' ),
			'content_digest' => (string) ( $bundle['content_digest'] ?? '' ),
			'created_at'     => (string) ( $bundle['created_at'] ?? '' ),
			'approved_files' => $apply_input['approved_files'] ?? array(),
			'changed_files'  => is_array( $bundle['changed_files'] ?? null ) ? $bundle['changed_files'] : array(),
			'test_results'   => is_array( $bundle['test_results'] ?? null ) ? $bundle['test_results'] : array(),
			'review'         => is_array( $bundle['review'] ?? null ) ? $bundle['review'] : array(),
		);
	}
}
