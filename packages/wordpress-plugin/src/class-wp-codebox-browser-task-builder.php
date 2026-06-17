<?php
/**
 * Generic browser task input and payload builder.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Browser_Task_Builder {

	/**
	 * Builds canonical browser task contract input from product-neutral intent.
	 *
	 * Downstream products should describe what they want to accomplish here, then
	 * pass the returned input to wp-codebox/create-browser-task-contract.
	 *
	 * @param array<string,mixed> $spec Product-neutral browser task spec.
	 * @return array<string,mixed>|WP_Error
	 */
	public static function browser_task_input_from_intent( array $spec ): array|WP_Error {
		$intent = is_array( $spec['product_intent'] ?? null ) ? $spec['product_intent'] : ( is_array( $spec['intent'] ?? null ) ? $spec['intent'] : array() );
		$goal   = trim( (string) ( $intent['goal'] ?? $spec['goal'] ?? '' ) );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_browser_task_intent_missing', 'Browser task intent requires a goal.', array( 'status' => 400 ) );
		}

		$session_id = trim( (string) ( $spec['sandbox_session_id'] ?? $spec['session_id'] ?? $intent['session_id'] ?? '' ) );
		$product    = trim( (string) ( $intent['product'] ?? $spec['product'] ?? '' ) );
		$context    = self::merge_defaults(
			is_array( $spec['context'] ?? null ) ? $spec['context'] : array(),
			array_filter(
				array(
					'product'                => $product,
					'orchestrator'           => trim( (string) ( $intent['orchestrator'] ?? $spec['orchestrator']['id'] ?? '' ) ),
					'execution'              => trim( (string) ( $intent['execution'] ?? 'wp-codebox-browser-playground' ) ),
					'active_project_context' => is_array( $spec['active_project_context'] ?? null ) ? $spec['active_project_context'] : array(),
					'callback_refs'          => is_array( $spec['callback_refs'] ?? null ) ? $spec['callback_refs'] : array(),
				),
				static fn( mixed $value ): bool => '' !== $value && array() !== $value
			)
		);

		$allowed_tools       = self::string_list_any( $spec['desired_tools'] ?? $spec['tools'] ?? $spec['allowed_tools'] ?? array() );
		$tool_policy         = is_array( $spec['sandbox_tool_policy'] ?? null ) ? $spec['sandbox_tool_policy'] : ( new WP_Codebox_Sandbox_Tool_Policy_Normalizer() )->from_allowed_tools( $allowed_tools, $spec );
		$artifact_contract   = is_array( $spec['artifacts'] ?? null ) ? $spec['artifacts'] : array();
		$playground_defaults = self::playground_defaults_from_artifacts( $artifact_contract, $product );
		$browser_runner      = self::browser_runner_from_artifacts( $artifact_contract );

		$input = array_filter(
			array(
				'authorization'         => $spec['authorization'] ?? null,
				'placement'             => self::browser_execution_placement( self::string_list_lower( $spec['desired_capabilities'] ?? $spec['capabilities'] ?? array() ) ),
				'agent'                 => trim( (string) ( $spec['agent'] ?? $intent['agent'] ?? '' ) ),
				'mode'                  => trim( (string) ( $spec['mode'] ?? 'sandbox' ) ),
				'provider'              => trim( (string) ( $spec['provider'] ?? '' ) ),
				'model'                 => trim( (string) ( $spec['model'] ?? '' ) ),
				'agent_bundles'         => is_array( $spec['agent_bundles'] ?? null ) ? $spec['agent_bundles'] : array(),
				'provider_plugin_paths' => self::string_list_any( $spec['provider_plugin_paths'] ?? array() ),
				'inherit'               => is_array( $spec['inherit'] ?? null ) ? $spec['inherit'] : array(),
				'goal'                  => $goal,
				'sandbox_session_id'    => $session_id,
				'target'                => is_array( $spec['target'] ?? null ) ? $spec['target'] : self::target_from_intent( $intent, $session_id ),
				'allowed_tools'         => $allowed_tools,
				'expected_artifacts'    => self::string_list_any( $spec['expected_artifacts'] ?? $artifact_contract['expected'] ?? array() ),
				'structured_artifacts'  => is_array( $spec['structured_artifacts'] ?? null ) ? $spec['structured_artifacts'] : array(),
				'sandbox_tool_policy'   => $tool_policy,
				'policy'                => is_array( $spec['policy'] ?? null ) ? $spec['policy'] : array(),
				'context'               => $context,
				'orchestrator'          => is_array( $spec['orchestrator'] ?? null ) ? $spec['orchestrator'] : array_filter( array( 'id' => $context['orchestrator'] ?? '' ) ),
				'playground'            => self::merge_defaults( is_array( $spec['playground'] ?? null ) ? $spec['playground'] : array(), $playground_defaults ),
				'runtime'               => is_array( $spec['runtime'] ?? null ) ? $spec['runtime'] : array(),
				'browser_runner'        => self::merge_defaults( is_array( $spec['browser_runner'] ?? null ) ? $spec['browser_runner'] : array(), $browser_runner ),
				'artifact_files'        => is_array( $artifact_contract['files'] ?? null ) ? $artifact_contract['files'] : ( is_array( $spec['artifact_files'] ?? null ) ? $spec['artifact_files'] : array() ),
				'callback_refs'         => is_array( $spec['callback_refs'] ?? null ) ? $spec['callback_refs'] : array(),
				'phases'                => is_array( $spec['phases'] ?? null ) ? $spec['phases'] : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value && null !== $value
		);

		return self::local_browser_task_input( $input );
	}

	/** @param array<string,mixed> $worker @return array<string,mixed> */
	public static function fanout_worker( array $worker ): array {
		return array_filter(
			array(
				'schema'  => 'wp-codebox/agent-fanout-worker/v1',
				'id'      => self::safe_key( (string) ( $worker['id'] ?? $worker['role'] ?? '' ) ),
				'agent'   => trim( (string) ( $worker['agent'] ?? '' ) ),
				'goal'    => trim( (string) ( $worker['goal'] ?? '' ) ),
				'context' => is_array( $worker['context'] ?? null ) ? $worker['context'] : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	/** @param array<string,mixed> $request @return array<string,mixed> */
	public static function fanout_request( array $request ): array {
		$workers = array();
		foreach ( is_array( $request['workers'] ?? null ) ? $request['workers'] : array() as $worker ) {
			if ( is_array( $worker ) ) {
				$workers[] = self::fanout_worker( $worker );
			}
		}

		return array_filter(
			array(
				'schema'      => 'wp-codebox/agent-fanout-request/v1',
				'concurrency' => max( 1, (int) ( $request['concurrency'] ?? 1 ) ),
				'workers'     => $workers,
				'context'     => is_array( $request['context'] ?? null ) ? $request['context'] : array(),
				'orchestrator' => is_array( $request['orchestrator'] ?? null ) ? $request['orchestrator'] : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	/**
	 * Applies portable defaults for browser-local Playground tasks.
	 *
	 * Callers keep ownership of product-specific context, artifacts, and phases;
	 * this method only fills the generic execution placement, mode, target,
	 * playground scope, and browser runner defaults used by local browser tasks.
	 *
	 * @param array<string,mixed> $input    Caller task input.
	 * @param array<string,mixed> $defaults Optional caller defaults to apply before generic defaults.
	 * @return array<string,mixed>
	 */
	public static function local_browser_task_input( array $input, array $defaults = array() ): array {
		$session_id = trim( (string) ( $input['sandbox_session_id'] ?? $input['session_id'] ?? $defaults['sandbox_session_id'] ?? $defaults['session_id'] ?? '' ) );
		$scope      = trim( (string) ( $input['playground']['scope'] ?? $defaults['playground']['scope'] ?? $session_id ) );

		$generic_defaults = array(
			'mode'       => 'sandbox',
			'placement'  => self::browser_execution_placement(),
			'target'     => array_filter(
				array(
					'kind' => 'browser-playground',
					'ref'  => '' !== $session_id ? $session_id : $scope,
				),
				static fn( mixed $value ): bool => '' !== $value
			),
			'context'    => array(
				'execution' => 'wp-codebox-browser-playground',
			),
			'playground' => array_filter(
				array(
					'scope' => $scope,
				),
				static fn( mixed $value ): bool => '' !== $value
			),
			'browser_runner' => array(
				'task_path'   => '/tmp/wp-codebox-browser-task.json',
				'result_path' => '/tmp/wp-codebox-browser-result.json',
				'invocation'  => array(
					'type' => 'ability',
					'name' => 'agents/chat',
				),
			),
		);

		$merged    = self::merge_defaults( self::merge_defaults( $input, $defaults ), $generic_defaults );
		$placement = is_array( $merged['placement'] ?? null ) ? $merged['placement'] : $generic_defaults['placement'];
		$placement['required_capabilities'] = self::string_list_lower(
			array_merge(
				$generic_defaults['placement']['required_capabilities'],
				is_array( $defaults['placement']['required_capabilities'] ?? null ) ? $defaults['placement']['required_capabilities'] : array(),
				is_array( $input['placement']['required_capabilities'] ?? null ) ? $input['placement']['required_capabilities'] : array()
			)
		);
		$merged['placement'] = $placement;

		return $merged;
	}

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

	/** @param array<int,string> $required_capabilities Additional required browser capabilities. @return array<string,mixed> */
	public static function browser_execution_placement( array $required_capabilities = array() ): array {
		return array(
			'schema'                => 'agents-api/execution-placement/v1',
			'preferred_target'      => 'browser',
			'allowed_targets'       => array( 'browser' ),
			'resource_class'        => 'interactive',
			'required_capabilities' => self::string_list_lower( array_merge( array( 'wordpress.playground', 'browser.preview' ), $required_capabilities ) ),
		);
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
	 * @param array<string,callable> $resolvers Optional field resolvers for agent, mode, provider, model, secret_env, agent_bundles, and runtime_dependency_plan.
	 * @return array<string,mixed>
	 */
	public static function task_payload( array $input, array $task_input, string $session_id, array $artifacts, array $inheritance, array $resolvers = array() ): array {
		$resolve = static function ( string $name, mixed $fallback ) use ( $input, $task_input, $inheritance, $resolvers ): mixed {
			if ( isset( $resolvers[ $name ] ) && is_callable( $resolvers[ $name ] ) ) {
				return $resolvers[ $name ]( $input, $task_input, $inheritance );
			}

			return $fallback;
		};

		$dependency_plan = $resolve( 'runtime_dependency_plan', null );
		if ( ! $dependency_plan instanceof WP_Codebox_Runtime_Dependency_Plan ) {
			$dependency_plan = new WP_Codebox_Runtime_Dependency_Plan(
				array(
					'agent'    => self::agent_slug( $input ),
					'mode'     => self::mode( $input ),
					'provider' => self::provider( $input, $inheritance ),
					'model'    => self::model( $input, $inheritance ),
				),
				self::string_list( $input['provider_plugin_paths'] ?? array() ),
				array(),
				array(),
				self::array_resolver_value( $input['runtime_overlays'] ?? array() ),
				$inheritance,
				array( 'connectors' => array(), 'settings' => array() ),
				self::array_resolver_value( $task_input['agent_bundles'] ?? array() ),
				self::string_list( $input['secret_env'] ?? array() )
			);
		}

		return array_filter(
			array(
				'schema'        => 'wp-codebox/browser-agent-task-payload/v1',
				'agent'         => (string) $resolve( 'agent', (string) ( $dependency_plan->selection()['agent'] ?? self::agent_slug( $input ) ) ),
				'mode'          => (string) $resolve( 'mode', (string) ( $dependency_plan->selection()['mode'] ?? self::mode( $input ) ) ),
				'provider'      => (string) $resolve( 'provider', $dependency_plan->provider() ),
				'model'         => (string) $resolve( 'model', $dependency_plan->model() ),
				'message'       => (string) $task_input['goal'],
				'session_id'    => $session_id,
				'task_input'    => $task_input,
				'agent_bundles' => self::array_resolver_value( $resolve( 'agent_bundles', $dependency_plan->agent_bundles() ) ),
				'inheritance'   => $dependency_plan->inheritance(),
				'secret_env'    => self::string_list( $resolve( 'secret_env', $dependency_plan->secret_env_names() ) ),
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

	/** @param array<string,mixed> $intent */
	private static function target_from_intent( array $intent, string $session_id ): array {
		return array_filter(
			array(
				'kind' => trim( (string) ( $intent['target_kind'] ?? $intent['kind'] ?? 'browser-playground' ) ),
				'ref'  => trim( (string) ( $intent['target_ref'] ?? $intent['ref'] ?? $session_id ) ),
				'path' => trim( (string) ( $intent['target_path'] ?? $intent['path'] ?? '' ) ),
				'url'  => trim( (string) ( $intent['target_url'] ?? $intent['url'] ?? '' ) ),
			),
			static fn( string $value ): bool => '' !== $value
		);
	}

	/** @param array<string,mixed> $artifacts @return array<string,mixed> */
	private static function playground_defaults_from_artifacts( array $artifacts, string $product ): array {
		$base = trim( (string) ( $artifacts['base_path'] ?? $artifacts['artifact_base_path'] ?? '' ) );
		if ( '' === $base && '' !== $product ) {
			$base = '/wordpress/wp-content/uploads/' . self::safe_key( $product );
		}

		return array_filter(
			array(
				'artifact_base_path' => $base,
				'artifact_base_url'  => trim( (string) ( $artifacts['base_url'] ?? $artifacts['artifact_base_url'] ?? ( '' !== $product ? '/wp-content/uploads/' . self::safe_key( $product ) : '' ) ) ),
				'preview_url'        => trim( (string) ( $artifacts['preview_url'] ?? '' ) ),
			),
			static fn( string $value ): bool => '' !== $value
		);
	}

	/** @param array<string,mixed> $artifacts @return array<string,mixed> */
	private static function browser_runner_from_artifacts( array $artifacts ): array {
		return array_filter(
			array(
				'task_path'     => trim( (string) ( $artifacts['task_path'] ?? '' ) ),
				'result_path'   => trim( (string) ( $artifacts['result_path'] ?? '' ) ),
				'invocation'    => is_array( $artifacts['invocation'] ?? null ) ? $artifacts['invocation'] : array(),
				'capture_paths' => is_array( $artifacts['capture_paths'] ?? null ) ? $artifacts['capture_paths'] : array(),
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	private static function safe_key( string $value ): string {
		return trim( strtolower( preg_replace( '/[^a-zA-Z0-9_\-]+/', '-', $value ) ?? '' ), '-' );
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

	/** @return string[] */
	private static function string_list_any( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$items = array();
		foreach ( $value as $item ) {
			$item = trim( (string) $item );
			if ( '' !== $item && ! in_array( $item, $items, true ) ) {
				$items[] = $item;
			}
		}

		return $items;
	}

	/** @param array<string,mixed> $input Caller input. @param array<string,mixed> $defaults Defaults. @return array<string,mixed> */
	private static function merge_defaults( array $input, array $defaults ): array {
		foreach ( $defaults as $key => $value ) {
			if ( ! array_key_exists( $key, $input ) ) {
				$input[ $key ] = $value;
				continue;
			}

			if ( is_array( $input[ $key ] ) && is_array( $value ) && self::is_assoc( $input[ $key ] ) && self::is_assoc( $value ) ) {
				$input[ $key ] = self::merge_defaults( $input[ $key ], $value );
			}
		}

		return $input;
	}

	/** @param array<mixed> $value Value to inspect. */
	private static function is_assoc( array $value ): bool {
		return array_keys( $value ) !== range( 0, count( $value ) - 1 );
	}

	/** @param mixed $value Values to normalize. @return string[] */
	private static function string_list_lower( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$items = array();
		foreach ( $value as $item ) {
			$item = strtolower( trim( (string) $item ) );
			if ( '' !== $item && ! in_array( $item, $items, true ) ) {
				$items[] = $item;
			}
		}

		return $items;
	}
}
