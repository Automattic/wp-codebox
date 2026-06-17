<?php
/**
 * Generic browser task input and payload builder.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Browser_Task_Builder {

	/**
	 * Normalizes caller input into the canonical WP Codebox task input contract.
	 *
	 * @param array<string,mixed> $input Ability or caller input.
	 * @param callable|null       $allowed_tools_validator Optional validator: fn( array $tools, array $task_input ): WP_Error|null.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function normalize_task_input( array $input, ?callable $allowed_tools_validator = null ): array|WP_Error {
		return WP_Codebox_Agent_Task::normalize_input( $input, $allowed_tools_validator, true );
	}

	/**
	 * Builds the generic browser agent task payload sent into the sandbox.
	 *
	 * Product-specific task data remains in task_input.context, target, policy,
	 * and structured_artifacts. This method only owns the WP Codebox envelope.
	 *
	 * @param array<string,mixed> $input       Ability or caller input.
	 * @param array<string,mixed> $task_input  Normalized task input.
	 * @param string              $session_id  Browser sandbox session id.
	 * @param array<int,array<string,mixed>> $artifacts Browser artifact specs.
	 * @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance Resolved inheritance.
	 * @param array<string,callable> $resolvers Optional field resolvers for agent, mode, provider, model, secret_env, and agent_bundles.
	 * @return array<string,mixed>
	 */
	public static function task_payload( array $input, array $task_input, string $session_id, array $artifacts, array $inheritance, array $resolvers = array() ): array {
		$resolve = static function ( string $name, mixed $fallback ) use ( $input, $task_input, $inheritance, $resolvers ): mixed {
			if ( isset( $resolvers[ $name ] ) && is_callable( $resolvers[ $name ] ) ) {
				return $resolvers[ $name ]( $input, $task_input, $inheritance );
			}

			return $fallback;
		};

		return array_filter(
			array(
				'schema'        => 'wp-codebox/browser-agent-task-payload/v1',
				'agent'         => (string) $resolve( 'agent', self::agent_slug( $input ) ),
				'mode'          => (string) $resolve( 'mode', self::mode( $input ) ),
				'provider'      => (string) $resolve( 'provider', self::provider( $input, $inheritance ) ),
				'model'         => (string) $resolve( 'model', self::model( $input, $inheritance ) ),
				'message'       => (string) $task_input['goal'],
				'session_id'    => $session_id,
				'task_input'    => $task_input,
				'agent_bundles' => self::array_resolver_value( $resolve( 'agent_bundles', $task_input['agent_bundles'] ?? array() ) ),
				'inheritance'   => $inheritance,
				'secret_env'    => self::string_list( $resolve( 'secret_env', $input['secret_env'] ?? array() ) ),
				'artifacts'     => array(
					'schema' => 'wp-codebox/browser-artifacts/v1',
					'files'  => $artifacts,
				),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	/** @param array<string,mixed> $input Ability or caller input. */
	private static function agent_slug( array $input ): string {
		$agent = trim( (string) ( $input['agent'] ?? '' ) );
		return '' !== $agent ? $agent : 'wp-codebox-sandbox';
	}

	/** @param array<string,mixed> $input Ability or caller input. */
	private static function mode( array $input ): string {
		$mode = trim( (string) ( $input['mode'] ?? '' ) );
		return '' !== $mode ? $mode : 'sandbox';
	}

	/** @param array<string,mixed> $input Ability or caller input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
	private static function provider( array $input, array $inheritance ): string {
		$provider = trim( (string) ( $input['provider'] ?? '' ) );
		if ( '' !== $provider ) {
			return $provider;
		}

		foreach ( is_array( $inheritance['connectors'] ?? null ) ? $inheritance['connectors'] : array() as $connector ) {
			$provider = trim( (string) ( $connector['provider'] ?? '' ) );
			if ( '' !== $provider ) {
				return $provider;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $input Ability or caller input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
	private static function model( array $input, array $inheritance ): string {
		$model = trim( (string) ( $input['model'] ?? '' ) );
		if ( '' !== $model ) {
			return $model;
		}

		foreach ( is_array( $inheritance['connectors'] ?? null ) ? $inheritance['connectors'] : array() as $connector ) {
			$model = trim( (string) ( $connector['model'] ?? '' ) );
			if ( '' !== $model ) {
				return $model;
			}
		}

		return '';
	}

	/** @return array<int,mixed> */
	private static function array_resolver_value( mixed $value ): array {
		return is_array( $value ) ? $value : array();
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$items = array();
		foreach ( $value as $item ) {
			$item = trim( (string) $item );
			if ( '' !== $item && 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $item ) && ! in_array( $item, $items, true ) ) {
				$items[] = $item;
			}
		}

		return $items;
	}
}
