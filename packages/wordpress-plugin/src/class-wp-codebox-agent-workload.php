<?php
/**
 * Public WP Codebox agent workload envelope.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Workload {

	public const SCHEMA = 'wp-codebox/agent-workload/v1';

	/** @return array<string,mixed> */
	public static function schema(): array {
		return array(
			'$id'        => self::SCHEMA,
			'type'       => 'object',
			'required'   => array( 'schema', 'task' ),
			'properties' => array(
				'schema'        => array(
					'type'        => 'string',
					'const'       => self::SCHEMA,
					'description' => 'Public WP Codebox agent workload envelope schema id.',
				),
				'agent_runtime' => array(
					'type'        => array( 'object', 'string' ),
					'description' => 'Codebox agent runtime selection. Use a string agent id, or an object with agent, mode, runtime_profile, runtime_packages, runtime_capabilities, and runtime_task.',
				),
				'task'          => array(
					'type'        => array( 'object', 'string' ),
					'description' => 'Task for the sandboxed agent. Use a string for the user-facing goal, or an object with goal, target, context, expected_artifacts, and structured_artifacts.',
				),
				'tools'         => array(
					'type'        => 'array',
					'description' => 'Codebox tool ids the sandboxed agent may use.',
					'items'       => array( 'type' => 'string' ),
				),
				'provider'      => array(
					'type'        => 'string',
					'description' => 'AI provider id to seed into the Codebox runtime.',
				),
				'model'         => array(
					'type'        => 'string',
					'description' => 'AI model id to seed into the Codebox runtime.',
				),
				'target'        => array(
					'type'        => 'object',
					'description' => 'Bounded target for the task, such as a repo, site, plugin, or theme.',
				),
				'artifacts'     => array(
					'type'        => 'array',
					'description' => 'Artifact kinds the caller wants back, such as patch, review, tests, preview, or package.',
					'items'       => array( 'type' => 'string' ),
				),
				'policy'        => array(
					'type'        => 'object',
					'description' => 'Caller policy hints for approvals, apply-back, sandboxing, and risk controls.',
				),
				'context'       => array(
					'type'        => 'object',
					'description' => 'Additional non-secret caller context for the sandboxed task.',
				),
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function normalize_ability_input( array $input ): array|WP_Error {
		$direct   = self::SCHEMA === (string) ( $input['schema'] ?? '' );
		$workload = self::public_workload( $input );
		if ( null === $workload ) {
			return $input;
		}

		$normalized = self::normalize( $workload );
		if ( is_wp_error( $normalized ) ) {
			return $normalized;
		}

		$passthrough = $input;
		unset( $passthrough['schema'], $passthrough['agent_workload'], $passthrough['agentWorkload'], $passthrough['workload'], $passthrough['agent_runtime'], $passthrough['agentRuntime'], $passthrough['task'], $passthrough['tools'], $passthrough['artifacts'] );
		if ( $direct ) {
			unset( $passthrough['provider'], $passthrough['model'], $passthrough['target'], $passthrough['policy'], $passthrough['context'] );
		}

		return array_merge( $normalized, $passthrough );
	}

	/** @param array<string,mixed> $workload Public workload. @return array<string,mixed>|WP_Error */
	public static function normalize( array $workload ): array|WP_Error {
		$task = $workload['task'] ?? null;
		$goal = is_array( $task )
			? trim( (string) ( $task['goal'] ?? $task['message'] ?? $task['prompt'] ?? '' ) )
			: trim( (string) $task );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_agent_workload_task_missing', 'agent workload task is required.', array( 'status' => 400 ) );
		}

		$agent_runtime = $workload['agent_runtime'] ?? $workload['agentRuntime'] ?? array();
		$runtime       = is_array( $agent_runtime ) ? $agent_runtime : array( 'agent' => $agent_runtime );
		$task_object   = is_array( $task ) ? $task : array();

		$normalized = array_filter(
			array(
				'goal'                 => $goal,
				'target'               => is_array( $task_object['target'] ?? null ) ? $task_object['target'] : ( is_array( $workload['target'] ?? null ) ? $workload['target'] : array() ),
				'allowed_tools'        => self::string_list( $workload['tools'] ?? $task_object['tools'] ?? $workload['allowed_tools'] ?? array() ),
				'expected_artifacts'   => self::string_list( $workload['artifacts'] ?? $task_object['artifacts'] ?? $task_object['expected_artifacts'] ?? array() ),
				'structured_artifacts' => is_array( $task_object['structured_artifacts'] ?? null ) ? $task_object['structured_artifacts'] : array(),
				'policy'               => is_array( $workload['policy'] ?? null ) ? $workload['policy'] : ( is_array( $task_object['policy'] ?? null ) ? $task_object['policy'] : array() ),
				'context'              => is_array( $workload['context'] ?? null ) ? $workload['context'] : ( is_array( $task_object['context'] ?? null ) ? $task_object['context'] : array() ),
				'agent'                => self::runtime_string( $runtime, 'agent' ),
				'mode'                 => self::runtime_string( $runtime, 'mode' ),
				'provider'             => trim( (string) ( $workload['provider'] ?? $runtime['provider'] ?? '' ) ),
				'model'                => trim( (string) ( $workload['model'] ?? $runtime['model'] ?? '' ) ),
				'runtime_profile'      => is_array( $runtime['runtime_profile'] ?? $runtime['runtimeProfile'] ?? null ) ? ( $runtime['runtime_profile'] ?? $runtime['runtimeProfile'] ) : array(),
				'runtime_packages'     => self::string_list( $runtime['runtime_packages'] ?? $runtime['runtimePackages'] ?? array() ),
				'runtime_capabilities' => self::string_list( $runtime['runtime_capabilities'] ?? $runtime['runtimeCapabilities'] ?? array() ),
				'runtime_task'         => is_array( $runtime['runtime_task'] ?? $runtime['runtimeTask'] ?? null ) ? ( $runtime['runtime_task'] ?? $runtime['runtimeTask'] ) : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);

		$normalized['context'] = array_merge(
			is_array( $normalized['context'] ?? null ) ? $normalized['context'] : array(),
			array( 'agent_workload' => array( 'schema' => self::SCHEMA ) )
		);

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|null */
	private static function public_workload( array $input ): ?array {
		if ( self::SCHEMA === (string) ( $input['schema'] ?? '' ) ) {
			return $input;
		}

		foreach ( array( 'agent_workload', 'agentWorkload', 'workload' ) as $field ) {
			if ( is_array( $input[ $field ] ?? null ) && self::SCHEMA === (string) ( $input[ $field ]['schema'] ?? '' ) ) {
				return $input[ $field ];
			}
		}

		return null;
	}

	/** @param array<string,mixed> $runtime Runtime object. */
	private static function runtime_string( array $runtime, string $field ): string {
		return trim( (string) ( $runtime[ $field ] ?? '' ) );
	}

	/** @return string[] */
	private static function string_list( mixed $values ): array {
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
