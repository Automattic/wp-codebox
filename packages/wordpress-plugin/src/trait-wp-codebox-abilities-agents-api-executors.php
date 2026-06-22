<?php
/**
 * Internal task executor adapters for WP Codebox's Agents API facade.
 *
 * These adapters let the upstream task runtime call Codebox-owned execution
 * targets. Consumer-facing integrations should use the wp-codebox/* abilities
 * and schemas registered by WP_Codebox_Abilities instead of upstream names.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Agents_API_Executors {

	private function register_agents_api_executor_adapters(): void {
		WP_Codebox_Agents_API_Adapter::register_executor_adapters(
			array( self::class, 'register_agents_api_executor_targets' ),
			array( self::class, 'execute_agents_api_task' )
		);
	}

	/** @param mixed $targets Existing executor targets. @return array<int|string,mixed> */
	public static function register_agents_api_executor_targets( mixed $targets ): array {
		$targets = is_array( $targets ) ? $targets : array();
		foreach ( self::agents_api_executor_target_declarations() as $target ) {
			$targets[ (string) $target['id'] ] = $target;
		}

		return $targets;
	}

	/** @param mixed $pre Existing dispatch result. @param mixed $request Generic task request. @param mixed $target Target id or declaration. @return mixed */
	public static function execute_agents_api_task( mixed $pre, mixed $request, mixed $target = null ): mixed {
		if ( null !== $pre ) {
			return $pre;
		}

		$target_id = WP_Codebox_Agents_API_Adapter::executor_target_id( $target, $request );
		if ( ! in_array( $target_id, array( WP_Codebox_Agents_API_Adapter::browser_executor_target_id(), WP_Codebox_Agents_API_Adapter::host_executor_target_id() ), true ) ) {
			return $pre;
		}

		if ( ! is_array( $request ) ) {
			return new WP_Error( 'wp_codebox_agents_api_task_request_invalid', 'Agents API task requests must be objects.', array( 'status' => 400 ) );
		}

		$input = WP_Codebox_Agents_API_Adapter::task_request_input( $request );
		return WP_Codebox_Agents_API_Adapter::browser_executor_target_id() === $target_id
			? self::create_browser_task_contract( $input )
			: self::run_agent_task( $input );
	}

	/** @return array<int,array<string,mixed>> */
	private static function agents_api_executor_target_declarations(): array {
		return WP_Codebox_Agents_API_Adapter::executor_target_declarations(
			self::agents_api_task_input_schema(),
			self::browser_task_contract_schema()
		);
	}

	/** @return array<string,mixed> */
	private static function agents_api_task_input_schema(): array {
		return WP_Codebox_Agents_API_Adapter::task_input_schema( self::task_input_schema() );
	}
}
