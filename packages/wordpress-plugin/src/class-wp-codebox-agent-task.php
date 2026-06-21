<?php
/**
 * Shared WP Codebox agent task helpers.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Task {

	public const INPUT_SCHEMA = WP_Codebox_Task_Input_Contract::SCHEMA;
	public const SESSION_SCHEMA = 'wp-codebox/sandbox-session/v1';

	/**
	 * Normalize the caller-facing task input used by host and browser transports.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @param callable|null       $allowed_tools_validator Optional validator for host-only tool policy.
	 * @param bool                $keep_empty Whether to keep empty optional fields for preparation payloads.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function normalize_input( array $input, ?callable $allowed_tools_validator = null, bool $keep_empty = false ): array|WP_Error {
		unset( $keep_empty );

		$input = WP_Codebox_Agent_Workload::normalize_ability_input( $input );
		if ( is_wp_error( $input ) ) {
			return $input;
		}

		$task_input = WP_Codebox_Task_Input_Contract::normalize( $input );
		if ( is_wp_error( $task_input ) ) {
			return $task_input;
		}

		if ( ! empty( $task_input['allowed_tools'] ) && null !== $allowed_tools_validator ) {
			$error = $allowed_tools_validator( $task_input['allowed_tools'], $task_input );
			if ( is_wp_error( $error ) ) {
				return $error;
			}
		}

		if ( ! empty( $task_input['allowed_tools'] ) ) {
			$normalizer = new WP_Codebox_Sandbox_Tool_Policy_Normalizer();
			$policy     = $normalizer->normalize_for_task_input( $task_input );
			if ( is_wp_error( $policy ) ) {
				return $policy;
			}
			$task_input['sandbox_tool_policy'] = $policy;
			if ( empty( $task_input['tool_bridge'] ) ) {
				$task_input['tool_bridge'] = $normalizer->tool_bridge_from_policy( $task_input['allowed_tools'], $policy, $task_input );
			}
		}

		return $task_input;
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	public static function prompt( array $task_input ): string {
		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $task_input, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $task_input, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		return is_string( $encoded ) ? $encoded : '';
	}

	/**
	 * Build the common sandbox session envelope emitted by host and browser paths.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @param array<string,mixed> $artifacts Artifact refs.
	 * @return array<string,mixed>
	 */
	public static function session( string $session_id, string $status, array $input, array $artifacts = array() ): array {
		$session = array(
			'schema'      => self::SESSION_SCHEMA,
			'id'          => $session_id,
			'status'      => $status,
			'persistence' => 'external-orchestrator',
		);

		if ( ! empty( $artifacts ) ) {
			$session['artifacts'] = $artifacts;
		}

		if ( ! empty( $input['session_id'] ) ) {
			$session['agent_session_id'] = (string) $input['session_id'];
		}

		if ( isset( $input['orchestrator'] ) && is_array( $input['orchestrator'] ) ) {
			$session['orchestrator'] = array_filter(
				array(
					'id'            => isset( $input['orchestrator']['id'] ) ? (string) $input['orchestrator']['id'] : '',
					'type'          => isset( $input['orchestrator']['type'] ) ? (string) $input['orchestrator']['type'] : '',
					'job_id'        => isset( $input['orchestrator']['job_id'] ) ? (string) $input['orchestrator']['job_id'] : '',
					'agent_task_id' => isset( $input['orchestrator']['agent_task_id'] ) ? (string) $input['orchestrator']['agent_task_id'] : '',
				),
				static fn( mixed $value ): bool => '' !== $value
			);
		}

		return $session;
	}

	/** @return string[] */
	public static function string_list( mixed $values ): array {
		if ( ! is_array( $values ) ) {
			return array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $value ): string => trim( (string) $value ),
						$values
					),
					static fn( string $value ): bool => '' !== $value
				)
			)
		);
	}
}
